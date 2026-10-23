import { appState } from './state.js';
import { isMac } from './platform.js';
import { hasKey, t } from './i18n.js';

export interface ShortcutDef {
  id: string;
  label: string;
  category: string;
  defaultKeys: string;
  handler: (() => boolean) | null;
}

interface ShortcutDefault {
  id: string;
  label: string;
  category: string;
  defaultKeys: string;
}

/**
 * English defaults, kept as stable ids + display fallbacks. `id` is the
 * keybinding storage key on `preferences.keybindings` — never localize it.
 * Labels/categories are translated at display time via `shortcutLabel`
 * and `shortcutCategoryLabel`.
 */
export const SHORTCUT_DEFAULTS: ShortcutDefault[] = [
  { id: 'new-session', label: 'New Session', category: 'Sessions', defaultKeys: 'CmdOrCtrl+T' },
  { id: 'new-session-alt', label: 'New Session (Alt)', category: 'Sessions', defaultKeys: 'CmdOrCtrl+Shift+N' },
  { id: 'new-project', label: 'New Project', category: 'Sessions', defaultKeys: 'CmdOrCtrl+Shift+P' },
  { id: 'goto-session-1', label: 'Go to Session 1', category: 'Sessions', defaultKeys: 'CmdOrCtrl+1' },
  { id: 'goto-session-2', label: 'Go to Session 2', category: 'Sessions', defaultKeys: 'CmdOrCtrl+2' },
  { id: 'goto-session-3', label: 'Go to Session 3', category: 'Sessions', defaultKeys: 'CmdOrCtrl+3' },
  { id: 'goto-session-4', label: 'Go to Session 4', category: 'Sessions', defaultKeys: 'CmdOrCtrl+4' },
  { id: 'goto-session-5', label: 'Go to Session 5', category: 'Sessions', defaultKeys: 'CmdOrCtrl+5' },
  { id: 'goto-session-6', label: 'Go to Session 6', category: 'Sessions', defaultKeys: 'CmdOrCtrl+6' },
  { id: 'goto-session-7', label: 'Go to Session 7', category: 'Sessions', defaultKeys: 'CmdOrCtrl+7' },
  { id: 'goto-session-8', label: 'Go to Session 8', category: 'Sessions', defaultKeys: 'CmdOrCtrl+8' },
  { id: 'goto-session-9', label: 'Go to Session 9', category: 'Sessions', defaultKeys: 'CmdOrCtrl+9' },
  { id: 'next-session', label: 'Next Session', category: 'Sessions', defaultKeys: 'CmdOrCtrl+Shift+]' },
  { id: 'prev-session', label: 'Previous Session', category: 'Sessions', defaultKeys: 'CmdOrCtrl+Shift+[' },
  { id: 'tab-back', label: 'Back (Tab History)', category: 'Sessions', defaultKeys: 'CmdOrCtrl+[' },
  { id: 'tab-forward', label: 'Forward (Tab History)', category: 'Sessions', defaultKeys: 'CmdOrCtrl+]' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', category: 'Panels', defaultKeys: 'CmdOrCtrl+B' },
  { id: 'toggle-split', label: 'Toggle Split Mode', category: 'Panels', defaultKeys: 'CmdOrCtrl+\\' },
  { id: 'project-terminal', label: 'Project Terminal', category: 'Panels', defaultKeys: 'Ctrl+`' },
  { id: 'project-terminal-alt', label: 'Project Terminal (Alt)', category: 'Panels', defaultKeys: 'CmdOrCtrl+J' },
  { id: 'debug-panel', label: 'Debug Panel', category: 'Panels', defaultKeys: 'CmdOrCtrl+Shift+D' },
  { id: 'git-panel', label: 'Git Panel', category: 'Panels', defaultKeys: 'CmdOrCtrl+Shift+G' },
  { id: 'quick-open', label: 'Quick Open File', category: 'Search & Help', defaultKeys: 'CmdOrCtrl+P' },
  { id: 'session-search', label: 'Search All Sessions', category: 'Search & Help', defaultKeys: 'CmdOrCtrl+Shift+F' },
  { id: 'find-in-terminal', label: 'Find', category: 'Search & Help', defaultKeys: 'CmdOrCtrl+F' },
  { id: 'goto-line', label: 'Go to Line', category: 'Search & Help', defaultKeys: 'CmdOrCtrl+L' },
  { id: 'help', label: 'Help', category: 'Search & Help', defaultKeys: 'F1' },
  { id: 'close-session', label: 'Close Session', category: 'Sessions', defaultKeys: 'CmdOrCtrl+W' },
  { id: 'toggle-inspector', label: 'Toggle Session Inspector', category: 'Panels', defaultKeys: 'CmdOrCtrl+Shift+I' },
  { id: 'zoom-in', label: 'Zoom In', category: 'View', defaultKeys: 'CmdOrCtrl+=' },
  { id: 'zoom-out', label: 'Zoom Out', category: 'View', defaultKeys: 'CmdOrCtrl+-' },
  { id: 'zoom-reset', label: 'Reset Zoom', category: 'View', defaultKeys: 'CmdOrCtrl+0' },
  { id: 'browser-reload', label: 'Reload Page', category: 'Browser', defaultKeys: 'CmdOrCtrl+R' },
  { id: 'browser-hard-reload', label: 'Hard Reload (Bypass Cache)', category: 'Browser', defaultKeys: 'CmdOrCtrl+Shift+R' },
];

/** Localized display label for a shortcut; falls back to its English default. */
export function shortcutLabel(def: { id: string; label: string }): string {
  const key = `shortcuts.${def.id}.label`;
  return hasKey(key) ? t(key) : def.label;
}

/** Localized category header; falls back to the raw (English) category name. */
export function shortcutCategoryLabel(category: string): string {
  const key = `shortcuts.category.${category}`;
  return hasKey(key) ? t(key) : category;
}

/** Convert accelerator string to platform-specific display string */
export function displayKeys(accelerator: string): string {
  let display = accelerator;
  if (isMac) {
    display = display.replace(/CmdOrCtrl/g, 'Cmd');
    display = display.replace(/Ctrl\+/g, 'Ctrl+');
  } else {
    display = display.replace(/CmdOrCtrl/g, 'Ctrl');
  }
  if (isMac) {
    display = display
      .replace(/Cmd/g, '\u2318')
      .replace(/Shift/g, '\u21E7')
      .replace(/Alt/g, '\u2325')
      .replace(/Ctrl/g, '\u2303');
    display = display.replace(/\+/g, '');
  }
  return display;
}

/** Parse an accelerator string into modifier flags and a key */
function parseAccelerator(accelerator: string): { ctrl: boolean; meta: boolean; shift: boolean; alt: boolean; key: string } {
  const parts = accelerator.split('+');
  let ctrl = false;
  let meta = false;
  let shift = false;
  let alt = false;
  let key = '';

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'cmdorctrl') {
      if (isMac) meta = true;
      else ctrl = true;
    } else if (lower === 'ctrl') {
      ctrl = true;
    } else if (lower === 'cmd') {
      meta = true;
    } else if (lower === 'shift') {
      shift = true;
    } else if (lower === 'alt') {
      alt = true;
    } else {
      key = part;
    }
  }

  return { ctrl, meta, shift, alt, key };
}

/**
 * Canonical ASCII letter/digit for the physical key of an event.
 * Non-Latin keyboard layouts (Cyrillic, Greek, Arabic…) report `e.key`
 * as the layout's character for that key-position ('т' on the physical
 * T), so a Ctrl+Т press never matches a 'T' binding. `e.code` is
 * layout-independent: KeyA→'a', Digit1→'1' on every layout. Falls back
 * to `e.key` when the code is not a plain letter/digit position (e.g.
 * Numpad1, where e.key already carries the digit).
 */
function canonicalAlnumKey(e: KeyboardEvent): string {
  const letter = /^Key([A-Z])$/.exec(e.code ?? '');
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(e.code ?? '');
  if (digit) return digit[1];
  return e.key;
}

/** Check if a KeyboardEvent matches an accelerator string */
function matchesAccelerator(e: KeyboardEvent, accelerator: string): boolean {
  const parsed = parseAccelerator(accelerator);

  const eventCtrl = e.ctrlKey;
  const eventMeta = e.metaKey;
  const eventShift = e.shiftKey;
  const eventAlt = e.altKey;

  if (parsed.ctrl !== eventCtrl) return false;
  if (parsed.meta !== eventMeta) return false;
  if (parsed.shift !== eventShift) return false;
  if (parsed.alt !== eventAlt) return false;

  // Compare key - handle special cases. Letter/digit bindings resolve
  // through the physical-key code so non-Latin layouts keep working;
  // symbols, punctuation and F-keys keep the e.key comparison.
  const parsedKey = parsed.key;
  const eventKey = /^[a-zA-Z0-9]$/.test(parsedKey)
    ? canonicalAlnumKey(e)
    : e.key;

  // Direct match
  if (eventKey === parsedKey) return true;
  // Case-insensitive for letters
  if (eventKey.length === 1 && parsedKey.length === 1 && eventKey.toLowerCase() === parsedKey.toLowerCase()) return true;
  // Number keys
  if (/^\d$/.test(parsedKey) && eventKey === parsedKey) return true;
  // F-keys
  if (parsedKey.startsWith('F') && eventKey === parsedKey) return true;

  return false;
}

/** Convert a KeyboardEvent to an accelerator string */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  const key = e.key;

  // Ignore bare modifier keys
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey && e.metaKey) {
    // Both ctrl and meta
    parts.push('Ctrl');
    parts.push('Cmd');
  } else if (e.metaKey) {
    parts.push(isMac ? 'CmdOrCtrl' : 'Cmd');
  } else if (e.ctrlKey) {
    parts.push(isMac ? 'Ctrl' : 'CmdOrCtrl');
  }
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');

  // Normalize key name
  let normalizedKey = key;
  if (key.length === 1) {
    normalizedKey = key.toUpperCase();
  }

  parts.push(normalizedKey);
  return parts.join('+');
}

/**
 * True while a real text entry owns the keyboard: renames, prompts,
 * search fields, board cards. The xterm helper textarea is deliberately
 * NOT a typing target — terminal panes forward keys to the PTY and app
 * shortcuts (Ctrl+T, Ctrl+W, Ctrl+1-9) must keep working there.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.closest?.('.xterm')) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || el.isContentEditable === true || el.contentEditable === 'true';
}

/**
 * Every keyboard-driven overlay root the app can open. The first two are the
 * shared modal.ts root and the modal-shell dialogs (hidden via the `hidden`
 * class, so keep :not(.hidden) on them). The rest are full-screen overlays
 * created outside modal-shell — share/join dialogs, the team picker, quick
 * open, the session palette, and the browser-tab flow picker / send menu —
 * which are invisible to `.modal-overlay` and were the gap left by 6af0c7a:
 * Ctrl+W behind the team detail overlay killed the tab's PTY. Excluded on
 * purpose: terminal-exit-overlay and browser-drag-overlay are non-interactive
 * decorations, not keyboard owners.
 */
const OVERLAY_SELECTOR = [
  '#modal-overlay:not(.hidden)',
  '.modal-overlay:not(.hidden)',
  '.share-overlay',
  '.team-picker-overlay',
  '.team-picker-detail-overlay',
  '.quick-open-overlay',
  '.session-palette-overlay',
  '.flow-picker-overlay',
  '.send-menu-overlay',
].join(',');

/** True while any modal overlay is visible (shared modal.ts overlay + modal-shell overlays). */
function isModalOpen(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    // Most overlays are removed from the DOM on close; the browser-tab flow
    // picker and send menu are display-toggled, so honour inline hiding.
    if (el.style.display !== 'none') return true;
  }
  return false;
}
export class ShortcutManager {
  private shortcuts: ShortcutDef[] = [];

  constructor() {
    this.shortcuts = SHORTCUT_DEFAULTS.map((d) => ({ ...d, handler: null }));
  }

  /** Register a handler for a shortcut id */
  registerHandler(id: string, handler: () => boolean): void {
    const shortcut = this.shortcuts.find((s) => s.id === id);
    if (shortcut) {
      shortcut.handler = handler;
    }
  }

  /** Get resolved keys (override or default) for a shortcut */
  getKeys(id: string): string {
    const overrides = appState.preferences.keybindings ?? {};
    const shortcut = this.shortcuts.find((s) => s.id === id);
    if (!shortcut) return '';
    return overrides[id] ?? shortcut.defaultKeys;
  }

  /** Get all shortcuts with resolved keys, grouped by category */
  getAll(): Map<string, Array<ShortcutDef & { resolvedKeys: string }>> {
    const overrides = appState.preferences.keybindings ?? {};
    const groups = new Map<string, Array<ShortcutDef & { resolvedKeys: string }>>();

    for (const shortcut of this.shortcuts) {
      const resolvedKeys = overrides[shortcut.id] ?? shortcut.defaultKeys;
      const entry = { ...shortcut, resolvedKeys };
      if (!groups.has(shortcut.category)) {
        groups.set(shortcut.category, []);
      }
      groups.get(shortcut.category)!.push(entry);
    }

    return groups;
  }

  /** Set a custom keybinding override */
  setOverride(id: string, keys: string): void {
    const current = { ...(appState.preferences.keybindings ?? {}) };
    current[id] = keys;
    appState.setPreference('keybindings', current);
  }

  /** Reset a keybinding to its default */
  resetOverride(id: string): void {
    const current = { ...(appState.preferences.keybindings ?? {}) };
    delete current[id];
    appState.setPreference('keybindings', current);
  }

  /** Check if a shortcut has a custom override */
  hasOverride(id: string): boolean {
    const overrides = appState.preferences.keybindings ?? {};
    return id in overrides;
  }

  /**
   * View-level shortcuts stay live while a text field has focus: they are
   * pure view toggles (zoom, panels, help) and cannot destroy data. The
   * rest — close-session, tab navigation, quick-open, new-session — are
   * suppressed while typing (renames, prompts, board cards): Ctrl+W mid
   * rename used to close the session.
   */
  private static readonly FIELD_SAFE = new Set([
    'zoom-in', 'zoom-out', 'zoom-reset',
    'toggle-sidebar', 'toggle-inspector', 'toggle-split',
    'debug-panel', 'git-panel', 'help',
  ]);

  /** Match a keyboard event to a shortcut and execute its handler */
  matchEvent(e: KeyboardEvent): boolean {
    const overrides = appState.preferences.keybindings ?? {};

    const inField = isTypingTarget(e.target);
    const inModal = isModalOpen();

    for (const shortcut of this.shortcuts) {
      const keys = overrides[shortcut.id] ?? shortcut.defaultKeys;
      if (!matchesAccelerator(e, keys) || !shortcut.handler) continue;
      // A modal swallows app navigation: its own inputs are focused and
      // ESC/Enter are owned by the dialog. Only the always-safe view
      // toggles and Help pass through.
      if (inModal && shortcut.id !== 'zoom-in' && shortcut.id !== 'zoom-out'
          && shortcut.id !== 'zoom-reset' && shortcut.id !== 'help') continue;
      if (inField && !ShortcutManager.FIELD_SAFE.has(shortcut.id)) continue;
      // The handler owns the verdict: it returns true only when it acted in
      // the current context. Declined keys keep their default behavior, so
      // Ctrl+L reaches the PTY in a CLI terminal (readline clear-screen) and
      // Ctrl+R reaches browser-key passthrough outside a browser tab.
      if (!shortcut.handler()) continue;
      e.preventDefault();
      return true;
    }
    return false;
  }

  /** Check if a keyboard event matches any registered shortcut (without executing) */
  matchesAnyShortcut(e: KeyboardEvent): boolean {
    const overrides = appState.preferences.keybindings ?? {};
    for (const shortcut of this.shortcuts) {
      const keys = overrides[shortcut.id] ?? shortcut.defaultKeys;
      if (matchesAccelerator(e, keys)) return true;
    }
    return false;
  }
}

export const shortcutManager = new ShortcutManager();
