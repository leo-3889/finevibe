# Packaged gates run sheet — CI-built artifacts, no tag, no push

Why this exists: this dev host cannot produce packaged artifacts —
`electron-builder --dir` fails at the node-pty native rebuild (VS C++ toolchain
absent, `vswhere` not found) and, with `npmRebuild=false`, at extracting
`winCodeSign` (symlink privilege / Developer Mode not granted). Both rows are
documented in [docs/packaging.md](../docs/packaging.md) ("Verifying a Windows
build (host prerequisites)", observed 2026-10-21) and the evidence row in
[docs/AUDIT_STATUS.md](../docs/AUDIT_STATUS.md) ("Packaged smoke — BLOCKED ON
THIS HOST", salvage section 2026-10-21). The gates below must therefore run on
**CI-built artifacts** installed on second hosts (Windows desktop, Ubuntu,
macOS), triggered on demand from any machine with `gh`.

Gates in scope:

1. **S1–S6 packaged live-run protocol** — [docs/performance.md](../docs/performance.md) §"Measurement protocol for the live run" (status rows at :190, :206, :218).
2. **userData migration E2E** — packaged installer crossing the vibeyard→finevibe cutover ([src/main/userdata-migration.ts](../src/main/userdata-migration.ts)).
3. **PO-06 live watcher cost** — [docs/AUDIT_STATUS.md](../docs/AUDIT_STATUS.md) open item 4.
4. Clipboard per-OS runtime rows — pointer only; owned by [todos/archives/clipboard-paste-latency-plan.md](archives/clipboard-paste-latency-plan.md) §8 and the `performance.md:206` row.

---

## 1. Trigger the dispatch build (no version tag, no push)

The `Release` workflow (`.github/workflows/release.yml`) gained an
**artifacts-only dispatch mode**: `artifacts_only=true` builds the full matrix
from `ref` and publishes nothing.

Prerequisites (owner actions, outside this sheet):

- The workflow edit carrying `artifacts_only` exists on the ref you dispatch
  (check: `gh workflow view release.yml --repo leo-3889/finevibe` shows the
  `artifacts_only` input).
- `gh auth status` → account `leo-3889`.

Trigger (run from anywhere, no checkout needed):

```bash
gh workflow run release.yml --repo leo-3889/finevibe \
  --ref rebuild \
  -f artifacts_only=true -f ref=rebuild -f version=patch
```

- `--ref` selects where the **workflow file** is read from.
- `-f ref=rebuild` is the **source ref to build** (the artifacts-only input;
  any branch/tag/SHA).
- `version` is a required input with no effect in artifacts mode (the bump step
  is skipped); pass `patch`.

Watch and confirm the run shape:

```bash
gh run list --repo leo-3889/finevibe --workflow release.yml --limit 3
gh run watch <run-id> --repo leo-3889/finevibe
```

**Expected observations** (each is a publish-safety assertion):

- [ ] `prepare` runs: checkout (of `ref`), `npm ci`, `Run tests`,
      `Extract version` green; these 12 steps show as **skipped**: Install
      Claude Code CLI, Configure git identity, Bump version, Generate changelog
      via Claude Code, Verify changelog, Extract release notes, Upload release
      notes, Commit release, Create annotated tag, Get tag name, Verify tag
      exists, Push commit and tag.
- [ ] `build` (macos-latest, dmg+zip arm64+x64), `build-linux` (ubuntu-latest,
      AppImage+deb x64), `build-windows` (windows-2022, NSIS+portable+zip x64)
      all green. Every build step runs `npx electron-builder ... --publish never`
      (P1-8); CI's own integrity gates run inside them: codesign deep verify
      (macOS, notarization checks only when `APPLE_ID` is configured),
      `dpkg-deb --info/--contents` + AppImage ELF magic (Linux), exe icon
      opaque-mean + `ProductName=FineVibe` version resources (Windows).
- [ ] `publish` and `publish-npm` show as **skipped** (job-level
      `if: inputs.artifacts_only != true`).
- [ ] `gh release list --repo leo-3889/finevibe` — release count unchanged
      after the run.
- [ ] No new tag: `git ls-remote --tags https://github.com/leo-3889/finevibe 'v*'`
      matches the pre-run list (record it before dispatch).

Why dispatch cannot publish: the three builds ship
`--publish never`; the tag/push steps and both publish jobs are gated; the
workflow **never sets `FINEVIBE_RELEASE_REPO`** (grep of
`.github/workflows/` finds it nowhere), and per
[src/main/auto-updater.ts](../src/main/auto-updater.ts) (`resolveReleaseRepo`,
:36-40) and [bin/finevibe.js](../bin/finevibe.js) (:30-33) an unset value means
the installed artifact has **no release feed at all** — the auto-updater
disables itself with a warning and the npm launcher refuses to download. A
gate build can neither write a release nor pull from one.

## 2. Download the artifact set

```bash
mkdir -p artifacts && cd artifacts
gh run download <run-id> --repo leo-3889/finevibe --name release-windows --dir windows
gh run download <run-id> --repo leo-3889/finevibe --name release-linux  --dir linux
gh run download <run-id> --repo leo-3889/finevibe --name release-macos  --dir macos
find . -type f -exec sha256sum {} \; | tee SHA256SUMS-gate.txt
```

Expected contents (names from `package.json` `build.*.artifactName`, current
version `0.3.9-dev`; a `-dev` suffix normalizes to `~dev` inside the deb
control metadata, packaging.md §Artifact matrix):

| Artifact set | Files |
| --- | --- |
| `windows` | `FineVibe-Setup-0.3.9-dev.exe` (NSIS), `FineVibe-0.3.9-dev.exe` (portable), `FineVibe-0.3.9-dev-win-x64.zip`, `latest.yml`, `.blockmap` |
| `linux` | `FineVibe-0.3.9-dev-linux-amd64.deb`, `FineVibe-0.3.9-dev-linux-amd64.AppImage`, `latest-linux.yml`, `.blockmap` |
| `macos` | dmg + zip for **arm64 and x64** (electron-builder default names, no `mac.artifactName` override), `latest-mac.yml`, `.blockmap` |

- [ ] `sha256sum` recorded in `SHA256SUMS-gate.txt`; the same hashes re-verified
      on the second host after transfer (`sha256sum -c`). (The release
      `SHA256SUMS.txt` is minted by the `publish` job only — it does not exist
      in artifacts mode, hence this manual pair.)
- [ ] deb sanity (packaging.md §Verifying a deb): `dpkg-deb --info`,
      `dpkg-deb --contents … | grep -E 'pty\.node|better_sqlite3'`, and
      `file` on the unpacked `pty.node` → `ELF 64-bit LSB shared object`.
- [ ] Install: Windows per-user NSIS default → `%LOCALAPPDATA%\Programs\FineVibe\FineVibe.exe`;
      Ubuntu `sudo apt install ./FineVibe-0.3.9-dev-linux-amd64.deb`;
      macOS mount dmg, drag to `/Applications`.
      Smoke: launch and open one terminal (PTY) session — `--version` over
      headless SSH core-dumps by design (packaging.md).

## 3. Gate: S1–S6 packaged live-run protocol

Protocol quoted from [docs/performance.md:210](../docs/performance.md) (the
protocol is the whole paragraph; pass criteria are its last sentence):

> The static audit defines what the numbers must confirm. Launch with
> `--js-flags="--expose-gc"`; sample `process.memoryUsage()` (main, via
> `--inspect`) and `Get-Process FineVibe` working set (PowerShell, 60 s
> cadence, per-process rows) plus heap snapshots. Scenarios: **S1** 10 idle
> tabs → expect ≈ +0.2–0.4 MB/tab renderer, flat main; **S2** a ~100 MB output
> burst → renderer plateaus at scrollback capacity, main heap must not scale
> with the burst; **S3** 1 h idle with 10 live PTYs → growth < 5 MB/h (a linear
> rise implicates the 2 s pollers' per-file maps, `lastMtimes` first); **S4**
> open 50 sessions and close all → retained `Terminal`/`TranscriptSyncEntry`/
> reader counts return to baseline; **S5** state seeded with 5,000 history rows
      type=$(if ($_.CommandLine -match '--type=(\w+)') {$Matches[1]} else {'main'});
> sidecar → the main heap transient equals the buffered sidecar bytes (and
> collapses to chunk size once streaming lands). Record CSVs and snapshots
> under `bench/memory/<date>/`. Pass criteria: S3 < 5 MB/h, S4 within 10% of
> baseline, per-tab renderer cost within 2× the 240 KB estimate, S5 < 250 ms.

Launch (packaged Windows; kill all `FineVibe` processes first — migration and
single-instance logic run on the winner, `src/main/main.ts:233-250`):

```powershell
& "$env:LOCALAPPDATA\Programs\FineVibe\FineVibe.exe" `
  --js-flags="--expose-gc" --inspect=127.0.0.1:9229 --remote-debugging-port=9222
```

`--inspect` = main-process heap (`process.memoryUsage()`, DevTools heap
snapshots); `--remote-debugging-port` = renderer snapshots via
`chrome://inspect`. Working-set sampler (60 s cadence, per-process rows,
main vs renderers identified via `Win32_Process.ParentProcessId`):

```powershell
while ($true) {
  Get-CimInstance Win32_Process -Filter "Name='FineVibe.exe'" | ForEach-Object {
    $p = Get-Process -Id $_.ProcessId
    [pscustomobject]@{ ts=(Get-Date -Format s); pid=$_.ProcessId; ppid=$_.ParentProcessId;
      type=(if ($_.CommandLine -match '--type=(\w+)') {$Matches[1]} else {'main'});
      wsMB=[math]::Round($p.WorkingSet64/1MB,1); handles=$p.HandleCount }
  } | Export-Csv -Append -NoTypeInformation ws-samples.csv
  Start-Sleep 60
}
```

Scenario rows (record every row; a scenario run on Linux/macOS uses
`ps -o pid,ppid,rss` + the same snapshots):

- [ ] **S1** 10 idle tabs (10 project-shell sessions, idle): per-tab renderer
      working-set delta; expect ≈ +0.2–0.4 MB/tab, main flat. Pass: within 2×
      the 240 KB estimate.
- [ ] **S2** ~100 MB output burst in one pane (`fsutil file createnew
      burst.bin 104857600` then `type burst.bin`): renderer plateaus at
      scrollback capacity (xterm default 1000 lines); main heap must not scale
      with the burst.
- [ ] **S3** 1 h idle, 10 live PTYs (10 sessions each running e.g.
      `ping -t 127.0.0.1`): growth < 5 MB/h. A linear rise implicates the 2 s
      pollers' per-file maps — `lastMtimes` in
      [src/main/hook-status.ts](../src/main/hook-status.ts) first; capture a
      main heap snapshot at t=0/t=60min to attribute it.
- [ ] **S4** open 50 sessions, close all: renderer heap snapshots
      (`chrome://inspect` → :9222 target) before/at-baseline/after close;
      retained `Terminal` / `TranscriptSyncEntry` / reader object counts back
      to baseline (±10%).
- [ ] **S5** seed 5,000 history rows with the app **closed** — the renderer
      state is `~/.finevibe/state.json`
      ([src/main/store.ts](../src/main/store.ts) `STATE_DIR`/`STATE_FILE`,
      :8-9): duplicate history entries in the JSON to ≥5,000 rows; launch,
      trigger one persist (any mutation, e.g. open/close a tab), time it.
      Expect < 250 ms; note the throttle semantics: mutations inside one 200 ms
      window coalesce to a single serialize + IPC — count one persist per
      burst, not per mutation (performance.md:216).
- [ ] **S6** export a session whose `.events` sidecar is ≥50 MB (sidecar
      suffixes + the PA-20 "uncapped on disk" note:
      [src/main/session-export.ts:188,198](../src/main/session-export.ts)) —
      grow one by running a chatty Pi/OMP session (per-launch session dir, see
      gate 5), then session → Export. Record the main-heap transient; today it
      is expected to equal the buffered sidecar bytes (≥50 MB spike); the
      target end-state is a chunk-sized transient once streaming lands.

**Record** CSVs + snapshots under `bench/memory/<date>/` (protocol requirement).

## 4. Gate: userData migration E2E (packaged installer)

Subject: [src/main/userdata-migration.ts](../src/main/userdata-migration.ts),
wired first in `startMainProcess` (single-instance winner, ahead of any
userData read — `src/main/main.ts:233-250`). Mirrors the 7 cases of
[userdata-migration.test.ts](../src/main/userdata-migration.test.ts). Contract
(module header :14-24): **copy-only** (legacy trees never deleted),
**destination wins** (an existing file is never overwritten), stale
`Partitions/vibeyard-browser-iso-*` / `vibeyard-browser-*` prefixes are
**purged-not-copied**, symlinks never followed, per-file failures logged and
re-attempted next launch, `.finevibe-migrated` marker **only** on a fully
clean pass. Source → destination: `~/.vibeyard` → `~/.finevibe`;
`<appData>/Vibeyard|vibeyard` → the current userData dir (`<appData>/FineVibe`
packaged). `<appData>` per OS: Windows `%APPDATA%`; Linux `~/.config`; macOS
`~/Library/Application Support`.

Steps (packaged Windows; repeat the home-tree rows on Linux/macOS):

- [ ] Close FineVibe completely (all `FineVibe.exe` processes).
- [ ] Seed the legacy layout:

```powershell
$ad  = Join-Path $env:APPDATA 'Vibeyard'
$h0  = Join-Path $env:USERPROFILE '.vibeyard'
ni -Force "$ad\Partitions\vibeyard-browser-iso-old" | Out-Null
sc "$ad\Local State" 'legacy-appdata'
sc "$ad\probe-cache.json" 'legacy-probe'
sc "$ad\Partitions\vibeyard-browser-iso-old\data" 'stale-partition'
ni -Force "$h0\profiles\work" | Out-Null
sc "$h0\state.json" '{"projects":["legacy-project"]}'
sc "$h0\profiles\work\mcp.json" '{"mcpServers":{}}'
# destination-wins fixture: a NEWER state.json already at the destination
ni -Force "$env:USERPROFILE\.finevibe" | Out-Null
sc "$env:USERPROFILE\.finevibe\state.json" '{"projects":["new"]}'
# baseline hashes of the legacy trees (proves copy-only)
gi -R $ad,$h0 | Get-FileHash | Export-Csv legacy-before.csv
```

- [ ] Launch once from a console, capturing the main-process log
      (Electron attaches to the parent console; the migration logs
      `[userdata-migration] home N copied / N kept; userData N copied / N kept / N stale partitions purged`
      — `main.ts:241-246`):

```powershell
& "$env:LOCALAPPDATA\Programs\FineVibe\FineVibe.exe" > migration.log 2>&1
```

- [ ] Verify each contract row:

| # | Check | Command / evidence | Expected |
| --- | --- | --- | --- |
| M1 | copy-only | `gi -R $ad,$h0 \| Get-FileHash` re-export, diff vs `legacy-before.csv` | legacy trees byte-identical, nothing deleted |
| M2 | dest wins | `gc "$env:USERPROFILE\.finevibe\state.json"` | `{"projects":["new"]}` (legacy content NOT copied over it; marker shows `skipped=1` for it) |
| M3 | home copy | `gc "$env:USERPROFILE\.finevibe\profiles\work\mcp.json"` | copied verbatim |
| M4 | stale partition purged | `test-path "$env:APPDATA\FineVibe\Partitions\vibeyard-browser-iso-old"` | `False` (purged, not copied; marker `purged=1`) |
| M5 | userData copy | `gc "$env:APPDATA\FineVibe\probe-cache.json"` | `legacy-probe` |
| M6 | marker on clean pass | `gc "$env:USERPROFILE\.finevibe\.finevibe-migrated"` and same file in `%APPDATA%\FineVibe` | `migrated from … copied=/skipped=/purged=` counts matching M2–M5 |
| M7 | idempotent | add `$h0\late.json`, relaunch | `late.json` NOT copied (marker short-circuits the re-walk; test :87-93) |
| M8 | locked-file degrades | close app; lock a legacy file: `[IO.File]::Open("$h0\profiles\work\mcp.json",'Open','ReadWrite','None')` in a held session; relaunch | log shows `1 FAILED`; **no** home marker; unlock, relaunch → file copied, marker written (test :118-121; "graceful degradation on a locked directory (observed live)", AUDIT_STATUS.md:183) |

## 5. Gate: PO-06 live watcher cost

Open item: [docs/AUDIT_STATUS.md](../docs/AUDIT_STATUS.md) "Measure and reduce
remaining watcher cost (PO-06)" — *real main-thread delay, RSS, and
watcher-handle counts have not been measured at increasing tab/history sizes*
(sweep sizes 1 / 10 / 50 / 200, per the team-audit plan §"PO-06 (mandatory,
first)").

Where the cost lives and where it is logged — verified against the modules:

- [src/main/pi-compatible-session-watcher.ts](../src/main/pi-compatible-session-watcher.ts):
  registration forces a synchronous listing — `fs.statSync(dir)` (:150) then
  `fs.readdirSync(dir)` (:153) generation snapshot; one non-recursive
  `fs.watch` per exclusive session dir (:403); event scans coalesce at
  `SCAN_DEBOUNCE_MS = 250` / `SCAN_MIN_SPACING_MS = 1_000`; the correctness
  poll is `POLL_INTERVAL_MS = 2_000` (`setInterval` :392-396).
- [src/main/codex-session-watcher.ts](../src/main/codex-session-watcher.ts):
  root `~/.codex/sessions` (`SESSIONS_ROOT` :23), day-dir `statSync`/
  `readdirSync` walk with a `.jsonl.zst` meta scan (:304-325, cap
  `MAX_COMPRESSED_META_FILE_BYTES` :230); same 1 s event floor (:387-388) and
  2 s polling fallback (:513-517); non-recursive dir watchers (:427) /
  recursive root watcher on macOS+Windows, one-inotify-per-dir on Linux
  (S2-05, :474-501).
- **No in-app instrumentation exists** for watchers (verified: no timing flag
  in either module; the clipboard `FINEVIBE_CLIPBOARD_TIMING` flag does not
  cover them). The only watcher log is `[codex-watcher] sessions dir watch
  failed; relying on polling` (:432, :501) — if it appears, polling carries all
  the cost. Measurement is therefore external: process sampling + main-process
  inspector, per the S-protocol launch flags above.

Measure (Windows rows; Linux/macOS equivalents noted):

- [ ] Identify processes: `Get-CimInstance Win32_Process -Filter
      "Name='FineVibe.exe'" | Select ProcessId,ParentProcessId,CommandLine` —
      the row whose CommandLine has no `--type=` is main.
- [ ] Event-loop delay probe in the **main** inspector
      (chrome://inspect → `inspect=…:9229` target):
      `(function tick(p){setTimeout(()=>{const n=Date.now();console.log('[ev-delay]',n-p-100);tick(n)},100)})(Date.now())`
      — log p50/max drift.
- [ ] Sweep tab sizes **1 / 10 / 50 / 200** Pi/OMP sessions (each registers a
      pending watcher on launch; per-launch exclusive session dir): at each
      size record main RSS delta, `Get-Process FineVibe` `HandleCount` delta
      (expect ≈ +1 `fs.watch` handle per session dir; Linux:
      `ls /proc/<pid>/fd -l | grep -c inotify`), `[ev-delay]` p50/max, and the
      tab-open delay window (the synchronous registration listing; W2 harness
      floor p50 5.1–8.5 ms per registration, performance.md:115).
- [ ] History sweep 1 / 10 / 50 / 200 sessions' worth of transcript files
      under the Pi/OMP sessions roots: idle scan CPU (main inspector CPU
      profile, 60 s window) at the 2 s cadence.
- [ ] Codex: with live Codex sessions, seed `~/.codex/sessions/YYYY/MM/DD`
      trees (10 day dirs; optionally the adversarial growing `.jsonl.zst`
      fixture — W2 row: 176.3 ms p50 per 2 s scan, +108 MB RSS over 10 scans,
      performance.md:116) and record the same triple (delay, RSS, handles).
- [ ] Record the pass/fail call: PO-06 is "measured" once each size row has
      live-app numbers; reducing cost is a follow-up decision, not this gate.

## 6. Where to record results

| Result | Raw data | Status rows to flip (owned by the coordinator) |
| --- | --- | --- |
| S1–S6 | `bench/memory/<date>/` CSVs + heap snapshots (protocol requirement, performance.md:210) | [docs/performance.md](../docs/performance.md) :218 "Still needed: run the measurement protocol above (S1–S6) in a packaged app…" → replace with the dated outcome; coverage row :190 for the per-OS clipboard tables; protocol pass-criteria paragraph :210 gets a "measured" note |
| Migration E2E | this sheet's M1–M8 table + `migration.log`, `SHA256SUMS-gate.txt` | [docs/AUDIT_STATUS.md](../docs/AUDIT_STATUS.md) :183 row ends "Remaining live check: the packaged-installer E2E of the copy (build-host gated…)" → dated outcome; `todos/PENDING.md` §3 row "S1–S6 packaged live-run protocol" |
| PO-06 | this sheet's size-sweep table + CSVs | add **live-app rows** to the docs/performance.md measurement table (:114-119; those rows are harness floors) and retire the caveat at :126-129 "**PO-06 stays open**"; close AUDIT_STATUS open item 4 (:120) |
| Clipboard per-OS rows (P4 <50 ms freeze, P5 ≥5× echo reduction, Explorer/Finder/Nautilus, middle-click, Wayland) | `dev/perf/clipboard-bench.js` / `dev/perf/pty-paste-probe.js` output | [docs/performance.md](../docs/performance.md) :206 "Pending runtime checks… packaged Windows" + plan §8 platform gate — runbook owned by [todos/archives/clipboard-paste-latency-plan.md](archives/clipboard-paste-latency-plan.md); this sheet only supplies the artifact + `SHA256SUMS-gate.txt` |

`docs/AUDIT_STATUS.md` and `todos/PENDING.md` are coordinator-owned; record the
outcome in this sheet's log below and hand the coordinator the run id + date.

## Result log

| run id | ref / sha | host (OS build) | artifact set + sha256 (short) | S1 | S2 | S3 | S4 | S5 | S6 | M1–M8 | PO-06 | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |  |  |  |
