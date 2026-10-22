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
