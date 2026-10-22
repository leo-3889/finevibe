---
name: import-legacy-settings
description: This skill MUST be used whenever the task involves importing, migrating, restoring, or copying app settings/state from a previous Vibeyard install (or another FineVibe profile) into FineVibe — the ~/.vibeyard and ~/.finevibe folders, state.json, profiles/, "bring over my old sessions/kanban/projects", or "the app lost my projects after the rename". Use when the user asks to "import my old settings", "migrate from vibeyard", "restore my sessions", "copy state.json", or "why is FineVibe empty".
---

# Import legacy settings (~/.vibeyard → ~/.finevibe)

FineVibe is the renamed Vibeyard app. The data folder moved from `~/.vibeyard` to
`~/.finevibe` (`src/main/store.ts`: `STATE_DIR = path.join(os.homedir(), '.finevibe')`),
and **the rename ships no userData migration** — a fresh FineVibe install starts with an
empty state. Importing is a manual file copy. There is no in-app import UI.

## Layout of the data folder

```
~/.finevibe/
  state.json        ← projects, sessions, kanban layouts, costs, layout — the real payload
  profiles/<uuid>/  ← per-provider CLI homes (Claude/Codex/Pi/etc.): settings.json,
                      claude.json, sessions/, projects/, history.db, agent.db ...
  run/              ← hook scripts + caches, regenerated at boot — never worth copying
```

`state.json` is almost always what the user means by "my settings". `profiles/` is
usually already present and identical (the launcher/migration copies it); verify before
copying. `run/` is disposable.

## Rule 0: the running app owns state.json

FineVibe holds state in memory and rewrites `state.json` on every change and on exit.
**A copy made while the app is running gets clobbered** on the next save.

Measured: a 13-project copy landed at 23:22 and the app had replaced it with its
in-memory 2-project state by 23:26 — minutes, not hours. The app's memory always wins,
so sessions created *after* the copy survive it while imported projects vanish.

Always check first:

```bash
tasklist //FI "IMAGENAME eq FineVibe.exe" | head -5    # Windows
tasklist //FI "IMAGENAME eq Vibeyard.exe"  | head -5
```

- Not running → do the copy, done.
- Running → tell the user to fully quit (all windows + tray) and do it after. Only
  proceed while running if the user explicitly accepts the clobber risk; then give them
  the re-copy one-liner to run after quitting.

## Import recipe

1. **Inspect, don't blind-copy.** Compare sizes/dates — the richer/newer state is the
   source:
   ```bash
   ls -la ~/.vibeyard/state.json ~/.finevibe/state.json
   head -c 400 ~/.finevibe/state.json     # confirm it's the small/empty one you expect
   ```
   `state.json` is plain JSON (`{ "version": 1, "projects": [...] }`) — `head`/`jq` can
   show project names and session counts so the user confirms the right side wins.

2. **Back up the destination** (never overwrite app state without a copy):
   ```bash
   cp ~/.finevibe/state.json ~/.finevibe/state.json.bak-$(date +%Y%m%d-%H%M%S)
   ```

3. **Copy the state:**
   ```bash
   cp ~/.vibeyard/state.json ~/.finevibe/state.json
   ```

4. **Profiles:** diff before copying — if already identical, say so and copy nothing:
   ```bash
   diff -rq ~/.vibeyard/profiles ~/.finevibe/profiles 2>/dev/null | head -30
   ```
   Profile dirs hold live SQLite files (`agent.db`, `history.db`) and the profile UUIDs
   match across both trees, so `cp -rn` (no-clobber) into an existing profile is safe;
   wholesale overwrite of a profile that has been used by the new app is not.

5. **Verify and relaunch:** confirm the size/date of the destination changed and stayed
   changed (`sleep 15; ls -la ~/.finevibe/state.json`), then have the user launch
   FineVibe and check projects/sessions appear. If the file shrank back, the app
   overwrote it — quit fully, re-copy, relaunch.

## Notes

- `~/.vibeyard` is the source; **never delete it** as part of an import — it is the only
  backup of pre-rename state.

- Copied profiles keep absolute `.vibeyard` paths in `plugins/installed_plugins.json`
  (`installPath`), `plugins/known_marketplaces.json`, and `settings.json` (hook paths
  like `C:/Users/<user>/.vibeyard/run/status_writer.py`). After a plain copy, FineVibe's
  plugins and hooks still load from `~/.vibeyard`; deleting it breaks them until those
  three files per profile are rewritten to `.finevibe`.
- Check history is real before promising it: `find ~/.finevibe/profiles -name
  "*<cliSessionId>*"`. In the 2026-10-21 tree none of the 6 source session ids had
  transcripts in *either* tree, so those sessions list and open empty no matter what
  the copy does — only project metadata imports.
- The session `cliSessionId`s in imported state point at transcripts under
  `~/.finevibe/profiles/<uuid>/projects/...` — session *history* therefore only works if
  the profiles are (or were made) identical. Importing state without matching profiles
  yields sessions that list but open empty.
- Session/plan-status docs: audit commit `c613d03` records the missing-migration fact;
  if a real migration lands in `src/main/` (search for `vibeyard` in main), this skill's
  premise changes — check `grep -rn "vibeyard" src/main/` before following the recipe.
- Same recipe applies for restoring from a `state.json.bak-*` you (or a prior import)
  made: step 2 then copy the `.bak` over `state.json`.
- Cleaning the folder: `plugins/cache` + `plugins/marketplaces` dominate it (734M of
  910M observed, `chrome-devtools-mcp`'s bundled `chrome-devtools-frontend` alone
  ~590M) and are re-fetched on next plugin use. Their `.git/objects` packfiles are
  read-only, so `shutil.rmtree` needs an `onerror` that clears `S_IWRITE`, and
  `rm -rf` stops partway with no useful message. Purge `run/` after quitting, not
  while the app runs — live hook paths point into it.
