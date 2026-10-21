# Copy/paste latency in the FineVibe terminal — investigation and plan

Reported on Windows, pasting into an omp session. The plan is written for all three
supported OSes (§3): shared fixes, platform-gated fallbacks, per-OS acceptance.

Status: investigated, not implemented. No code changed.
Date: 2026-10-20.
Scope: terminal copy (selection → OS clipboard) and paste (OS clipboard → PTY) in
session panes, the project shell, and the remote pane; the omp CLI as the pasted-into
process; Windows is the reported platform, macOS and Linux are in scope for every phase.

Labels used below:
**[M]** measured on this machine · **[C]** verified in source · **[I]** inference, needs P0 measurement.

## 1. What the user feels

One keystroke (Ctrl+V) or one drag-select, and the whole window — terminal, tab bar,
sidebar — stops responding for a beat (tens of ms to seconds). The stall is in the
**main** process, which is the same thread that pumps every PTY chunk
(`ipc-handlers.ts:255-258` → `webContents.send('pty:data')`), so clipboard work is
terminal-output work: they contend for one thread. **[C]**

## 2. The paste path, as it runs today

Windows Ctrl+V (`terminal-utils.ts:297-305`):

1. `attachCustomKeyEventHandler` matches `isWin && ctrl && 'v'` → `e.preventDefault()`,
   `return false`. Chromium's native paste never fires, so **no `DataTransfer` ever exists**. **[C]**
2. `pasteIntoTerminal(terminal, writeToPty)` with `data === undefined` →
   `await window.vibeyard.clipboard.readForPaste()` (`terminal-utils.ts:134`) →
   `ipcRenderer.invoke` (`preload.ts:361`). **[C]**
3. Main runs `ipc-handlers.ts:587-607` **synchronously**:
   `availableFormats()` · `readText()` · `clipboardFilePaths()` ·
   `readImage()` + `toPNG()` (image flavor only) · `readHTML()` (only when text is empty). **[C]**
4. Payload structured-cloned back, `wrapBracketedPaste` (`terminal-utils.ts:13-18`),
   `ipcRenderer.send('pty:write')` → `writePty` → `instance.process.write(data)`
   (`ipc-handlers.ts:376-378`, `pty-manager.ts:534-546`) — the whole paste in one write. **[C]**

Note the byte stream also differs from xterm's own paste: `Clipboard.ts::paste` runs
`prepareTextForTerminal` (`\r?\n` → `\r`) before bracketing
(`@xterm/xterm@6.0.0/src/browser/Clipboard.ts`), while `wrapBracketedPaste` sends the
clipboard text verbatim, CRLF included. Under ConPTY + win32-input-mode the console host
re-encodes pasted line breaks as key records (pi-tui `windows-input-mode.ts:9-12`), so
the Windows path ships **more** records per paste than the native path. **[C]**

macOS/Linux take a different, cheap path: the native paste event carries a
`DataTransfer`, plain text is left to xterm, which writes the PTY itself
(`terminal-utils.ts:123-132`) — **zero main-process clipboard reads**. **[C]**
The Windows path is the only one that pays a clipboard session per keystroke, and it is
the platform the user reports.

## 3. Cross-platform contract

Every phase ships for Windows, macOS and Linux together: CI already builds and tests on
all three (`.github/workflows/ci.yml:15`), and the product's own contracts
(`docs/ui-conventions.md`, `docs/FEATURES.md` §24) describe **one** paste precedence
shared by all panes and all OSes. Platform branches use `isWin`/`isMac`/`isLinux`
(`src/renderer/platform.ts:13-15`, `src/main/platform.ts:9-11`) — never a raw
`process.platform` in the renderer — and tests parameterize the platform module the way
`terminal-utils.test.ts:8` already does.

Today's behavior per OS **[C]**:

| | Paste keystroke | Text source | File source | Copy routes |
|---|---|---|---|---|
| Windows | Ctrl+V intercepted (`terminal-utils.ts:297-305`) | main `readForPaste` | paste-event `File`s, `FileNameW`/`CF_HDROP` | Ctrl+C w/ selection, Ctrl+Shift+C, menu, copy-on-select → main |
| macOS | ⌘V → paste event | xterm writes the PTY | paste-event `File`s (Finder), `NSFilenamesPboardType` via main | ⌘+Shift+C, menu, copy-on-select → main; plain ⌘C → Chromium's copy handler |
| Linux | Ctrl+Shift+V → paste event; middle-click → PRIMARY | xterm writes the PTY | `text/uri-list` via main (a file-manager copy is usually not forwarded as `File`s) | as macOS, **plus** the PRIMARY write for `source === 'selection'` (`ipc-handlers.ts:465-471`) |

Invariants every phase preserves:

1. One paste precedence on every OS: files → text → markup → image path → `CTRL_V`
   passthrough (`docs/ui-conventions.md`).
2. Exactly one plain-text flavor reaches the OS clipboard (#160): Vibeyard's copy routes
   stay routed through main.
3. Linux PRIMARY: selection-driven copy sets it, explicit copy never does; middle-click
   paste keeps working.
4. Injected attachment paths stay shell-quoted for the PTY's platform (`quoteShellPath`,
   `terminal-utils.ts:32-41`).
5. Bracketed paste follows the host mode 2004 (`terminal-utils.ts:13-18`) — no
   per-OS unconditional wrapping.
6. Pasted images stay materialized inside `<tmp>/vibeyard-paste` with main-generated
   names on every OS (`docs/security-boundaries.md`).
7. Tests build path expectations with `path.join`/`path.resolve` (CLAUDE.md) so they pass
   on `windows-2022`.
8. A platform-specific mechanism is allowed only where the **capability** is
   platform-specific (ConPTY records, CF_HDROP, NSFilenames, PRIMARY). Latency fixes are
   shared code paths with gated fallbacks, never parallel per-OS implementations.

Clipboard mechanics the fixes must respect:

| OS | Mechanism | Consequence |
|---|---|---|
| Windows | Chromium opens the clipboard per read, 5 × `Sleep(5)` retries (`clipboard_win.cc`) | sequential reads multiply lock contention **[C]** |
| Windows | ConPTY re-encodes input as console key records | per-byte work inside the CLI (R3), Windows-only **[C]** |
| macOS | `NSPasteboard` reads pull the owner's delayed-rendered data | a busy owner (Office, OneNote, cloud sync) stalls the read **[I — P0 times it]** |
| Linux/X11 | CLIPBOARD data lives in the owning app; a reader requests a conversion and waits | a hung owner stalls the read on the Electron main thread **[I — P0: `SIGSTOP` the owner, then paste]** |
| Linux/Wayland | portal/permission-gated; file lists and images often absent | an empty format list must degrade to the passthrough, not a silent no-op **[I]** |

## 4. Root causes, ranked

Scope: R1 and R3 are Windows mechanisms (Chromium's per-read clipboard acquisition, ConPTY
key records). R2 and R4 are shared — copy-on-select and the `pty:data` fan-out behave the
same on macOS and Linux, so their fixes land there too. §3 records what replaces R1's
mechanism on the POSIX platforms: clipboard data served by the owning app.

### R1 — one clipboard *session* per read, six of them, on the main thread. [primary]

Chromium's Windows clipboard (`ui/base/clipboard/clipboard_win.cc`, `main` fetched
2026-10-20) acquires the OS clipboard per call:

```cpp
const int kMaxAttemptsToOpenClipboard = 5;
for (int attempts = 0; attempts < kMaxAttemptsToOpenClipboard; ++attempts) {
  if (::OpenClipboard(owner)) { opened_ = true; return true; }
  ::Sleep(5);                       // contention: rdpclip.exe named in the comment (Bug 815425)
}
```

Each `ReadTextInternal` / `ReadHTMLInternal` / `GetAllAvailableFormatsInternal` /
`ReadDataInternal` opens and closes the clipboard independently. **[C]**
Electron exposes those as the synchronous main-process `clipboard.*` calls Vibeyard uses.

Per plain-text Ctrl+V, `ipc-handlers.ts:587-607` + `532-585` therefore performs
**6 OpenClipboard/CloseClipboard cycles** (`availableFormats`, `readText`,
`readBuffer('FileNameW')`, `readBuffer('CF_HDROP')`,
`readBuffer('NSFilenamesPboardType')`, `read('text/uri-list')`) — the last four are
file-list probes that are meaningless on a text copy and are not gated by platform. **[C]**
Worst case (image + no text): 8. **[C]**

Aggravators, all on the same thread:

- The three `readBuffer` probes **throw** on a text copy and each is logged with
  `console.warn` (`:540`, `:559`, `:570`) → 3 exceptions + 3 log records per paste. **[C]**
- `GetClipboardData(CF_HDROP)` forces the clipboard **owner** to render its file list
  (Windows delayed rendering). An Explorer copy from a network share/OneDrive blocks
  main for as long as the owner takes. **[I — P0 must reproduce with a real Explorer copy]**
- Under contention (RDP `rdpclip.exe`, Win+V history, OneNote, clipboard managers, AV)
  each failed acquisition is 5 × 5 ms = **25 ms of pure sleep**, so 6 reads ≈ up to
  150 ms per paste before doing any work. **[C]** for the sleep; **[I]** for the total.
- `readImage()` decodes the DIB to a bitmap and `toPNG()` encodes it on the main thread
  (`ipc-handlers.ts:592-601`). Proxy measurement **[M]** (Node `zlib` deflate,
  screenshot-like 3 % ink, a lower bound on Skia's filter+deflate):
  1920×1200 ≈ **214 ms**, 2560×1440 ≈ **403 ms**; incompressible content 1.3–4.3 s.
  A screenshot paste is a ~0.2–0.5 s main-thread freeze **before** `writePastedFile`
  (`:492-512`) writes 9–15 MB-decoded PNG bytes to `%TEMP%\vibeyard-paste`.
- No size bound on pasted **text**: `PASTE_MAX_BYTES` (`:481`) guards image bytes only.
  A 10 MB log copy crosses IPC twice (main→renderer string, renderer→main `pty:write`). **[C]**

### R2 — every completed selection pays a full copy, unconditionally.

`attachCopyOnSelect` (`terminal-utils.ts:229-234`) runs `copySelection` on every
`terminal.onSelectionChange`. In xterm 6.0.0 that event fires on `mouseup`
(`SelectionService._handleMouseUp` → `_fireEventIfSelectionChanged`) and from
`setSelection` / `rightClickSelect` / `selectAll` / `selectLines` / `clearSelection`;
`_handleMouseMove` only calls `refresh(true)` — so a drag fires **once**, not per move.
**[C verified against @xterm/xterm@6.0.0 `src/browser/services/SelectionService.ts`]**
Each firing costs:

- `selectionService.selectionText`: a `translateBufferLineToString` per selected row,
  a non-breaking-space regex per row, a join, line endings forced to `\r\n` on
  Windows. O(cells) in the selection, on the renderer thread. **[C]**
- `ipcRenderer.invoke('clipboard:write')` (`terminal-utils.ts:218-222`) — a promise
  round trip where fire-and-forget `send` would do; the whole selection string is
  structured-cloned. **[C]**
- main `clipboard.writeText` (`ipc-handlers.ts:465-471`) → open + `EmptyClipboard` +
  `SetClipboardData` + close + `WM_CLIPBOARDUPDATE` broadcast down the clipboard chain
  (Win+V history, OneNote, `rdpclip.exe`, AV scanners). On the main thread — the PTY
  pump. **[C]**, chain cost **[I]**

No "unchanged selection" check, no coalescing with the context-menu copy, no throttle
for rapid re-selections. Select-all of a full scrollback then Copy is the worst case:
O(cells) rebuild + a multi-MB clipboard set. `copyOnSelect` is opt-in (default `false`,
`state.ts:116`); attached to all three pane kinds: `terminal-pane.ts:338`,
`project-terminal.ts:139`, `remote-terminal-pane.ts:117`. **[C]**

### R3 — inside omp: ConPTY delivers one key record per pasted byte.

From the installed source, `~/.bun/install/cache/@oh-my-pi/pi-tui@18.12.3@@@1/src` **[C]**:

- `terminal.ts:764-767` — `isConPTYHosted()` is true for every win32 run.
- `terminal.ts:2085-2100` — with no kitty keyboard protocol (xterm.js has none), omp
  writes `CSI ? 9001 h` (win32-input-mode) and installs `Win32InputModeDecoder` +
  `Win32PasteMarkerNormalizer`.
- `windows-input-mode.ts:22-27` — a host that writes VT through ConPTY (i.e. node-pty,
  which is what FineVibe spawns) "reaches us as **one `Vk = 0` text record per byte**".
  So a 10 KB paste = ~10 000 records, decoded back to VT in JS, per record.
- `terminal.ts:1415-1421` records the cost of that regime in their own words: per-event
  escape probing "turns a 100 KB paste into ~600K regex executions and blocks the event
  loop" (#4073). The fast path is skipped whenever a reassembly buffer is pending — and
  `hasPendingSequence` is exactly what a paste marker split across records sets
  (`terminal.ts:1404-1413`), with `WIN32_RELAYED_ESCAPE_TIMEOUT_MS = 75` (`:47`).
- `stdin-buffer.ts:29,526` — a bracketed-paste end marker lost across chunks falls back
  to `PASTE_INACTIVITY_TIMEOUT_MS = 1000`: **up to 1 s** before the paste is delivered.
  `PARTIAL_HOLD_MAX_MS = 150` (`:47`) bounds a held partial;
  `RAW_PASTE_CLASSIFICATION_TIMEOUT_MS = 10` (`:99`) holds an unmarked multi-line paste.
  `wrapBracketedPaste` only wraps when xterm reports mode 2004 (`terminal-utils.ts:13-18`),
  so a CLI that never enabled 2004 lands on the 10 ms classification path. **[C]**
- Ruled out as the driver: omp's render loop is coalesced at 30 fps, adaptive to 200 ms
  (`tui.ts:944-951`), and its ConPTY writes are chunked at 16 KiB
  (`terminal.ts:109-136`) — not per-keystroke.

FineVibe owns the trigger: the per-byte record storm exists because xterm.js does not
implement the kitty keyboard protocol, so omp is forced onto the 9001 fallback.

### R4 — the paste echo is amplified per chunk, main → renderer.

One `webContents.send('pty:data')` per node-pty chunk (`ipc-handlers.ts:255-258`), no
coalescing; per chunk the renderer does `terminal.write`, `parseCost` — a `stripAnsi`
regex over the chunk plus a scan, until structured cost arrives
(`index.ts:128-142`, `session-cost.ts:40-69`) — `data.includes('Interrupted')`, and
share forwarding. A paste echo from a full-screen TUI is a burst of frames, so this is
CPU paid *after* the paste, extending the perceived stall. **[C]**

## 5. Ruled out (do not re-litigate)

- **OSC 52 / kitty OSC 5522 clipboard requests hanging.** omp's
  `pi-coding-agent/src/utils/enhanced-paste.ts` speaks 5522, and it is inert here: the
  handshake (`?5522h`) requires host support xterm.js does not have, and omp disables it
  (`pi-tui terminal.ts:484,2367`). No unanswered clipboard query is outstanding. **[C]**
- **Double paste.** `attachImagePasteHandler` defers plain text to xterm
  (`terminal-utils.ts:169-175`); the Windows Ctrl+V branch returns before the shortcut
  dispatcher (`:297-314`). One writer per route. **[C]**
- **A per-mousemove copy storm.** xterm's `_handleMouseMove` fires no selection-change
  event (verified above), so `copyOnSelect` costs one clipboard write per completed
  selection, not one per pixel of drag. P3 targets the per-selection cost and the
  missing unchanged-check, not a coalescing of mousemove events. **[C]**
- **Provider pollers, watchers, `state.json` persist** — not on the keystroke path. **[C]**
- **xterm `scrollback`** (library default 1000, `docs/performance.md`) — memory, not latency. **[C]**

## 6. Environment limits on this investigation

- **No `node_modules`** in the repo (only `.cache`): `npm install` is required before any
  in-app measurement, Electron build, or test run. **[M]**
- The Windows clipboard is **unreachable from the agent shell**: `OpenClipboard` →
  `ERROR_ACCESS_DENIED (5)` (non-interactive window station). The Windows-API harness
  `%TEMP%\clipbench\clipbench.ps1` (written and syntax-validated here) **must be run from
  an interactive desktop session**; that is a user step, not an agent step. **[M]**
- Packaged-app performance has never been measured — `docs/performance.md` says so
  explicitly. Every number above marked [I] is a cost *model*, not a measurement. **[C]**
- **The agent shell is Windows-only.** Every macOS and Linux number in §7 (P0 items 1, 2,
  4) has to be produced on that OS — a macOS machine or VM, and one X11 plus one Wayland
  Linux session. Nothing about those platforms is verifiable from this box, and the CI
  matrix runs unit suites only (no OS clipboard in headless CI), so each phase's per-OS
  acceptance row is a user-executed check until a clipboard-capable CI job exists. **[M]**

## 7. Plan

### P0 — measure first (gate for everything below)

Cross-platform by construction: one Electron harness, run on all three OSes, plus a raw
OS-level cross-check where one exists.

1. `dev/perf/clipboard-bench.js` — real Electron main + hidden window (Electron's
   clipboard is main-process only). Per scenario: {empty, 40 B text, 100 KB text, 1 MB
   text, rich HTML (Word/browser copy), file-list copy, 1080p screenshot, 1440p
   screenshot} time every `readForPaste` sub-op (`availableFormats`, `readText`, each
   `readBuffer`, `read('text/uri-list')`, `readImage`, `toPNG`, `writePastedFile`) and the
   whole handler; p50/max over ≥11 runs; repeat the sequence back-to-back to expose
   per-read vs cached-read behavior.
   Scenario setup per OS: Windows Explorer copy / macOS Finder copy / Nautilus+Dolphin
   copy; screenshots via Win+Shift+S, `⌘⇧Ctrl+4`, `gnome-screenshot`.
2. Contention per OS, the number R1 rests on:
   - **Windows** — a second process holds `OpenClipboard` for 2.5 s (models
     `rdpclip.exe`); assert the 5 × 5 ms retry pattern and quantify the freeze.
     Cross-check with the raw Win32 harness (written and syntax-validated here,
     `%TEMP%\clipbench\clipbench.ps1` + `hold.ps1`; same op order, `files` scenario =
     CF_HDROP) — it must run from an interactive desktop session.
   - **macOS** — copy from a deliberately busy owner (a script that copies, then spins
     with the pasteboard un-rendered); measure `pbcopy` → paste-read latency.
   - **Linux/X11** — copy in an app, `SIGSTOP` it, then paste: the read is served by the
     owner, so this is the hang case. Record whether main stalls, and for how long.
   - **Linux/Wayland** — record the format list with and without portal clipboard
     permission; confirm an empty list yields the `CTRL_V` passthrough, not a silent no-op.
3. App-level instrumentation behind `FINEVIBE_CLIPBOARD_TIMING=1`:
   `[paste-timing]` for keydown → paste event → `readForPaste` reply → `pty:write` sent →
   first PTY byte back; `[copy-timing]` for selection-change → clipboard write resolved;
   clipboard-write and clipboard-read counts per interaction.
4. PTY paste probe (in-repo `node-pty`), child = byte-echo program: write
   `\x1b[200~` + N bytes + `\x1b[201~`, N ∈ {1 KB, 10 KB, 100 KB, 1 MB}; record drain
   time, chunk count, chunk sizes — ConPTY (Windows) vs the POSIX pty (macOS, Linux) side
   by side. Then repeat with `omp` as the child and measure keydown → frame containing the
   pasted text: Windows (win32-input-mode per-byte records, R3), macOS/Linux (bracketed
   paste through the pty), and after P1.
5. The harness output becomes the recorded baseline: a per-OS table in
   `docs/performance.md` ("Clipboard and paste"), as measured numbers, not constants.

**Acceptance:** a ms table per op × scenario × OS in `docs/performance.md`; R1/R2/R3
confirmed on the OS they claim, each demoted with a number where they do not hold.

### P1 — text paste goes through the native paste event on every platform

Windows is the outlier: stop `preventDefault()`-ing Ctrl+V
(`terminal-utils.ts:297-305`) so Chromium's paste event fires, `attachImagePasteHandler`
receives a `DataTransfer`, and xterm writes the PTY — the path macOS/Linux already use
(`terminal-utils.ts:123-132`). One paste path, three platforms: text is xterm's,
attachment paths are `fs.getDroppedFilePath`'s.

`readForPaste` stays as the fallback the paste event provably cannot serve — decided per
platform, inside the paste handler (no event, or no `DataTransfer` files while the
clipboard reports a file format):

| Platform | Paste event supplies | Main read still needed for |
|---|---|---|
| Windows | text; Explorer copies as `File`s with real paths | `CF_HDROP`/`FileNameW`-only copies, context-menu Paste |
| macOS | text; Finder copies as `File`s | `NSFilenamesPboardType`-only copies, context-menu Paste |
| Linux | text; `File`s only from sources Chromium forwards (middle-click text arrives through the same event: Chromium supplies the PRIMARY selection) | `text/uri-list` file-manager copies (the documented reason the read exists, `ipc-handlers.ts:514-520`), context-menu Paste |

**Acceptance:** on all three OSes a plain-text paste issues 0 clipboard IPCs; each
"still needed" row keeps pasting paths on its own OS (Linux is the risk: Nautilus and
Dolphin copies, on X11 **and** Wayland); `terminal-utils.test.ts` covers the event /
no-event branches with the existing platform mock (`terminal-utils.test.ts:8` precedent);
the `#160` single-plain-flavor guarantee keeps passing. Behavior change to document:
multi-line pastes now carry xterm's `\r?\n` → `\r` normalization on all three (already the
macOS/Linux behavior).

### P2 — one clipboard acquisition per `readForPaste`, probed per platform

`ipc-handlers.ts:532-585` probes four file formats on **every** platform, and three of
them exist on exactly one OS. Gate the probes with the main-side helpers
(`src/main/platform.ts:9-11`) plus the format list `availableFormats()` already fetched:

| Platform | Formats that carry a file list | Opens per plain-text paste: today → after |
|---|---|---|
| Windows | `FileNameW`, `CF_HDROP` | 6 → 2 (formats, text) |
| macOS | `NSFilenamesPboardType` | 6 → 2 |
| Linux | `text/uri-list` (X11; usually absent on Wayland) | 6 → 2, 3 with a file list |

Replace the throw-and-`console.warn` probes (`:540`, `:559`, `:570`) with format-gated
reads; keep `readHTML` only when text is empty; keep `hasContent`
(`formats.length > 0 || files.length > 0`) so an empty format list still yields the
`CTRL_V` passthrough rather than a silent no-op — the case that matters on Wayland, where
portal permissions can empty the readable set.

**Acceptance:** the open counts above asserted in `ipc-handlers.test.ts` by counting mocked
`clipboard.*` calls (that suite already fakes the Electron clipboard), 0 exceptions,
0 warns; a file-list paste keeps working on each OS through its own format.

### P3 — copy: one write per selection, fire-and-forget, PRIMARY intact

Send the clipboard write fire-and-forget (`ipcRenderer.send` + an `ipcMain.on` handler)
and skip it when the selection string is byte-identical to the last one written; give
large selections a budget (defer past ~256 Ki of selection) so a select-all copy cannot
serialize a multi-MB string on the renderer thread.

Invariants the change must not break:

- **Linux** — a selection-driven copy keeps writing the X11 **PRIMARY** selection next to
  CLIPBOARD (`ipc-handlers.ts:465-471`: `source === 'selection' && isLinux`); an explicit
  copy must not touch it. The unchanged-skip compares the selection payload and must never
  skip a PRIMARY refresh for a changed selection: middle-click paste is the contract.
- **macOS** — Vibeyard's copy routes (`⌘/Ctrl+Shift+C`, context menu, copy-on-select) all
  go through main for the #160 single-flavor reason; plain ⌘C is Chromium's own copy
  handler and is out of scope here.
- **Windows** — `Ctrl+C` copies with a selection, sends SIGINT without one
  (`terminal-utils.ts:288-294`); the `invoke` → `send` switch keeps that split.

**Acceptance:** one clipboard write per completed selection (counted by the P0 harness),
zero when unchanged; Linux middle-click pastes the selection after a copy-on-select drag;
`Ctrl+C` with no selection still reaches the PTY; `copyOnSelect` off ⇒ no writes.

### P4 — bound and offload the image paste

Bound pasted text (e.g. 8 MiB) with a user-visible notice; move the PNG encode off the
main thread (`toBitmap()` + an async encoder, or a `utilityProcess`), keeping main's
`writePastedFile` naming confinement (`docs/security-boundaries.md`) intact.

The encode exists on all three platforms; the **inputs** do not. Windows delivers
`CF_DIB`/`PNG`, macOS an `NSImage`/TIFF flavor, Linux an X11 `image/png` (on Wayland
clipboard images are often absent). P0 records per OS which flavor arrives and what
`readImage()`+`toPNG()` costs. Where an OS has no usable flavor the path stays the paste
event's `File` (screenshot blobs) plus the `CTRL_V` passthrough — the phase must not grow
a Windows-only code path.

**Acceptance:** screenshot paste freezes main < 50 ms on each OS; paste dir rules and the
25 MiB cap unchanged; an OS with no image flavor degrades to today's documented
passthrough, never to a crash.

### P5 — coalesce the echo

Per-session `pty:data` coalescing in main (~4 ms window, ≤64 KiB per message);
drop `parseCost`'s per-chunk `stripAnsi` scan in favour of the structured cost channel
and a throttled fallback; throttle the `'Interrupted'` scan.

Chunk shape is platform-dependent — ConPTY (Windows) emits many small records, POSIX ptys
deliver larger reads, alt-screen repaints differ per terminal — so the window is measured
on all three, and coalescing must degrade to a no-op (not a 4 ms delay) when one chunk
already exceeds the byte budget. P2P share forwarding (`index.ts:138-140`) consumes the
same stream and must receive the coalesced payloads.

**Acceptance:** messages/second on a 100 KB burst drops ≥5× on each OS; no visible
output-latency regression on macOS/Linux (measured, not assumed); the share stream still
renders; `npm test` green on the CI matrix (`.github/workflows/ci.yml:15` =
`macos-latest`, `ubuntu-latest`, `windows-2022`).

### P6 — docs

`docs/performance.md`: measured clipboard/paste numbers **per OS**, new limits (text
paste cap, coalescing windows). `docs/ui-conventions.md` paste contract: one paste-event
path on all three platforms, the per-OS main-read fallbacks, xterm's `\r?\n` → `\r`
normalization. `docs/security-boundaries.md`: paste-dir confinement unchanged, per-OS file
flavors named. `docs/FEATURES.md` §24: per-OS op counts and limits.

## 8. Order and risk

P0 → P1 → P2 → P3 → P4 → P5 → P6, every phase landing on all three OSes. P1+P2 target
the reported symptom; P3 is independent; P4/P5 are gated on P0 numbers — a screenshot
paste that measures 40 ms shrinks P4 to the text cap. P5 touches every PTY consumer
(share, inspector, search) and is the riskiest: land it last, behind the full gate
(`npm run build`, `npm test`, `npx tsc -p tsconfig.renderer.json --noEmit`,
`git diff --check`).

Platform gate per phase: the automated suites run on `macos-latest` / `ubuntu-latest` /
`windows-2022` (`.github/workflows/ci.yml:15`), which covers the mocked platform branches;
the interactive clipboard behaviors in §3's table (Explorer/Finder/Nautilus file copies,
Linux middle-click, Wayland permission denial) have no automated coverage today, so each
phase lists them as a manual check on each OS and P6 records them as covered or as a
coverage gap in `docs/FEATURES.md`. A phase is not done when it passes on the machine it
was written on. No commit, push, or PR.
