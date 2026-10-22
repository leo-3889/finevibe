# Wave F audit — 2026-10-22 (post-Wave-E re-audit)

Loop: 4 read-only scouts over the `b4c0721` tree → parent verifies every
finding against source → fix agents (≤4) → integration gate
(`npx tsc -p tsconfig.main.json/preload/renderer --noEmit`, `npx vitest run`,
`git diff --check`) → commit. Scope: perf, leaks, races, bugs; NOT style/lint,
NOT rows already closed in `perf-audit-2026-10-21.md`.

Scout slices: S1 startup+main/store/IPC-surface, S2 watchers+transcripts+
providers+spawn, S3 renderer core+state+terminals+tab-bar, S4 UI+search+export.

## Findings ledger

| id | sev | file:line | mechanism | verdict | fix |
| --- | --- | --- | --- | --- | --- |

## Gate

- vitest:
- tsc (main/preload/renderer):
- git diff --check:
- commit:
