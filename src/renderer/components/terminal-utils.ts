import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { shortcutManager } from '../shortcuts.js';
import { isWin } from '../platform.js';
import { appState } from '../state.js';
import type { ClipboardSource } from '../../shared/types.js';
import { FILE_PATH_DRAG_TYPE, NATIVE_FILES_DRAG_TYPE } from '../drag-types.js';
import { showAlertBanner } from './alert-banner.js';

type ExtraKeyHandler = (e: KeyboardEvent) => boolean | undefined;

// Renderer gate for the P0 paste-bench timing probes. The renderer is a
// sandboxed Browser World with no process.env, so the preload/devtools
// injection point is the global flag; the process.env form keeps the same
// gate usable under vitest's node env.
function clipboardTimingOn(): boolean {
  const g = globalThis as { __FINEVIBE_CLIPBOARD_TIMING__?: boolean; process?: { env?: Record<string, string | undefined> } };
  return g.__FINEVIBE_CLIPBOARD_TIMING__ === true || g.process?.env?.FINEVIBE_CLIPBOARD_TIMING === '1';
}

// Wraps text in bracketed-paste escapes when the shell has the mode enabled,
// so it's delivered as a paste rather than character-by-character input.
export function wrapBracketedPaste(terminal: Terminal, text: string): string {
  // SAFETY: xterm keeps the live mode flags on `modes` at runtime; only the
  // public Terminal type omits the field.
  const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } }).modes;
  return modes?.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
}

// The byte a terminal receives for Ctrl+V (⌘V delivered as Ctrl+V): DC1.
const CTRL_V = '\x16';

/**
 * Quote a filesystem path for the shell owning the PTY. Unquoted paths with
 * spaces reached the prompt as separate arguments — dropping `My File.pdf`
 * typed two tokens every provider reads as two missing files.
 * POSIX: single quotes, embedded `'` escaped as '\''; single quotes have no
 * toggle, so an embedded `"` rides through safely — the branch is sound.
 * Windows: double quotes, trailing `\` before the closing quote doubled so it
 * cannot swallow it. A path containing `"` is refused (null): cmd.exe toggles
 * its quoted state on every `"` and honours no escape for it, so `\"` CLOSES
 * the quoted region and leaves everything after it live — the old escape made
 * `x"y & calc.exe` arm `& calc.exe` on the command line. The spawn path
 * rejects quote-bearing arguments outright for the same reason
 * (main/pty-manager.ts, quoteArgForCmdExe); this quoter refuses the shape the
 * spawn path rejects (P1-20).
 */
export function quoteShellPath(p: string): string | null {
  if (p === '') return "''";
  if (!/[\s"'\\`$!*[\]?{}()&#|;<>=^~]/.test(p)) return p;
  if (isWin) {
    if (p.includes('"')) return null;
    let s = p;
    if (/\\$/.test(s)) s += '\\';
    return `"${s}"`;
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a whole path list for one PTY write, splitting off what the shell
 * cannot carry: a refused path never reaches the prompt.
 */
function quotePathsForPty(paths: string[]): { text: string; refused: string[] } {
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const p of paths) {
    const quoted = quoteShellPath(p);
    if (quoted === null) refused.push(p);
    else accepted.push(quoted);
  }
  return { text: accepted.join(' '), refused };
}

// The drop/paste twin of the spawn path's rejection (P1-20): a path cmd.exe
// cannot carry is refused, not injected. Surfaced the way live panes surface
// every other refusal — the pane alert banner.
// P4: the 8 Mi character text bound is a real content cut — the pane says
// so, the way it surfaces every other paste-path refusal (8 Mi = the plan's
// ~8 MiB, counted in UTF-16 characters).
function showTextTruncationNotice(): void {
  showAlertBanner({
    className: 'insight-alert-info',
    icon: '\u26A0',
    message:
      'Clipboard text is larger than the 8 Mi paste limit: only the first 8 Mi characters were sent.',
  });
}
function showQuoteRejection(paths: string[]): void {
  showAlertBanner({
    className: 'insight-alert-info',
    icon: '\u26A0',
    message:
      'Cannot pass a path containing a double quote through the Windows shell: ' +
      'cmd.exe has no escape for a literal quote. Refused: ' +
      paths.map((p) => `"${p}"`).join(', '),
  });
}

/**
 * Paths a drag carried: an internal file-tree drag holds the path outright, a
 * native OS drag (Explorer/Finder) exposes File objects whose real path the
 * preload resolves. Providers take attachments as paths, so the pane injects the
 * joined paths as if the user had typed them.
 */
function collectDroppedPaths(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  const internal = dt.getData(FILE_PATH_DRAG_TYPE);
  if (internal) return [internal];
  const paths: string[] = [];
  for (const file of dt.files) {
    const path = window.finevibe.fs.getDroppedFilePath(file);
    if (path) paths.push(path);
  }
  return paths;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Paths for pasted files. A file copied from Explorer/Finder already has a
 * filesystem path; a screenshot is an in-memory blob with none, so its bytes go to
 * main and come back as a temp path. Either way the PTY receives path text — the
 * same string a drop injects, and the only attachment shape all six providers read.
 */
async function pathsForPastedFiles(files: File[]): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    const realPath = window.finevibe.fs.getDroppedFilePath(file);
    if (realPath) {
      paths.push(realPath);
      continue;
    }
    if (!file.type.startsWith('image/')) continue;
    const saved = await window.finevibe.clipboard.saveImage(await readAsDataUrl(file));
    if (saved) paths.push(saved);
  }
  return paths;
}

export type PasteOutcome = 'files' | 'text' | 'passthrough' | 'empty';

/**
 * Paste into a running terminal, for every flavor the clipboard carries.
 *
 * - Files — a native paste event's file objects (screenshots, copied pictures,
 *   Explorer/Finder file copies) and main's file list (browser, macOS and Linux
 *   copies) — become path text, mirroring the drop handler so every provider
 *   takes them as attachments.
 * - Text is sent wrapped in bracketed paste; a rich-text copy with no plain text
 *   sends its markup source.
 * - A flavor neither side translates forwards a literal Ctrl+V so the CLI runs its
 *   own clipboard handling — in a plain terminal it would receive the keystroke;
 *   an empty clipboard sends nothing.
 *
 * `data` is a native paste event's DataTransfer — the paste route on all
 * three platforms since P1 (Windows Ctrl+V included). There, text is left to
 * xterm, which writes the clipboard string itself: only files need
 * intervention, and an event that carries nothing usable falls through to
 * main's read — the per-platform fallback for file lists Chromium does not
 * forward. Without `data` the read is the only source (context-menu Paste).
 */
export async function pasteIntoTerminal(
  terminal: Terminal,
  writeToPty: (data: string) => void,
  data?: DataTransfer | null
): Promise<PasteOutcome> {
  // Paste-request t0 for the renderer [paste-timing] stamps; 0 means off.
  const t0 = clipboardTimingOn() ? performance.now() : 0;
  if (data && data.files.length > 0) {
    const paths = await pathsForPastedFiles(Array.from(data.files));
    if (paths.length > 0) {
      const { text, refused } = quotePathsForPty(paths);
      if (refused.length > 0) showQuoteRejection(refused);
      if (text !== '') {
        writeToPty(wrapBracketedPaste(terminal, text + ' '));
        if (t0) console.log(`[paste-timing] renderer paste-event files +${(performance.now() - t0).toFixed(1)} ms`);
      }
      return 'files';
    }
  }
  if (data) {
    // Plain text is xterm's own paste path: it writes the clipboard string itself,
    // so writing here would double it. A markup-only copy has nothing for that
    // pipeline, and its source is the content a CLI can read.
    if (data.getData('text/plain').trim() !== '') return 'text';
    const html = data.getData('text/html').trim();
    if (html !== '') {
      writeToPty(wrapBracketedPaste(terminal, html));
      if (t0) console.log(`[paste-timing] renderer paste-event html +${(performance.now() - t0).toFixed(1)} ms`);
      return 'text';
    }
    // P1 fallback (docs/ui-conventions.md): the event carries no text, no
    // markup, and no file whose path resolves — exactly the shape of a copy
    // the paste event provably cannot serve: a Windows CF_HDROP-only copy, a
    // macOS NSFilenamesPboardType-only Finder copy, a Linux file-manager
    // copy whose `text/uri-list` Chromium does not hand over as `File`s.
    // Main's read below is the documented fallback for these, per platform.
  }

  const payload = await window.finevibe.clipboard.readForPaste();
  if (payload.textTruncated) showTextTruncationNotice();
  if (t0) console.log(`[paste-timing] renderer readForPaste +${(performance.now() - t0).toFixed(1)} ms (since paste request)`);
  // Wrapped so every main-read send stamps itself; the off path keeps the
  // original writeToPty reference.
  let outSub: { dispose(): void } | null = null;
  const send = t0
    ? (d: string) => {
        writeToPty(d);
        console.log(`[paste-timing] renderer pty:write sent +${(performance.now() - t0).toFixed(1)} ms`);
        if (!outSub && terminal.onWriteParsed) {
          const sub = terminal.onWriteParsed(() => {
            console.log(`[paste-timing] renderer first pty output +${(performance.now() - t0).toFixed(1)} ms`);
            sub.dispose();
          });
          outSub = sub;
        }
      }
    : writeToPty;
  const counts = () => {
    if (t0) console.log('[paste-timing] counts clipboardRead=1 clipboardWrite=0');
  };
  const paths = payload.imagePath ? [...payload.files, payload.imagePath] : payload.files;
  // Files first, exactly as the native paste-event path above does: a file
  // manager copy leaves the file NAME as the clipboard's plain text (Explorer
  // sets FileName, Finder the display name), and that echo is a by-product —
  // the file list is the content. Preferring the text pasted `report.pdf`
  // where the same copy through a native paste event pasted its path.
  if (paths.length > 0) {
    const { text, refused } = quotePathsForPty(paths);
    if (refused.length > 0) showQuoteRejection(refused);
    if (text !== '') send(wrapBracketedPaste(terminal, text + ' '));
    counts();
    return 'files';
  }
  const text = payload.text.trim() !== '' ? payload.text : payload.html.trim();
  if (text !== '') {
    send(wrapBracketedPaste(terminal, text));
    counts();
    return 'text';
  }
  if (payload.hasContent) {
    send(CTRL_V);
    counts();
    return 'passthrough';
  }
  // A native paste event fired, so Chromium saw pasteable content; an empty
  // main-side read means flavors the app cannot enumerate — Wayland portal
  // permissions empty the readable set. The contract's answer is the CLI's
  // own paste, never a silent no-op.
  if (data) {
    send(CTRL_V);
    counts();
    return 'passthrough';
  }
  counts();
  return 'empty';
}

/**
 * Call after the terminal's element exists. Attachments pasted with ⌘V / Ctrl+V /
 * Ctrl+Shift+V — on Windows the Ctrl+V keystroke reaches this event too since
 * P1, so one handler serves all three platforms: xterm's own paste listener
 * lives on the textarea, moves text only, and consumes the keystroke, so a
 * pasted screenshot, a copied file and a markup-only copy all reach nothing.
 * Capture phase on the pane element sees the event first; a plain-text paste
 * is left to xterm, which writes it itself.
 */
export function attachImagePasteHandler(
  terminal: Terminal,
  element: HTMLElement,
  writeToPty: (data: string) => void
): void {
  element.addEventListener('paste', (e: ClipboardEvent) => {
    const data = e.clipboardData;
    if (!data) return;
    if (data.files.length === 0 && data.getData('text/plain').trim() !== '') return;
    e.preventDefault();
    void pasteIntoTerminal(terminal, writeToPty, data).catch(() => {});
  }, true);
}

/**
 * Call after the terminal's element exists. Dropping a file on a terminal types
 * its path into the PTY — the attachment shape every provider reads. `isReady`
 * keeps a dead PTY from accepting a drop (a session pane: spawned, not exited).
 */
export function attachFileDropHandler(
  terminal: Terminal,
  element: HTMLElement,
  writeToPty: (data: string) => void,
  isReady: () => boolean
): void {
  element.addEventListener('dragover', (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const types = e.dataTransfer.types;
    if (!types.includes(FILE_PATH_DRAG_TYPE) && !types.includes(NATIVE_FILES_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    element.classList.add('drag-over');
  });
  element.addEventListener('dragleave', (e: DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !element.contains(next)) {
      element.classList.remove('drag-over');
    }
  });
  element.addEventListener('drop', (e: DragEvent) => {
    element.classList.remove('drag-over');
    const paths = collectDroppedPaths(e.dataTransfer);
    if (paths.length === 0) return;
    e.preventDefault();
    if (!isReady()) return;
    const { text, refused } = quotePathsForPty(paths);
    if (refused.length > 0) showQuoteRejection(refused);
    if (text === '') return;
    writeToPty(wrapBracketedPaste(terminal, text + ' '));
    terminal.focus();
  });
}

// Every terminal copy goes through the main process rather than
// navigator.clipboard, so exactly one plain-text flavor reaches the OS clipboard
// (#160). `source` is the caller's intent, not a mechanism: the main process
// decides what a selection-driven copy means per platform (Linux PRIMARY).
//
// P3: the write is fire-and-forget (`ipcRenderer.send` — no promise round
// trip cloning the whole selection string), a (text, source) pair that is
// byte-identical to the last one written is skipped, and a selection-driven
// copy past the ~256 Ki budget is deferred: a select-all of the scrollback
// must not serialize a multi-MB string on the renderer thread behind the
// user's next keystroke. The pair — not the text alone — is what the
// unchanged-skip compares: on Linux an explicit copy never sets PRIMARY, so
// a later selection-driven copy of the same string MUST still reach main,
// or middle-click paste loses the selection. Explicit copies are always
// sent: an invoked copy (Ctrl+C / Ctrl+Shift+C / menu) is never dropped.
const SELECTION_COPY_BUDGET_CHARS = 256 * 1024;
let lastCopied: { text: string; source: ClipboardSource } | null = null;

/** @internal Test-only: reset the unchanged-skip state (module singleton). */
export function _resetClipboardCopyStateForTesting(): void {
  lastCopied = null;
}

export function copyText(text: string, source: ClipboardSource = 'explicit'): void {
  if (!text) return;
  const t0 = clipboardTimingOn() ? performance.now() : 0;
  if (source === 'selection' && text.length > SELECTION_COPY_BUDGET_CHARS) {
    if (t0) console.log(`[copy-timing] renderer clipboard write deferred past ${SELECTION_COPY_BUDGET_CHARS}-char budget (source=selection) counts clipboardWrite=0`);
    return;
  }
  if (lastCopied !== null && lastCopied.text === text && lastCopied.source === source) {
    if (t0) console.log(`[copy-timing] renderer clipboard write skipped unchanged (source=${source}) counts clipboardWrite=0`);
    return;
  }
  lastCopied = { text, source };
  try {
    window.finevibe.clipboard.write(text, source);
    if (t0) console.log(`[copy-timing] renderer clipboard write sent +${(performance.now() - t0).toFixed(1)} ms (source=${source}) counts clipboardWrite=1`);
  } catch (err) {
    console.warn('clipboard write failed', err);
  }
}

export function copySelection(terminal: Terminal, source?: ClipboardSource): void {
  copyText(terminal.getSelection(), source);
}

// Call after terminal.open(); the selection service doesn't fire before then.
export function attachCopyOnSelect(terminal: Terminal): void {
  terminal.onSelectionChange(() => {
    if (clipboardTimingOn()) console.log('[copy-timing] renderer selection-change fired');
    if (!appState.preferences.copyOnSelect) return;
    copySelection(terminal, 'selection');
  });
}

/**
 * Call after terminal.open(). xterm's right-click handler parks the selection in
 * its hidden textarea and DOM-selects it so a native context-menu Copy can pick
 * it up, which leaves anything that later serializes that textarea free to write
 * the rich flavors that corrupt non-Latin text (#160).
 *
 * Collapse the selection rather than wiping the value: with nothing selected
 * Blink reports the copy command unavailable, and the contents stay intact for
 * xterm's IME CompositionHelper, which reads `textarea.value` back in a deferred
 * callback — clearing it would silently drop a CJK or Cyrillic candidate mid
 * composition, hitting exactly the users this fixes.
 */
export function collapseArmedTextareaOnContextMenu(terminal: Terminal): void {
  // xterm's own handler is on this element, so ours runs after the arming.
  terminal.element?.addEventListener('contextmenu', () => {
    terminal.textarea?.setSelectionRange(0, 0);
  });
}

/**
 * Attaches shared key event handling to a terminal:
 * - Cmd/Ctrl+F: bubbles up to document (prevents xterm from consuming it)
 * - Ctrl+Shift+C: copies selected text to clipboard
 * - Windows Ctrl+C: copies if selection exists, otherwise passes through as SIGINT
 * - Windows Ctrl+V: returns false WITHOUT preventDefault (P1) so Chromium's
 *   native paste event fires — xterm must not write the literal DC1, the
 *   paste event (attachImagePasteHandler + xterm's own paste) serves it.
 * - App accelerators: runs the shortcut dispatcher so a consumed key never
 *   reaches the PTY, while a handler that declines in the current context
 *   (Ctrl+L in a CLI terminal, Ctrl+R outside a browser tab) leaves the key
 *   to xterm as ordinary input.
 *
 * Pass an optional `extend` handler for terminal-specific key behavior.
 * Return false to suppress the key, undefined to fall through to default.
 */
export function attachClipboardCopyHandler(
  terminal: Terminal,
  extend?: ExtraKeyHandler
): void {
  terminal.attachCustomKeyEventHandler((e) => {
    // Cmd/Ctrl+F: bubble to document for search
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') return false;

    // Ctrl+Shift+C: copy selected text (all platforms)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'C') {
      if (e.type === 'keydown') copySelection(terminal);
      return false;
    }

    // Windows: Ctrl+C with selection → copy; without selection → SIGINT
    if (isWin && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'c') {
      // hasSelection() is a coordinate compare; getSelection() rebuilds the whole
      // string from the buffer, and this handler fires on keyup too.
      if (!terminal.hasSelection()) return true; // let xterm send \x03
      if (e.type === 'keydown') copySelection(terminal);
      return false;
    }

    // Windows: Ctrl+V → the native paste event (P1). Returning false keeps
    // xterm from writing the literal DC1 to the PTY; NOT calling
    // preventDefault lets Chromium fire the paste event, so
    // attachImagePasteHandler and xterm's paste pipeline serve the keystroke
    // — the path macOS/Linux already used. Main's clipboard read survives as
    // pasteIntoTerminal's fallback (CF_HDROP-only copies, the context menu).
    if (isWin && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'v') return false;

    // App accelerators: run the dispatcher here (keydown only) so its
    // verdict decides xterm. A handler that acted consumed the key — the PTY
    // must not also get the bytes. A handler that declined (context guard)
    // leaves the event un-prevented, so xterm writes it to the PTY: readline
    // clear-screen and reverse-search work in Claude Code/Codex/Gemini/Pi
    // TUIs. keyup has no handler to run; suppress it for every registered
    // accelerator, as before.
    if (e.type === 'keydown' ? shortcutManager.matchEvent(e) : shortcutManager.matchesAnyShortcut(e)) return false;

    return extend?.(e) ?? true;
  });
}

// Disposing the addon on context loss lets xterm.js fall back to the DOM renderer
// instead of keeping a dead GPU texture atlas (black-box glyphs).
export function loadWebglWithFallback(terminal: Terminal): void {
  try {
    const addon = new WebglAddon();
    terminal.loadAddon(addon);
    addon.onContextLoss(() => addon.dispose());
  } catch { /* no WebGL context: the DOM renderer stays in use */ }
}
