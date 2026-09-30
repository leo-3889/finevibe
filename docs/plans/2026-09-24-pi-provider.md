# Plan: Pi as a Backend Provider

> Historical design record. Pi is registered in `src/main/providers/registry.ts` and has provider and transcript-watcher tests. The CLI facts below were observed with Pi 0.83.0 and may differ in later versions. For current contracts see [provider contracts](../provider-contracts.md) and [session lifecycle](../session-lifecycle.md). Live authenticated Pi startup and resume remain in the [runtime verification list](../AUDIT_STATUS.md).

**Date:** 2026-09-24 · **Status:** implemented — shipped with per-tool profile support, polled session status, and OMP added alongside

## Goal

Add Pi (the `pi` CLI from `@earendil-works/pi-coding-agent`, pi-mono) as a fifth CLI
backend alongside claude / codex / copilot / gemini, using the existing `CliProvider`
abstraction. No new UI: the provider list is data-driven from `getAllProviderMetas()`
(IPC at `ipc-handlers.ts:347`), so registering a provider is enough for it to appear
in the New Session dialog, project settings, and resume menus.

## Pi CLI facts (verified against a local install, pi 0.83.0)

| Concern | Fact |
|---|---|
| Binary | `pi` (npm: `@earendil-works/pi-coding-agent`) |
| Config dir | `~/.pi/agent`; override env **`PI_CODING_AGENT_DIR`** → profiles work |
| Sessions | `~/.pi/agent/sessions/<cwd-with-seps-as-dashes>/` (e.g. `C:\Users\Leo` → `--C--Users-Leo--`), files `<ISO-timestamp>_<uuid>.jsonl` |
| Transcript format | JSON Lines; first line `{"type":"session","version":3,"id":"<uuid>","timestamp","cwd"}`; message lines carry `message: { role, content }` where content is a string or `[{type:'text', text}]` blocks; a `session_info` line may carry `name` |
| Resume | `--session <path\|id>` (exact/partial id; workspace searched first) |
| Initial prompt | positional `message` arg |
| System prompt | `--append-system-prompt <text\|path>` (repeatable) |
| Print mode | `-p/--print` (one-shot, prints final output); `--no-session` = ephemeral |
| Hooks / status line | **none** — no PostToolUse-style hooks, no cost/context reporting |
| Plan mode | no flag → `planModeArg` omitted |
| `settings.json` | minimal: `quietStartup`, `theme`, `defaultThinkingLevel`, `lastChangelogVersion` — no model/provider (those live in `models-store.json` / `auth.json`) |

## Changes

### 1. `src/shared/types.ts`
- `ProviderId` union: add `'pi'`.

### 2. `src/main/providers/pi-provider.ts` (new)
`PiProvider implements CliProvider`, modeled on `GeminiProvider` (the simplest full
provider) with no-ops where Pi has no counterpart:

- **meta** — `id: 'pi'`, `displayName: 'Pi'`, `binaryName: 'pi'`,
  capabilities: `sessionResume: true`, `costTracking: false`, `contextWindow: false`,
  `hookStatus: false`, `configReading: true`, `shiftEnterNewline: false`,
  `pendingPromptTrigger: 'startup-arg'`, `systemPromptInjection: true`;
  `defaultContextWindowSize: 200_000`.
- **resolveBinaryPath / validatePrerequisites** — `resolveBinary('pi', cache)` /
  `validateBinaryExists('pi')` (same `binaryCache` pattern as the others).
- **buildEnv** — `PATH = getFullPath()`; when `opts.configDir` is set, set
  `PI_CODING_AGENT_DIR = configDir` (this is Pi's equivalent of `CLAUDE_CONFIG_DIR` —
  it relocates the whole agent dir, so profiles/multi-login work for free).
- **buildArgs** — resume → `--session <cliSessionId>`; `extraArgs` split on whitespace;
  `initialPrompt` as positional; `systemPrompt` → `--append-system-prompt <text>`.
- **installHooks / installStatusScripts / cleanup / reinstallSettings** — no-ops
  (Pi has no hook system; nothing to install or tear down).
- **getShiftEnterSequence** — `null`.
- **validateSettings** — `{ ok: true }` (nothing to validate).
- **getConfig** — read `settings.json` under the agent dir (`~/.pi/agent` or
  `PI_CODING_AGENT_DIR`); verified shape is minimal (`theme`, `quietStartup`,
  `defaultThinkingLevel`) — surface what's there, fall back to an empty
  `ProviderConfig` when the file is missing.
- **Transcript support** (global search + resume hand-off):
  - `getTranscriptPath(cliSessionId, projectPath, configDir?)` — walk
    `<agentDir>/sessions/**` for `.jsonl`, read the first line, match `id`
    (and prefer `cwd === projectPath`).
  - `discoverTranscripts()` — same walk, emit `{ cliSessionId, transcriptPath,
    projectCwd }` from the first line.
  - `indexTranscript(transcriptPath)` — parse JSONL, collect `user` message text up
    to `MAX_INDEX_CHARS_PER_SESSION`, join with `TRANSCRIPT_TEXT_SEPARATOR`
    (reuse `transcript-utils.ts`).
- **Agent files** — omit `agentsDir`/`installAgent`/`removeAgent` (Pi's extension
  model differs; the interface methods are optional).

### 3. `src/main/providers/registry.ts`
- `initProviders()`: `registerProvider(new PiProvider())`.

### 4. Tests
- `pi-provider.test.ts` — `buildArgs` (fresh / resume / extraArgs / initialPrompt /
  systemPrompt), `buildEnv` (with and without `configDir`), meta shape.
- `pi-provider.search.test.ts` — `getTranscriptPath` / `discoverTranscripts` /
  `indexTranscript` against a temp sessions tree (first-line session record +
  message lines).

### 5. Not in scope
- Readiness checkers (gemini has them; Pi gets none initially).
- Config watcher, cost tracking, context meter, session auto-naming (no live source
  in Pi; Pi has no statusLine equivalent).
- New Preferences option — none needed; provider choice and `defaultProvider`
  already cover it.

## Verification

1. `npm test` — full suite green, including the two new test files.
2. `npm run build` — all three targets compile.
3. Manual (against pi 0.83.0): open a Pi session in a project, confirm PTY spawn,
   resume from history, and a global-search hit on a Pi transcript.

## Risks / open questions

- **`pi` must be resolvable on `PATH`.** `resolveBinary('pi')` searches PATH, so if
  the binary exists only as a nested dependency of another package,
  `validatePrerequisites()` returns false and the provider stays hidden. Installing
  it globally (`npm install -g @earendil-works/pi-coding-agent`) puts `pi` in the
  npm global bin directory, which is already on PATH.
- **Model and provider selection are Pi's own concern**, passed through via
  `--provider` / `--model` extra args. Vibeyard never chooses them — which matters for
  any future feature that spends tokens on the user's behalf.
