---
name: import-legacy-settings
description: This skill MUST be used whenever the task involves recovering, importing, migrating, or restoring app settings/state from a previous Vibeyard install (or another FineVibe profile) — the ~/.vibeyard and ~/.finevibe folders, %APPDATA%/Vibeyard, state.json, profiles/, "bring over my old sessions/kanban/projects", "the import button shows nothing", or "the app lost my projects after the rename". Use when the user asks to "import my old settings", "migrate from vibeyard", "restore my sessions", "copy state.json", or "why is FineVibe empty".
---

# Legacy (Vibeyard) → FineVibe data recovery

FineVibe is the renamed Vibeyard app. Two trees changed identity and both carry user data:
the home data tree `~/.vibeyard` → `~/.finevibe`, and Electron userData
`%APPDATA%/Vibeyard` (packaged) / `%APPDATA%/vibeyard` (dev) → the current userData dir.

**The app ships the recovery machinery. Do not hand-copy files before you have checked
both of it** (this skill's pre-2026-10-23 version told agents to `cp state.json`, which
destroyed newer state — see Rule 0):

| Machinery | Location | What it does |
|---|---|---|
| Boot-time file migration | `src/main/userdata-migration.ts`, called from `src/main/main.ts` ahead of anything that reads userData | `migrateLegacyUserData()` copies `~/.vibeyard` → `~/.finevibe` and `%APPDATA%/Vibeyard|vibeyard` → userData, **per file, destination wins** (`copyMissingTree`): a file that already exists at the destination is never overwritten. Purges (never copies) stale `vibeyard-browser-iso-*` / `vibeyard-browser-*` partitions. Per-file failures (a running legacy instance holds a Chromium lock) are recorded and retried at the next launch. |
| In-app project import | `src/main/legacy-import.ts` → IPC `vibeyard:listImportableProjects` (`ipc-handlers.ts:1368`) → preload `vibeyard.listImportableProjects()` → `src/renderer/components/vibeyard-import.ts`, header button `#btn-import-vibeyard`, strings under `legacyImport.*` | Reads the legacy `~/.vibeyard/state.json` **read-only**, lists projects the live state does not already have (capped `MAX_IMPORTABLE = 500`), and adds the user's picks through `appState` → `persist()` — the only safe way to merge projects into a live `state.json`. |
| Ledger-driven retirement | `retireLegacyUserData()` in the same module | Deletes the legacy **userData** tree only, and only after a 30-day grace (`RETIRE_GRACE_MS`), a destination file-count check against the copy ledger (`.finevibe-migrations.json`), and with no `retire-legacy-user-data.off` opt-out file in userData. Outcome log: `legacy-retirement.json` (50 entries). `~/.vibeyard` is **never** retired. |

Start every job by confirming the machinery is still there:

```bash
grep -rn "vibeyard" src/main/ | head    # migration + importer present?
```

If that grep ever comes back empty (migration removed/rewritten), this skill's recipe is
the manual copy of the previous section's git history — check `git log --stat --
src/main/userdata-migration.ts src/main/legacy-import.ts` before improvising.

## Rule 0: the running app owns `state.json`

FineVibe holds state in memory and rewrites `state.json` on every change and on exit.
**A file copied over a live `state.json` gets clobbered.** Measured: a 13-project copy
landed at 23:22 and the app had replaced it with its in-memory 2-project state by 23:26 —
minutes, not hours. The app's memory always wins: sessions created after the copy survive,
imported projects vanish.

Check first, and never skip this:

```bash
tasklist //FI "IMAGENAME eq FineVibe.exe" | head -5    # Windows
pgrep -fl FineVibe                                     # macOS/Linux
```

Consequences, in order of preference:

1. **Never overwrite a live `state.json`.** There is no scenario in this skill where it is
   the right move: merging goes through the import UI, and copying goes file-by-file
   (destination wins) — which is exactly what the boot migration already does.
2. If the user insists on a raw file swap (e.g. restoring a `state.json.bak-*`), the app
   must be fully quit (all windows **and** tray) first, and they get the re-copy one-liner
   to run after quitting.
3. Quitting the app to copy a file is a worse deal for the user than the import button.
   Offer the import first, every time.

## Diagnosis: why "FineVibe is empty" after the rename

Work the causes in this order — each has a different fix, and the earlier ones explain the
later ones.

### 1. Did the boot migration run?

```bash
ls -la ~/.finevibe/.finevibe-migrated            # home-tree marker
cat ~/.finevibe/.finevibe-migrated               # "migrated from … copied=N skipped=M"
ls "$APPDATA/FineVibe/.finevibe-migrated" 2>/dev/null   # userData marker
grep -c "" ~/.vibeyard/state.json ~/.finevibe/state.json
```

The marker is written **only when a pass had zero per-file errors** and makes every later
launch a no-op (`alreadyMigrated`). So:

- **Marker present, projects missing** → normal. The copy is destination-wins: FineVibe
  already had `~/.finevibe/state.json`, so the legacy project list was never merged.
  That is a *cause #2* job (import UI), not a file-copy job.
- **No marker, `~/.vibeyard` present** → the migration never completed: launch FineVibe
  once and re-read the marker + the `[userdata-migration] home N copied / M kept` console
  line. Locked Chromium files (a legacy instance running) are the usual per-file error.
- **No marker, no `~/.vibeyard`** → nothing to import; the data lives somewhere else
  (another profile, another machine). Say so instead of copying.

### 2. Projects exist on disk but not on the board → use the import UI

The header button `#btn-import-vibeyard` is rendered only when the importer returns a
non-empty list (`initVibeyardImport()` probes once at startup, sync, and toggles
`.hidden`), so:

- **Button visible** → click it, pick the projects, Import. Skips are reported
  (`legacyImport.skippedOne/Other`: "FineVibe already lists it") because a project whose
  path is already known (`getKnownProjectPaths()`) never appears in the list.
- **Button missing** → the probe found nothing importable. Probe it yourself before
  claiming the data is gone:
  ```bash
  node -e "const fs=require('fs'),os=require('os');const j=JSON.parse(fs.readFileSync(os.homedir()+'/.vibeyard/state.json','utf8'));const p=j.projects||[];console.log(p.length);for(const x of p.slice(0,8))console.log(x.name+' :: '+x.path+' :: '+(x.sessions||[]).length+' sessions')"
  ```
  Common reasons for an empty list with a populated legacy file: every project path is
  already in the live state (correct behavior — the import is *additive*), the legacy
  `state.json` is unreadable/`[]` (the importer never throws; it degrades to `[]`), or the
  list exceeds the 500-entry cap.

Nothing in this path touches disk layout: the modal's own copy says "nothing on disk is
moved or changed", and `legacy-import.ts` never writes the legacy file.

### 3. Sessions list but open empty

Session `cliSessionId`s point at transcripts under `~/.finevibe/profiles/<uuid>/projects/...`.
Session *history* therefore works only when the profiles are (or were made) identical.
Verify history exists before promising it, in **both** trees:

```bash
find ~/.finevibe/profiles ~/.vibeyard/profiles -name "*<cliSessionId>*" 2>/dev/null
```

No hit in either tree = the transcript was never written (or was pruned); the session will
open empty no matter what is copied. Report "project metadata only" honestly.

## Manual file work (last resort, and only for gaps the migration cannot fill)

Legitimate uses: per-file gaps from a partially failed pass, copying a *specific* profile
file the user names, restoring a `state.json.bak-*` you (or a prior import) made, and the
path rewrite in the next section.

1. Back up the destination first — never overwrite app state without a copy:
   ```bash
   cp ~/.finevibe/state.json ~/.finevibe/state.json.bak-$(date +%Y%m%d-%H%M%S)
   ```
2. Copy **missing files only**, mirroring the migration's own rule (never clobber):
   ```bash
   cp -rn ~/.vibeyard/profiles/<uuid>/. ~/.finevibe/profiles/<uuid>/
   ```
   Profile dirs hold live SQLite files (`agent.db`, `history.db`) and a live app has them
   open — a wholesale overwrite of a used profile is not recoverable.
3. Verify the destination **stayed** changed: `sleep 15; ls -la ~/.finevibe/state.json`.
   If it shrank back, the app overwrote it — that is Rule 0, and the fix is the import UI.

`run/` (hook scripts + caches) is disposable and regenerated at boot — never worth
copying, and purge it only with the app quit, since live hook paths point into it.

## Post-copy path rewrite (the migration does NOT rewrite file contents)

`copyMissingTree` is byte-for-byte. Anything inside a copied file that names the old home
still says `.vibeyard`:

- `settings.json` hook entries (`"command": "C:/Users/<user>/.vibeyard/run/status_writer.py"`)
  — FineVibe rewrites **its own** hook and statusLine entries on the next
  `guardedInstall()` / per-profile spawn (`src/main/settings-guard.ts`), so FineVibe's
  entries self-heal; legacy-era entries for other tools do not.
- `plugins/installed_plugins.json` (`installPath`) and `plugins/known_marketplaces.json`.
  Note the app's plugin/agents/skills reader is **user-scoped**: `readPluginAgents()` and
  `readPluginSkills()` (`src/main/claude-cli.ts`) hardcode
  `~/.claude/plugins/installed_plugins.json`, so a *profile* copy's manifest is not what
  FineVibe lists — the Claude Code CLI running with that profile as its config dir is.

Deleting `~/.vibeyard` while those paths are live breaks plugins and hooks. It is also the
only backup of pre-rename state: **never delete it as part of an import.** Retirement is
the app's job (appData-only, 30-day grace, ledger + integrity check, opt-out via
`retire-legacy-user-data.off` in userData); `~/.vibeyard` is outside retirement entirely.

## Freeing space in the data folder

`plugins/cache` + `plugins/marketplaces` dominate the tree (734M of 910M observed;
`chrome-devtools-mcp`'s bundled `chrome-devtools-frontend` alone ~590M) and are re-fetched
on next plugin use. Their `.git/objects` packfiles are read-only, so `shutil.rmtree` needs
an `onerror` that clears `S_IWRITE`, and `rm -rf` stops partway with no useful message.
The app's own prune tool is `npm run clean:caches` (`scripts/clean-caches.js`,
`--dry-run` available) for the electron/electron-builder caches; plugin caches are
purged with the app quit.
