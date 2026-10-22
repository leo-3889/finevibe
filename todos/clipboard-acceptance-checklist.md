# Clipboard / paste — per-OS runtime acceptance checklist

Runnable checklist for the **shipped** clipboard-paste work. Sources:
[`../todos/archives/clipboard-paste-latency-plan.md`](../todos/archives/clipboard-paste-latency-plan.md) §8 (:405–420) + §7 acceptance rows
(P0 :289–290, P1 :310–316, P2 :336–338, P3 :359–361, P4 :376–378, P5 :392–395) and [`../docs/performance.md`](../docs/performance.md)
:190 (coverage) + :206 (pending runtime checks). Plan §8:414–419: the interactive rows (Explorer/Finder/Nautilus copies,
Linux middle-click, Wayland denial) have **no automated coverage** — "A phase is not done when it passes on the machine it was written on" (:420).

## 1. What shipped (branch `rebuild`; `git log --oneline --grep="clipboard\|paste" -i`, 2026-10-22)

| SHA | Content | Automated evidence |
| --- | --- | --- |
| `2cfb68c` | P0 harness + opt-in instrumentation + Windows baseline | `dev/perf/clipboard-bench.js`, `dev/perf/clipbench.ps1` + `hold.ps1`, `dev/perf/pty-paste-probe.js`; numbers in `docs/performance.md:140–190` |
| `8f77536` | P1–P5: native paste event on every platform, format-gated probes, fire-and-forget copy, 8 Mi text cap + off-thread PNG, `pty:data` coalescing | `terminal-utils.test.ts`, `ipc-handlers.test.ts`, `png-encode-worker.test.ts` (`docs/performance.md:198–204`) |
| `8687755` | straggler call sites + disabled-row styles (31–36 fixup) | same suites |

Shipped anchors: `clipboard:readForPaste` `src/main/ipc-handlers.ts:1248`; text cap `:1041`; image cap 25 MiB `:1037`; X11
PRIMARY write `:1022`; gated probes `clipboardFilePaths:1182` (Windows `:1185`, Linux `text/uri-list` `:1232`); coalescer window/cap
`:781–782`, exit flush `:823–828`; renderer precedence `pasteIntoTerminal` `src/renderer/components/terminal-utils.ts:170`, `CTRL_V` passthrough `:250`/`:259`.

## 2. What stays unverified, and why

- **No macOS and no Linux (X11/Wayland) machine on the dev host** — plan §6:242–246: "The agent shell is Windows-only …
  Nothing about those platforms is verifiable from this box." Every macOS/X11/Wayland row is `harness ready, pending a machine of that OS` (`docs/performance.md:190`).
- **CI cannot close these rows**: the matrix `macos-latest`/`ubuntu-latest`/`windows-2022` (`.github/workflows/ci.yml:15`)
  runs mocked-clipboard suites — headless CI has no OS clipboard.
- **Packaged-app performance is unmeasured** (`docs/performance.md:218`), including packaged Windows (:206).

## 3. One-time setup (every machine)

- [ ] `npm install` (Node 24, `.nvmrc`) → `npm run build`; packaged rows: `npm run dist` + install the artifact.
- [ ] Launch instrumented: `FINEVIBE_CLIPBOARD_TIMING=1 npm start` (macOS/Linux) /
      `$env:FINEVIBE_CLIPBOARD_TIMING="1"; npm start` (Windows); packaged = same env var, then start the app.
      Expect `[paste-timing]` / `[copy-timing]` in the main console (`ipc-handlers.ts:1002`, format `:1334`);
      the renderer gets the flag via `src/preload/preload.ts:395–399`.
- [ ] Harnesses from the repo root:
  - bench — `npx electron dev/perf/clipboard-bench.js`: 8 scenarios (`empty`, `text-40B`, `text-100KB`,
    `text-1MB`, `rich-html`, `file-list`, `image-1080p`, `image-1440p`; `:203`), p50/max over 11 passes, prints a
    `formats=` line per scenario (`:305`) and `RESULTS_JSON=<tmp>/clipbench-results.json` (`:308`).
  - probe — `node dev/perf/pty-paste-probe.js`: Leg A byte-echo drain (1 KB…1 MB), Leg B with `omp` on `PATH`;
    prints `PTY_PROBE_JSON=<tmp>/pty-probe-results.json`.
  - raw contention (Windows only, interactive desktop session) —
    `powershell -NoProfile -ExecutionPolicy Bypass -File dev/perf/clipbench.ps1` (`hold.ps1` = 2.5 s holder).
- [ ] **Message-rate counter** (every P5 row) — pane DevTools console: `let n=0,b=0,t=performance.now();const
      off=window.finevibe.pty.onData((s,d)=>{n++;b+=d.length});` → paste → `console.log(JSON.stringify({n,b,ms:Math.round(performance.now()-t)}))` → `off()`.
- [ ] **Where results land:** numbers into the `docs/performance.md` §"Clipboard and paste baseline" (:140)
      tables as a per-OS column/rows; flip that OS's phrase at :190 and strike it from :206; mark covered/gap in
      `docs/FEATURES.md` §24 (:292–300).

## 4. macOS

- [ ] **M1 · P0 baseline capture** (plan :255–263, :280–285, acceptance :289–290) — Steps: run the bench, then the
      probe; contention = a deliberately busy owner: copy, then spin with the pasteboard un-rendered, and time
      `pbcopy` → paste-read (plan :270–271). Expect: p50/max for all 8 scenarios incl. `readImage`/`toPNG`/`writePastedFile`
      on both image scenarios, Leg A drain table, and the busy-owner stall recorded in ms — confirm R1's macOS claim
      (plan :97 **[I]**) or demote it with a number. Land `docs/performance.md:145–158` + :177–182. · pass ☐ fail ☐ · date ______ · build ______
- [ ] **M2 · P4 screenshot paste < 50 ms** (plan :376–378; `docs/performance.md:206`) — Steps: `⌘⇧Ctrl+4` a 1080p
      region → context-menu Paste (the main-read fallback) → read main's `[paste-timing] readForPaste total=…ms`;
      repeat at 1440p; ≥5 samples each. Expect: **< 50 ms** (pre-P4 Windows reference 261.3/420.7 ms p50, `:158`);
      the clipboard's `png` flavor read as bytes, no main-thread encode; file lands in `<tmp>/finevibe-paste/` with
      a main-generated name; 25 MiB cap unchanged. · pass ☐ fail ☐ · date ______ · build ______
- [ ] **M3 · P5 ≥ 5× `pty:data` reduction** (plan :392–395) — Steps: counter from §3, paste a 100 KB text copy;
      compare msg/sec with this OS's probe Leg A chunk count for the same N (Windows reference: 87 chunks /
      147.2 ms, `docs/performance.md:181`). Expect **≥ 5× fewer** msg/sec; no visible output-latency regression on
      macOS (plan :393, measured not assumed); a P2P share of the session still renders (:394). · pass ☐ fail ☐ · date ______ · build ______
- [ ] **M4 · Finder file copy** (plan §3 :68, P1 :310–312, P2 :336–338) — Steps: copy one file, then 3 files, in
      Finder → paste into a pane; repeat for a `NSFilenamesPboardType`-only copy and via context-menu Paste.
      Expect: shell-quoted absolute paths, not the file name (files outrank text — `pasteIntoTerminal:170`);
      `[paste-timing] counts clipboardRead=1 clipboardWrite=0`; a plain-text paste costs **0** clipboard IPCs
      (P1 :310); the fallback read costs 2 clipboard opens, not 6 (P2 :326). · pass ☐ fail ☐ · date ______ · build ______

## 5. Linux / X11

- [ ] **L1 · P0 baseline capture** (plan :255–263, :272–273, :289–290) — Steps: bench + probe in an X11 session
      (`gnome-screenshot` for image scenarios, plan :263; file-list scenario = a Nautilus/Dolphin copy);
      contention = copy in an app, `SIGSTOP` the owner, then paste (plan :98, :272–273) — the owner serves the
      read, so this is the hang case. Expect: full tables, and **whether main stalls and for how long** (R1's X11
      claim is **[I]**). Land `docs/performance.md:145–158` + :177–182 (X11 rows). · pass ☐ fail ☐ · date ______ · build ______ (distro + DE + session type)
- [ ] **L2 · P4 screenshot paste < 50 ms** (plan :376–378) — Steps: `gnome-screenshot` a 1080p region →
      context-menu Paste → read `readForPaste total=`; repeat at 1440p; ≥5 samples. Expect **< 50 ms** with the
      X11 `image/png` flavor read as bytes; a clipboard with no image flavor degrades to the documented
      passthrough, never a crash (plan :377–378). · pass ☐ fail ☐ · date ______ · build ______
- [ ] **L3 · P5 ≥ 5× reduction** (plan :392–395) — Steps: counter from §3 on a POSIX pty (this OS's Leg A rate is
      the baseline; POSIX ptys deliver larger reads than ConPTY, plan :386–388); paste 100 KB. Expect **≥ 5×**
      fewer msg/sec, and a chunk that alone fills 64 KiB ships immediately — the window degrades to a no-op, no
      added latency (plan :388). · pass ☐ fail ☐ · date ______ · build ______
- [ ] **L4 · Nautilus/Dolphin file copy** (plan §3 :69, P1 :311–312 — "Linux is the risk") — Steps: copy a file in
      Nautilus, then in Dolphin → paste into a pane; then context-menu Paste. Expect: quoted absolute paths via
      the `text/uri-list` branch (`ipc-handlers.ts:1232`); Chromium forwards no `File`s for these copies, so the
      main read is the live path — 3 clipboard opens with a file list (plan :328). · pass ☐ fail ☐ · date ______ · build ______
- [ ] **L5 · Middle-click paste (X11 PRIMARY)** (plan §3 :69, :77–78; P3 :359–361) — Steps: enable copy-on-select
      (default off, `src/renderer/state.ts:158`); drag-select text in a FineVibe pane, then middle-click in the same
      pane, in an external terminal, and after an **explicit** copy (Ctrl+Shift+C / context menu) of the *same* string.
      Expect: middle-click pastes the selection every time (`source === 'selection'` sets PRIMARY,
      `ipc-handlers.ts:1022`); an explicit copy never touches PRIMARY; the unchanged-skip compares the
      `(text, source)` pair so explicit→selection of the same string still refreshes PRIMARY (`docs/performance.md:202`);
      one `[copy-timing]` write per completed selection, zero when unchanged; `copyOnSelect` off ⇒ no writes.
      · pass ☐ fail ☐ · date ______ · build ______

## 6. Linux / Wayland

- [ ] **W1 · P0 baseline capture** (plan :255–263, :274–275, :289–290) — Steps: bench + probe in a Wayland
      session; record `availableFormats()` **with and without** portal clipboard permission (the bench's `formats=`
      line, `clipboard-bench.js:305`). Expect: full tables for this session type, the format list in both
      permission states, and which image flavor (if any) arrives (plan :370–372 — Wayland images often absent).
      Land `docs/performance.md:145–158` + :177–182 (Wayland rows). · pass ☐ fail ☐ · date ______ · build ______ (compositor + portal)
- [ ] **W2 · P4 screenshot paste < 50 ms, or the documented degrade** (plan :370–378) — Steps: take a 1080p
      screenshot into the clipboard (compositor-dependent) → paste → read `readForPaste total=`; repeat with
      portal image access denied. Expect: **< 50 ms** where an image flavor is exposed; where none is, the paste
      degrades to the passthrough (the CLI's own paste) — never a crash, never a silent no-op. · pass ☐ fail ☐ · date ______ · build ______
- [ ] **W3 · P5 ≥ 5× reduction** (plan :392–395) — Steps: counter from §3 on this compositor; paste 100 KB.
      Expect ≥ 5× fewer msg/sec vs this OS's probe Leg A rate; alt-screen repaints stay smooth (plan :387). · pass ☐ fail ☐ · date ______ · build ______
- [ ] **W4 · Nautilus file copy** (plan §3 :69, P1 :311–312 — X11 **and** Wayland) — Steps: copy a file in
      Nautilus under Wayland → paste into a pane; then context-menu Paste. Expect: quoted absolute paths while
      `text/uri-list` is readable; when the portal empties the readable set, the paste resolves to the
      passthrough flavor (see W5). · pass ☐ fail ☐ · date ______ · build ______
- [ ] **W5 · Wayland permission-denial behavior** (plan §3 :99, :331–334; P2 :336–338; `docs/performance.md:206`)
      — Steps: deny clipboard access (portal permission off, or a compositor with no clipboard read), copy text in
      an external app, paste into a running omp pane on the instrumented build. Expect: `availableFormats()`
      returns `[]` → `hasContent` false → the renderer writes literal `CTRL_V` (`terminal-utils.ts:250`/`:259`) so
      **the CLI runs its own paste**; `[paste-timing] counts clipboardRead=1 clipboardWrite=0`; no exception, no
      `console.warn`, never a silent no-op (plan :99). · pass ☐ fail ☐ · date ______ · build ______

## 7. Windows (win32) — recorded-pass, re-check for regression

Recorded on Windows 10.0.26300, Node 24.14.0, Electron 41.1.0 (Chrome 146), node-pty 1.1.0
(`docs/performance.md:142`); mocked branches run on `windows-2022` (`.github/workflows/ci.yml:15`).

- [ ] **N1 · P0 baseline capture — RECORDED-PASS** (source `docs/performance.md:140–190`; bench writes
      `%TEMP%\clipbench-results.json`). Regression check: re-run bench + probe on the current build; expect the
      plain-text handler total ≤ ~1.1 ms p50 (`:160`, `:158`) and the file-list scenario served by `FileNameW`
      (`readBuffer('CF_HDROP')` answers 0 bytes on Windows — `:160`, `ipc-handlers.ts:1161–1164`). · pass ☐ fail ☐ · date ______ · build ______
- [ ] **N2 · P1 native text paste — RECORDED-PASS** (`docs/performance.md:200`, `terminal-utils.test.ts`).
      Regression check: Ctrl+V a plain-text copy on the instrumented build → **no** `readForPaste` line in main,
      0 clipboard IPCs; multi-line text arrives with xterm's `\r?\n` → `\r` (plan :315–316); Ctrl+C with no
      selection still sends SIGINT. · pass ☐ fail ☐ · date ______ · build ______
- [ ] **N3 · P4 screenshot paste < 50 ms — PENDING (packaged)** (`docs/performance.md:206`; the 261.3/420.7 ms p50 pair
      at `:158` is the **pre-P4** shape). Steps: Win+Shift+S → paste (context-menu Paste for the main-read path, Ctrl+V
      for the paste-event `File` path) → read `readForPaste total=`; 1080p and 1440p, ≥5 samples. Expect **< 50 ms** main-
      thread freeze; a `PNG`/`image/png` flavor read as bytes (no main `toPNG` line); a CF_DIB-only clipboard encodes in
      the `png-encode-worker.ts` utilityProcess (`docs/performance.md:203`); lands in `%TEMP%\finevibe-paste\`.
      · pass ☐ fail ☐ · date ______ · build ______
- [ ] **N4 · P5 ≥ 5× reduction — BASELINE RECORDED, in-app ratio PENDING** (baseline: 100 KB → 87 chunks, 1 MB →
      1,383 chunks median 396 B, `docs/performance.md:177–182`). Steps: counter from §3 on the packaged app; paste
      100 KB, then 1 MB. Expect **≥ 5× fewer** msg/sec than 591 msg/s (87 chunks / 147.2 ms) at 100 KB, and `pty:exit`
      flushing the buffer so no tail output is lost on close (`ipc-handlers.ts:823–828`, `docs/performance.md:204`).
      · pass ☐ fail ☐ · date ______ · build ______
- [ ] **N5 · Explorer file copy — MOCKED PASS, packaged check PENDING** (`docs/performance.md:206`). Steps: copy
      one file, then 3 files, from Explorer — local, then a **network share / OneDrive** folder (the
      delayed-render case, plan :136–138) → paste into a pane. Expect: quoted absolute paths; 3 clipboard opens
      with a file list and 2 for plain text (plan :326); 0 thrown probes, 0 warns (plan :337). · pass ☐ fail ☐ · date ______ · build ______

## 8. Record results here

`docStatus` phrasing mirrors `docs/performance.md`: `measured (<OS>, <date>)` · `recorded-pass (mocked CI)` ·
`harness ready, pending a machine of that OS` · `pending runtime check (packaged)`.

| OS | Row | docStatus | Date | Build | Number(s) recorded |
| --- | --- | --- | --- | --- | --- |
| macOS | M1 P0 baseline | harness ready, pending a machine of that OS (`:190`) | | | |
| macOS | M2 P4 screenshot < 50 ms | pending runtime check | | | |
| macOS | M3 P5 ≥ 5× | pending runtime check | | | |
| macOS | M4 Finder copy | harness ready, pending a machine of that OS | | | |
| Linux/X11 | L1 P0 baseline | harness ready, pending a machine of that OS | | | |
| Linux/X11 | L2 P4 screenshot < 50 ms | pending runtime check | | | |
| Linux/X11 | L3 P5 ≥ 5× | pending runtime check | | | |
| Linux/X11 | L4 Nautilus/Dolphin copy | harness ready, pending a machine of that OS | | | |
| Linux/X11 | L5 middle-click / PRIMARY | harness ready, pending a machine of that OS | | | |
| Linux/Wayland | W1 P0 baseline | harness ready, pending a machine of that OS | | | |
| Linux/Wayland | W2 P4 screenshot / degrade | pending runtime check | | | |
| Linux/Wayland | W3 P5 ≥ 5× | pending runtime check | | | |
| Linux/Wayland | W4 Nautilus copy | harness ready, pending a machine of that OS | | | |
| Linux/Wayland | W5 permission denial | harness ready, pending a machine of that OS | | | |
| Windows | N1 P0 baseline | measured (Windows, 2026-10-21) — `:140–190` | 2026-10-21 | Electron 41.1.0 / node-pty 1.1.0 | text ≤1.1 ms p50; image 261.3/420.7 ms p50 |
| Windows | N2 P1 native paste | recorded-pass (mocked CI, `ci.yml:15`) | 2026-10-21 | 8f77536 | 0 clipboard IPCs |
| Windows | N3 P4 screenshot < 50 ms | pending runtime check (packaged) — `:206` | | | |
| Windows | N4 P5 ≥ 5× | baseline measured; in-app ratio pending | 2026-10-21 | 2cfb68c | 87 chunks @100 KB / 1,383 @1 MB |
| Windows | N5 Explorer file copy | recorded-pass (mocked CI); packaged check pending | | | |

Closing a row: paste numbers into the `docs/performance.md` tables, update this table's `docStatus`, mark the `docs/FEATURES.md` §24 (:292–300) cell; when every non-Windows row reads `measured`, :190 and :206 get rewritten.
