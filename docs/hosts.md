# Hosts (multi-host SSH)

FineVibe enrolls remote SSH hosts (Settings → Hosts) and runs interactive shells on them. Phase 1 is registry + enrollment + shell only; per-host provider launches are Phase 2 (`todos/features/per-host-providers-plan.md`, local-only).

## Registry

`HostRecord` (`src/shared/types.ts`) lives in `PersistedState.hosts` (`src/main/store.ts`). Every load path (`loadState`, `saveState`, `saveStateSync`, `defaultState`) normalizes the array through `validateHostRecordShape` (`src/shared/ssh-host.ts`): entries that are not objects, miss required fields, carry an out-of-range port, or hold a non-POSIX `defaultFolder` are dropped, never repaired. The renderer hydrates the same shape (`hydrateLoadedState`, `src/renderer/state/persistence.ts`) but never writes hosts directly — all mutations go through `hosts:*` IPC into `src/main/hosts/host-registry.ts` (create/update/delete; create honors a draft `id` so a pre-generated keypair directory matches its host).

Fields that matter: `authKind` (`key` | `password`), `managedKey` (FineVibe-generated pair under `<userData>/hosts/<id>/`), `hostFingerprint` (pinned SHA256 — enrollment requires a pin), `prerequisites` (last probe of remote coding-tool binaries), `defaultFolder` (POSIX path, the remote cwd for shells; default `~/.finevibe`), `enrollmentStatus` (`draft` → `probing` → `auth-ok` → `enrolled` | `partial` | `failed`).

## Enrollment lifecycle

`src/main/hosts/enrollment.ts`:

- `testHost` — connect + auth probe. First contact yields `newFingerprint`; the UI must show it and get explicit approval (`hosts:approveHostKey`) before anything is pinned. A pinned key that differs is `hostKeyChanged` — every later connect refuses (hard fail, no TOFU-retry).
- `enrollHost` — requires a pinned fingerprint. Steps: connect → env → key-deploy (managed key: append public key to remote `authorized_keys` via a marker block, idempotent) → prereqs (binary probe) → dirs (`mkdir -p defaultFolder`). A non-POSIX remote shell fails the record (R2: enrollment target is POSIX). Missing binaries land as `partial` with the per-binary report kept in `prerequisites`.
- `unenrollHost` — rewrites the remote `authorized_keys` removing only FineVibe's marker block, then deletes the managed keypair and keychain entries. Deletion of a host (`hosts:delete`) runs unenroll first for enrolled records (UI-ordered).
- Host hook merge (per-host providers T2) — enrollment merges FineVibe's status-writer hooks into each probed tool's `settings.json` (marker-scoped: every handler command carries `# finevibe-hook`, so merge is idempotent and unenroll strips exactly the block). Foreign keys/hooks survive *content*-identical; when the block changes, the whole file is re-serialized (2-space JSON + trailing newline), so duplicate keys collapse and escapes normalize — byte-identical only on the no-op paths. The `.bak` rule (T3) is the recovery story for a bad rewrite.

Status transitions push `hosts:status` events to all windows; the section re-renders from `hosts:list`.

## Secrets

`src/main/hosts/secrets.ts` wraps Electron `safeStorage`. Host passwords are stored under keychain key `<hostId>`, key passphrases under `keypass:<hostId>`. The IPC surface is write-only (`hosts:setSecret`, `hosts:forgetPassword`): no channel ever reads a secret back to the renderer; ssh-client pulls secrets in main only. `hosts:secretsAvailable` false (Linux without Secret Service) → the UI shows the R1 banner and key-auth-only guidance; enrollment with `password` auth degrades to prompting per session is NOT implemented — password auth without storage is refused.

## SSH transport

`src/main/hosts/ssh-client.ts` (ssh2). Connections are cached per host id in a FIFO-capped `Map` (`MAX_CACHED_CONNECTIONS`, allowlisted in `src/main/module-map-governance.test.ts`); `forceNew` evicts the exact entry. `hostVerifier` compares the server key against the pinned fingerprint and refuses on mismatch. Shell/PTY traffic for enrolled hosts goes through `spawnShellPty` (`src/main/pty-manager.ts`) spawning the local `ssh -tt -p <port> user@host` binary — the xterm pane and pty:data/pty:exit contract are unchanged; the renderer opens such a tab with `openRemoteShellTab` (`src/renderer/components/project-terminal.ts`), which Phase 1 scopes to the active project's terminal panel.

## Limits

Host name ≤ 64 chars; port 1-65535 (default 22); one password + one keypass per host; connection cache `MAX_CACHED_CONNECTIONS` (exported from `ssh-client.ts`). `defaultFolder` must be a POSIX path (a Windows target path is dropped at validation; Windows targets are R2).

## IPC surface

`hosts:list` `create` `update` `delete` `openShell` `secretsAvailable` `generateKey` `setSecret` `forgetPassword` `test` `approveHostKey` `enroll` `unenroll` `tools`, plus the pushed `hosts:status`. Secrets cross only into main. `hosts:openShell` requires an enrolled record and a fresh `sessionId` owned by the renderer shell pane.
