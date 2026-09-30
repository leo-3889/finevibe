# Vibeyard code audit — 2026-09-29

> Historical finding evidence. See [current audit status](docs/AUDIT_STATUS.md) for present disposition and open runtime verification.

Scope: current working tree, including pre-existing uncommitted changes. Reviewed the Electron main/preload/renderer boundaries, session watchers and transcript search, Git/file IPC, and existing tests. The findings below describe the state before the follow-up implementation.

## Implementation status

All 13 findings received code or test changes in the same working tree. Project file reads now check canonical targets and have an 8 MiB limit. Profile directories must be unique; default CLI sessions remove inherited profile directory overrides. Profiles that still have open or archived sessions cannot be deleted. PTY replacement suppresses the old process's exit callback, and the Codex history reader retains partial lines with bounded reads. Git porcelain paths, Pi/OMP re-adoption and exit status, transcript indexing limits, concurrency, and cache size were corrected. The broken test file and stale mocks were repaired.

After the changes: `npm run build` passed; main/preload/renderer TypeScript checks passed; Vitest reported **155 passed files, 2210 passed tests, 1 skipped**; `git diff --check` passed. The separately invoked `tsconfig.test.json` check still reports many test typing/target errors after the syntax error was removed; it is not part of the build script. The Electron app was not exercised manually.

Operational limits: file reads over 8 MiB return an error; a Codex history line over 1 MiB is discarded to bound memory; deleting a profile requires closing its sessions and removing its archived history first.

## Findings

### 1. [High] Project path checks follow links outside the allowed tree

`src/main/ipc-handlers.ts:39-41, 73-76, 782-793, 830-843` checks only the lexical result of `path.resolve`. A symlink or Windows junction inside a known project can point outside that project; `fs.openSync`, `fs.statSync`, and `fs.readFileSync` then follow it. The same issue affects `fs:listDir` and file enumeration paths. This defeats the stated project/config read boundary and can expose unrelated local files through the renderer IPC. Resolve the real filesystem target (including links in parent directories) before applying the allowlist, or explicitly reject links.

### 2. [High] The test suite does not pass, and one test file cannot parse

`src/main/hook-status.test.ts:619-632` contains a leftover test body without an `it(...)` opener. Both Vitest and `tsc -p tsconfig.test.json --noEmit` reject the file at line 681. The full Vitest run reported **7 failed files, 13 failed tests, 2143 passed, 1 skipped**. Type checks for the main, preload, and renderer projects passed. The broken test file removes all hook-status coverage from this run.

The remaining failures have test/implementation drift: Claude, Codex, Copilot, and Gemini search tests still mock `fs.promises.readFile`, while the indexers now use `stat` and `createReadStream` (`src/main/providers/claude-provider.search.test.ts:5-6, 108-135`; `src/main/providers/claude-provider.ts:172-185`, with the same pattern in the other three providers). Three Codex watcher tests mock `BrowserWindow.getAllWindows()` to always return `[]`, so the polling branch deliberately skips reading (`src/main/codex-session-watcher.test.ts:19`, `src/main/codex-session-watcher.ts:126-134`). The Pi-compatible freshness test at `src/main/pi-compatible-session-watcher.test.ts:331` expects an old external file to be opened, while the new scan floor excludes it before opening. These failures should not be read as proof that production transcript indexing or adoption is broken; they leave those paths insufficiently verified.

### 3. [High] Codex session IDs can be lost on a partial history write

`src/main/codex-session-watcher.ts:46-55` reads all newly appended bytes, sets `lastSize = stat.size`, and immediately splits/parses them as complete JSON lines. If the Codex process appends half a JSONL entry and flushes the rest later, the first half fails parsing and is permanently skipped; the next read begins after it and the second half also fails. The UI session can remain without a CLI session ID, impairing resume and transcript association. Keep an incomplete trailing line across reads and advance the committed offset only through complete lines. The same reader also allocates `stat.size - lastSize` without a cap, so a large history append can stall the main process.

### 4. [Medium] Pi/OMP `/clear` re-adoption fails when both files start in one second

`src/main/pi-compatible-session-watcher.ts:91-96` parses only whole seconds from the transcript filename. Pass 2 requires the candidate timestamp to be strictly greater than the adopted timestamp (`:315-321`). A genuine `/clear` that creates a second transcript within the same second as the first has an equal parsed timestamp and is never re-adopted. Preserve the filename's millisecond component or compare a higher-resolution value.

### 5. [Medium] Git panel misidentifies files with spaces and renames

`src/main/git-status.ts:149-175` parses porcelain-v2 records with `split(' ')` and takes the last token as the path. A tracked file such as `my notes.txt` is reported as `notes.txt`; stage/diff/discard then target the wrong path. For rename records, the code takes the tab-delimited original path as the new path. Conflict paths with spaces are similarly truncated. Parse the fixed number of porcelain-v2 metadata fields and keep the remainder as the path, using the first path in a rename record as the current path.

### 6. [Medium] Global session search starts unbounded transcript reads

`src/main/session-deep-search.ts:97-100` calls `Promise.all` across every discovered transcript. Each indexer may stat and open a stream, so a large multi-profile history can open hundreds or thousands of files at once, causing slow searches or file-descriptor exhaustion. `src/main/providers/transcript-utils.ts:20-22` defines a concurrency limit of four, but this call site does not use it.

### 7. [Medium] File reader can allocate an entire large file in the main process

`src/main/ipc-handlers.ts:782-808` reads the whole file synchronously after an 8 KB binary sniff and allocates `size - headBytes` without a maximum. A large text file, or a binary file with no NUL in its first 8 KB, can block Electron's main thread and consume substantial memory. The content is then copied again by `Buffer.concat` and UTF-8 conversion. Set a size limit or stream a bounded preview.

### 8. [Low] A trailing Pi/OMP `session_exit` reports an earlier status

`src/main/providers/pi-compatible-transcripts.ts:118-136` maps `session_exit` to `null`, but the reverse scan treats `null` as “keep looking” and returns an older `working`, `completed`, or `waiting` message. This contradicts the function comment and can leave a stale status visible if the PTY cleanup is delayed. Distinguish a terminal exit marker from an ignorable entry.

## Focused follow-up: session isolation, stability, and memory

### 9. [High] Default Claude sessions can inherit another profile's config directory

`src/main/pty-manager.ts:302-318` copies `process.env` into every PTY before calling `ClaudeProvider.buildEnv`. `src/main/providers/claude-provider.ts:78-86` sets `CLAUDE_CONFIG_DIR` only when a profile is pinned; it does not remove an inherited value for a default session. Launching Vibeyard from a shell with `CLAUDE_CONFIG_DIR` set therefore makes a UI session labeled/defaulted as unprofiled run against that other directory and its credentials, while transcript lookup still assumes `~/.claude` (`claude-provider.ts:150-155`). Pi and OMP explicitly remove the corresponding inherited `PI_CODING_AGENT_DIR` for default sessions. Clear the inherited Claude override when no profile is pinned.

### 10. [High] Distinct profiles may intentionally share one credential directory

`src/main/profiles.ts:92-116` rejects a config path only when the existing profile's **provider differs** from the new provider. Two Claude profiles, or two Pi/OMP profiles of the same provider, can be created with the same custom path. Both then share credentials, sessions, settings, and hooks despite appearing as separate profiles. The profile records have distinct IDs but no separate on-disk identity. Reject directory reuse by a different profile ID, including within one provider, unless the UI explicitly presents it as a shared profile.

### 11. [High] PTY re-spawn exit suppression is keyed to the UI ID, not the old process

On re-spawn, `src/main/pty-manager.ts:243-251` kills the old PTY and adds the **session ID** to `silencedExits`; `src/main/ipc-handlers.ts:196-207` consumes that marker on whichever exit callback arrives first. If the new PTY exits before the old kill callback, the new exit is silently ignored and the old exit unregisters the new session's transcript sync/status/discovery. If `kill()` emits its exit synchronously, the marker is installed too late and the same misclassification occurs. Suppression should be tied to the old PTY instance or exit callback, with registration established before an exit can fire. Current tests assert only a preselected callback order (`src/main/ipc-handlers.test.ts:209-230`).

### 12. [Medium] Removing a profile silently rebinds its saved sessions to a different account

`src/renderer/state.ts:636-649` clears the profile ID from both open sessions and archived history when a profile is deleted. Later resume resolves a missing profile ID to the provider default (`src/renderer/state.ts:788-807`). This means a conversation originally tied to one account can be resumed under another account's credentials, or fail to find its transcript, without retaining the original binding in history. Keep the historical profile identity or explicitly mark those sessions non-resumable after profile removal.

### 13. [High] The 50 KiB transcript search limit is not enforced before caching

`src/main/session-deep-search.ts:9, 23-42` keeps up to 500 indexed sessions, with both original and lowercased copies of each text. The stated per-session limit is 50 KiB (`src/main/providers/transcript-utils.ts:6`), but each indexer checks `totalChars` **before** appending a user message and then appends that entire message without truncation (for example, `src/main/providers/claude-provider.ts:188-204`; the same pattern exists in Codex, Copilot, Gemini, and Pi-compatible indexing). A single large user message can therefore contribute up to the 8 MiB JSONL read window, or a substantial part of a 64 MiB Gemini JSON file, to one cache entry. Both text copies and the concurrent indexing in finding 6 amplify the peak. Truncate each appended message to the remaining character budget and give the cache an aggregate size budget.

## Verification and limits

- `npx tsc -p tsconfig.main.json --noEmit`, preload, and renderer: passed.
- Before implementation, `npx tsc -p tsconfig.test.json --noEmit` failed with TS1128 at `src/main/hook-status.test.ts:681`.
- Before implementation, `npm test -- --reporter=dot` had 13 failures, 2143 passed, and 1 skipped. Initial sandbox run could not start Vite (`spawn EPERM`), so the test result came from an approved run outside the sandbox.
- Findings 1 and 3-8 are code-path analysis, not an end-to-end Electron reproduction. Finding 2 is directly reproduced by the commands above.
