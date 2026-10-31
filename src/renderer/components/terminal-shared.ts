/**
 * Constants shared by every xterm.js instance in the app (session panes,
 * project shells, remote/guest panes).
 */

/**
 * PA-29 (docs/performance.md static-footprint audit): xterm's default is
 * 1,000 lines/tab (~240 KB UTF-16 at 120 cols) — a bound by omission. The
 * audit asks for an explicit documented value; 5,000 lines keeps a full
 * agent run scrollable at ~1.2 MB/tab worst case, three sites, one number.
 */
export const TERMINAL_SCROLLBACK = 5000;

/**
 * Audit row 115: on macOS Option+key composes a Unicode character instead of
 * the ESC-prefixed Meta the TUIs in these panes bind (Alt+b/f word motion,
 * Meta-arrows). One value, three construction sites (session panes, project
 * shells, remote/guest panes). Trade-off: Option-compose input now needs
 * Option held after the base key; click semantics stay on
 * `macOptionClickForcesSelection` (unset = false, row 69 owns that call).
 */
export const TERMINAL_MAC_OPTION_IS_META = true;
