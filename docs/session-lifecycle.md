# Session lifecycle

Hook inspector event ingestion is incremental: each turn reads at most 64 KiB, preserves partial JSONL records and UTF-8 bytes, and schedules further backlog reads. Individual records over 64 KiB are skipped. Renderer retention is bounded by both 2,000 events and 2 Mi characters per session. Closing a session cancels pending ingestion continuations and releases its reader state.

Pi/OMP discovery shares registration generations per sessions root rather than duplicating complete filename snapshots for each session. Registration still forces a fresh synchronous listing. During polling, directory listings are reused while mtimes are unchanged; rename events invalidate them, and a 30-second reconciliation refreshes them even after missed notifications. Two-second polling still checks for changes. Profile-root scoping and existing-file exclusion remain in force.

The renderer owns session records in `src/renderer/state.ts`; the main process owns PTYs. A non-shell CLI PTY exit destroys and removes its live session. `src/main/ipc-handlers.ts` owns replacement cleanup. The UI distinguishes active sessions, archived resumable sessions and history entries. State is saved to `~/.vibeyard/state.json` through an atomic temporary-file rename and flushed on quit.

Session activity changes on provider hook or transcript events. A completed event moves a linked Kanban task to Done. Closing or losing an unfinished session only clears its live `sessionId`; it does not complete the task. `board-session-sync.ts` resolves the owning project even while another project is selected.

An abnormal CLI exit (non-zero code) is annotated, not silent: for Pi/OMP the trailing `session_exit` transcript entry supplies the CLI's own reason (e.g. `unhandled_rejection`), other providers fall back to the exit code. The reason is persisted as `exitReason` on the archived session, raised as a desktop notification and badged in session history. A user-initiated close removes the session before its PTY exit arrives, so it is never reported as a crash.

Numbered default names come from `src/renderer/state/session-naming.ts`. Live provider titles are adopted by `src/renderer/session-title.ts` when automatic titles are enabled and the user has not renamed the session. There is no main-process one-shot naming service or fifth-prompt title pass.

`src/main/file-watcher.ts` watches file-tree and reader directories lazily, including the parent directory to survive atomic replacement. `src/main/git-watcher.ts` watches Git state separately, using recursive watching on Windows/macOS and capped per-directory watching on Linux. Hook `.events` reading advances its byte offset by bytes actually read, retains incomplete line bytes separately, and emits only complete parsed records. A size smaller than the offset resets the reader. See [performance and resource limits](performance.md) for exact bounds and oversized-record handling.
