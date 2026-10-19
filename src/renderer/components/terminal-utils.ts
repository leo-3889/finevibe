import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { shortcutManager } from '../shortcuts.js';
import { isWin } from '../platform.js';
import { appState } from '../state.js';
import type { ClipboardSource } from '../../shared/types.js';
import { FILE_PATH_DRAG_TYPE, NATIVE_FILES_DRAG_TYPE } from '../drag-types.js';

type ExtraKeyHandler = (e: KeyboardEvent) => boolean | undefined;

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
 * POSIX: single quotes, embedded `'` escaped as '\''.
 * Windows: double quotes; `\"` is the cmd convention (and accepted by
 * PowerShell-adjacent shells), trailing `\` before the closing quote
 * doubled so it cannot swallow it.
 */
export function quoteShellPath(p: string): string {
  if (p === '') return "''";
  if (!/[\s"'\\`$!*[\]?{}()&#|;<>=^~]/.test(p)) return p;
  if (isWin) {
    let s = p.replace(/"/g, '\\"');
    if (/\\$/.test(s)) s += '\\';
    return `"${s}"`;
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
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
    const path = window.vibeyard.fs.getDroppedFilePath(file);
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
    const realPath = window.vibeyard.fs.getDroppedFilePath(file);
    if (realPath) {
      paths.push(realPath);
      continue;
    }
    if (!file.type.startsWith('image/')) continue;
    const saved = await window.vibeyard.clipboard.saveImage(await readAsDataUrl(file));
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
 * `data` is a native paste event's DataTransfer. There, text is left to xterm,
 * which writes the clipboard string itself: only files need intervention. Without
 * `data` the renderer intercepted the keystroke (Windows Ctrl+V, the context menu)
 * and main's clipboard read is the only source.
 */
export async function pasteIntoTerminal(
  terminal: Terminal,
  writeToPty: (data: string) => void,
  data?: DataTransfer | null
): Promise<PasteOutcome> {
  if (data && data.files.length > 0) {
    const paths = await pathsForPastedFiles(Array.from(data.files));
    if (paths.length > 0) {
      writeToPty(wrapBracketedPaste(terminal, paths.map(quoteShellPath).join(' ') + ' '));
      return 'files';
    }
  }
  if (data) {
    // Plain text is xterm's own paste path: it writes the clipboard string itself,
    // so writing here would double it. A markup-only copy has nothing for that
    // pipeline, and its source is the content a CLI can read.
    if (data.getData('text/plain').trim() !== '') return 'text';
    const html = data.getData('text/html').trim();
    if (html === '') return 'empty';
    writeToPty(wrapBracketedPaste(terminal, html));
    return 'text';
  }

  const payload = await window.vibeyard.clipboard.readForPaste();
  const paths = payload.imagePath ? [...payload.files, payload.imagePath] : payload.files;
  // Files first, exactly as the native paste-event path above does: a file
  // manager copy leaves the file NAME as the clipboard's plain text (Explorer
  // sets FileName, Finder the display name), and that echo is a by-product —
  // the file list is the content. Preferring the text pasted `report.pdf`
  // where the same copy through a native paste event pasted its path.
  if (paths.length > 0) {
    writeToPty(wrapBracketedPaste(terminal, paths.map(quoteShellPath).join(' ') + ' '));
    return 'files';
  }
  const text = payload.text.trim() !== '' ? payload.text : payload.html.trim();
  if (text !== '') {
    writeToPty(wrapBracketedPaste(terminal, text));
    return 'text';
  }
  if (payload.hasContent) {
    writeToPty(CTRL_V);
    return 'passthrough';
  }
  return 'empty';
}

/**
 * Call after the terminal's element exists. Attachments pasted with ⌘V / Ctrl+V /
 * Ctrl+Shift+V: xterm's own paste listener lives on the textarea, moves text only,
 * and consumes the keystroke, so a pasted screenshot, a copied file and a
 * markup-only copy all reach nothing. Capture phase on the pane element sees the
 * event first; a plain-text paste is left to xterm, which writes it itself.
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
    writeToPty(wrapBracketedPaste(terminal, paths.map(quoteShellPath).join(' ') + ' '));
    terminal.focus();
  });
}

// Every terminal copy goes through the main process rather than
// navigator.clipboard, so exactly one plain-text flavor reaches the OS clipboard
// (#160). `source` is the caller's intent, not a mechanism: the main process
// decides what a selection-driven copy means per platform.
export function copyText(text: string, source: ClipboardSource = 'explicit'): void {
  if (!text) return;
  window.vibeyard.clipboard.write(text, source)
    .catch((err) => console.warn('clipboard write failed', err));
}

export function copySelection(terminal: Terminal, source?: ClipboardSource): void {
  copyText(terminal.getSelection(), source);
}

// Call after terminal.open(); the selection service doesn't fire before then.
export function attachCopyOnSelect(terminal: Terminal): void {
  terminal.onSelectionChange(() => {
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
 * - Windows Ctrl+V: pastes clipboard content to PTY, attachments included (requires writeToPty)
 * - App accelerators: runs the shortcut dispatcher so a consumed key never
 *   reaches the PTY, while a handler that declines in the current context
 *   (Ctrl+L in a CLI terminal, Ctrl+R outside a browser tab) leaves the key
 *   to xterm as ordinary input.
 *
 * Pass an optional `extend` handler for terminal-specific key behavior.
 * Return false to suppress the key, undefined to fall through to default.
 *
 * Pass `writeToPty` to enable Ctrl+V paste on Windows — it receives the payload
 * (clipboard text, an attachment path, a literal Ctrl+V) and forwards it to the PTY.
 */
export function attachClipboardCopyHandler(
  terminal: Terminal,
  extend?: ExtraKeyHandler,
  writeToPty?: (data: string) => void
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

    // Windows: Ctrl+V → paste the clipboard, attachments included
    if (isWin && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'v' && writeToPty) {
      if (e.type === 'keydown') {
        // preventDefault below suppresses Chromium's native paste, so no
        // DataTransfer ever exists: main's clipboard read is the only source.
        void pasteIntoTerminal(terminal, writeToPty).catch(() => {});
      }
      e.preventDefault(); // prevent native paste event from firing
      return false; // suppress \x16
    }

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
