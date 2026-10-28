# dev/perf harnesses

Manual performance probes for clipboard/PTY latency. Nothing here ships in the
app; wave 3 wires selected harnesses into CI (`perf.yml`) by grepping
`METRIC name=value` lines from stdout.

## Conventions — REQUIRED for every new harness

- Scratch MUST live in a per-run temp dir: `fs.mkdtempSync(path.join(os.tmpdir(),
  'finevibe-bench-'))` in JS, or a GUID-named dir under `%TEMP%` in PowerShell
  (`param([string]$TmpDir = (Join-Path $env:TEMP ('finevibe-bench-' +
  [guid]::NewGuid().ToString('N'))))`). Fixed shared `%TEMP%` paths are NEVER
  allowed: parallel runs must not collide and leftovers must not accumulate.
- Cleanup MUST be registered: JS `process.on('exit')` plus `SIGINT`/`SIGTERM` →
  `fs.rmSync(dir, { recursive: true, force: true })`; PowerShell
  `try { ... } finally { Remove-Item -LiteralPath $TmpDir -Recurse -Force }`.
- Results (JSON/CSV) are written inside the scratch dir and their absolute
  paths printed at the end. Results are NEVER committed into the repo.
- Measured numbers MUST also be printed on stdout as `METRIC name=value` lines,
  one per metric — the wave-3 CI workflow greps exactly these.

## Harnesses

### clipboard-bench.js

Electron main + hidden window; times every `clipboard:readForPaste` sub-op
(`src/main/ipc-handlers.ts`) per scenario, p50/max over 11 passes.

```
npx electron dev/perf/clipboard-bench.js [--smoke]
```

Prints `RESULTS_JSON=<abs path>` (inside the scratch dir, removed on exit).

### pty-paste-probe.js

Plain node + node-pty, no Electron. Leg A: ConPTY per-byte echo drain
(write-returns ms, drain ms, chunk sizes). Leg B: omp child under a pty,
write→first-chunk and write→marker latency.

```
node dev/perf/pty-paste-probe.js
```

Prints `PTY_PROBE_JSON=<abs path>` (inside the scratch dir, removed on exit).

### clipbench.ps1

Raw Win32 clipboard contention cross-check: spawns `hold.ps1` as a 2.5s
clipboard holder, then replays the app's 5×5ms retry pattern plus a
100ms/4000ms time-to-acquire quantification loop. Must run from an interactive
desktop session.

```
powershell -NoProfile -ExecutionPolicy Bypass -File dev/perf/clipbench.ps1 [-TmpDir <dir>]
```

Scratch (fixture files + holder flag) defaults to a fresh
`%TEMP%\finevibe-bench-<guid>` dir, removed recursively on exit.

### hold.ps1

Clipboard-holder primitive used by `clipbench.ps1` (modelling
rdprclip.exe-style contention); usable standalone:

```
powershell -NoProfile -ExecutionPolicy Bypass -File dev/perf/hold.ps1 -Ms 2500 -Flag <sentinel-path>
```

Writes no fixed temp paths — the only artifact is the caller-supplied `-Flag`
sentinel, removed on release (guaranteed by a `finally`).

## Periodic perf harnesses

Rebuilt W2 harnesses (B4) run in CI via
[.github/workflows/perf.yml](../../.github/workflows/perf.yml): weekly cron
Mon 03:00 UTC + manual dispatch (`quick` input). `windows-latest` (RSS
fidelity via `Get-CimInstance` tree sampling), builds the app, runs every
harness with `continue-on-error: true` — weekly signal, not a gate — and
uploads CSV/JSON from `bench/perf/<run-id>/` as an artifact.

All four are plain-node scripts that spawn the built app (`npm run build`
required; they fail fast, exit 2, when `dist/main/main/main.js` is missing)
with a throwaway `--user-data-dir` inside the per-run mkdtemp scratch, so
real user data is NEVER touched. macOS/Linux fall back to `ps -o rss=`
tree sampling (best effort).

| Harness | METRIC lines | Threshold | Invocation |
| --- | --- | --- | --- |
| `s3-idle-growth.js` | `idle_growth_mb_per_h`, `rss_start_mb`, `rss_end_mb`, `sample_count` | S3 < 5 MB/h (docs/performance.md): exit 1 only with `--fail-threshold` (CI default off) | `node dev/perf/s3-idle-growth.js [--quick] [--minutes=N] [--interval=S] [--fail-threshold] [--out DIR]` |
| `po06-watcher-cost.js` | `rss_mb`, `watcher_handles`, `tree_procs` | none (baseline) | `node dev/perf/po06-watcher-cost.js [--quick] [--warmup=MS] [--samples=N] [--out DIR]` |
| `f2-codex-spike.js` | `codex_spike_mb`, `rss_peak_mb`, `codex_scan_replica_p50_ms`, `rollouts_total` | none | `node dev/perf/f2-codex-spike.js [--quick] [--cycles=N] [--out DIR]` |
| `f3-pi-tick.js` | `pi_tick_p50_ms`, `rss_mb`, `pi_session_dirs` | none | `node dev/perf/f3-pi-tick.js [--quick] [--sessions=N] [--reps=M] [--out DIR]` |

`--out DIR` writes CSV/JSON under `DIR` (CI uses `bench/perf/<run-id>/<harness>/`,
uploaded as the `perf-results-<run-id>` artifact); without it results stay in
the scratch dir and are removed on exit. Paths print as `RESULTS_CSV=` /
`RESULTS_JSON=`.

### Limitations — honest labels

- **PO-06 partial.** `po06` measures the launched app's RSS + main-process
  handle baseline with NO projects registered. The registered-projects
  handle delta needs in-app registration (renderer IPC, not reachable
  externally) and main-thread event-loop lag needs `--inspect` inside the
  app — follow-up, not faked here.
- **F2 scan gating.** In-app Codex scans early-return with no pending Codex
  tab (`src/main/codex-session-watcher.ts:275`, poll gate `:514`) and an
  external harness cannot register tabs. `codex_spike_mb` is therefore a
  LOWER bound (watcher arms on the fixture, scan body idles);
  `codex_scan_replica_p50_ms` is a filesystem-side replica of one scan tick
  (name-pruned tree walk + 64 KB `session_meta` head read per rollout) —
  **[estimated]**, not app-measured.
- **F3 estimated.** The in-app Pi scan is registration-gated
  (`src/main/pi-compatible-session-watcher.ts:235`, poll `:392`) and
  main-side tick wall-time is not externally observable (no per-tick
  sidecar touch; NTFS suppresses last-access updates). `pi_tick_p50_ms` is
  a filesystem-side replica of the tick's syscalls (200 × per-dir readdir +
  newest-file header read: open + 8 KiB + JSON.parse) — **[estimated]**.
- F2 redirects only the spawned app's `HOME`/`USERPROFILE` into the scratch
  fixture (fixture layout per the watcher: `sessions/YYYY/MM/DD/
  rollout-<ts>-<id>.jsonl[.zst]`, `session_meta` first line); the real
  `~/.codex` is never read and fixtures are never committed.
