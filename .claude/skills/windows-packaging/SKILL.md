---
name: windows-packaging
description: This skill MUST be used whenever the task involves building, verifying, or debugging the Windows package — the NSIS Setup .exe, portable exe, or zip — running electron-builder, the native-module (node-pty / better-sqlite3) build, SmartScreen/signing questions, the updater feed, or a release cut. Use when the user asks to "build the installer", "make a setup exe", "package for Windows", "why does the build fail", "ship a release", or "the app can't spawn terminals in the packaged build".
---

# Windows packaging (NSIS setup + native modules)

There is **no `electron-builder.json`**: all build config is the `"build"` block in
`package.json`. Read it before changing anything. `.claude/commands/release.md` owns the
version/tag/push half of a release; this skill owns the build.

## The command that works on a plain Windows host

```bash
npm ci
npm run dist:win:local
# = pre-clean out/win-unpacked + the FineVibe-*.exe / FineVibe-*-win-x64.zip
#   outputs (DEFECT 49: a mid-chain failure used to poison the NEXT run —
#   blocker 3's ENOENT)
#   → build && icons
#   → electron-builder --win dir --x64 --publish never \
#       --config.npmRebuild=false --config.win.signAndEditExecutable=false
#   → node scripts/verify-win-exe.mjs out/win-unpacked   (npm run win:verify:native)
#       packed better_sqlite3.node must carry the ABI @electron/rebuild recorded in
#       node_modules/better-sqlite3/build/Release/.forge-meta, plus node-pty's win32 prebuilds
#   → node scripts/edit-win-exe.mjs     (stamp icon + version resources via the rcedit npm pkg)
#   → node scripts/verify-win-exe.mjs   (npm run win:verify: the stamped exe's icon + version resources)
#   → electron-builder --win nsis zip --prepackaged out/win-unpacked --x64 \
#       --publish never --config.npmRebuild=false --config.win.signAndEditExecutable=false
#   → npm run win:verify:setup, then out/win-unpacked is deleted
# -> out/FineVibe-Setup-<version>.exe (+ .exe.blockmap + latest.yml) and the win zip
```

**No step of this chain launches the app, and none can on a Linux box:** the
exe smoke (start `out/FineVibe-Setup-<v>.exe`, then the installed app, and
confirm a window plus a working terminal) is a **Windows-host step** run by
hand after every local build. Every gate above is static — asar content,
native ABI, exe resources — none of them executes the built app.

The native check is fail-closed on purpose: `--config.npmRebuild=false` (blocker 1) skips
the rebuild and `postinstall` swallows `install-app-deps` failures (blocker 3), so a
Node-ABI `better_sqlite3.node` used to reach a Setup.exe with every other gate green. If
it says `.forge-meta` is missing, run `npx electron-builder install-app-deps` and rebuild
the dir phase — do not delete the check.

**Scope: `win.target` is `[nsis, portable, zip]`, and `dist:win:local` builds `nsis` +
`zip` only.** The portable exe (`FineVibe-<version>.exe`, `build.portable.artifactName`)
is produced only by `npm run dist` on CI — the local flow neither builds nor verifies it,
so "the local build is green" says nothing about the portable artifact.

Verified on this repo (Electron 41.1.0, electron-builder 26.8.1, node-pty 1.1.0,
better-sqlite3 12.10.0, rcedit 5.0.2, Windows 10.0.26300, Node 24): 111.5 MB Setup.exe,
exe icon within RGB delta 1.0 of `build/icon.png` at 32×32, `VersionInfo`
`ProductName=FineVibe` / 4-part `FileVersion`. ~14 min on a loaded box (NSIS+zip phase
~5 min). CI releases are unaffected: the `windows-2022` runner runs `npm run dist` and
electron-builder's full rcedit/vsign path embeds the icon natively.
The two `--config.*` flags are the host workarounds (blockers 1+2); the stamp step
replaces exactly the icon/version resources they skip.

## The three blockers, in the order they fire

| # | Failure text | Cause | Release fix | Local bypass (and its cost) |
|---|---|---|---|---|
| 1 | `node-gyp: Could not find any Visual Studio installation` on `moduleName=node-pty` | pack-time `@electron/rebuild` compiles node-pty from source; no VS C++ toolchain (`vswhere` absent). `better-sqlite3` **succeeds** — it downloads a per-ABI prebuild | install VS 2022 Build Tools (C++ workload), or build on the CI `windows-2022` runner which has it | `--config.npmRebuild=false`. Safe: node-pty ships N-API prebuilds (`prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node`, `conpty/conpty.dll`, `winpty.dll`, `winpty-agent.exe`) and electron-builder auto-unpacks `*.node` |
| 2 | `ERROR: Cannot create symbolic link : A required privilege is not held by the client` extracting `winCodeSign-2.6.0.7z` (the `darwin/10.12/lib/*.dylib` symlinks) | electron-builder runs rcedit (exe metadata + asar-integrity resource) from that archive; the account lacks `SeCreateSymbolicLinkPrivilege` (Developer Mode off, not elevated) | enable Windows Developer Mode, run from an elevated shell, or build on CI | `--config.win.signAndEditExecutable=false` in **both** electron-builder phases, then stamp the exe: `npm run win:stamp` (`scripts/edit-win-exe.mjs`) drives the `rcedit` npm package, whose binary ships directly in `node_modules/rcedit/bin` — no winCodeSign extraction. Sets icon, 4-part file/product version, product name, file description, company name, original filename. **Cost: nothing is signed.** The app exe, the installed shortcuts and the Setup.exe stub all carry the FineVibe identity — the stub is stamped by makensis itself (`app-builder-lib/out/targets/nsis/NsisTarget.js:196` sets `MUI_ICON`/`MUI_UNICON` from `build/icon.ico`), and `npm run win:verify:setup` audits it; the symlink blocker never touches the installer. On 26.8.1 electron-builder still updates the asar-integrity resource of `FineVibe.exe` in the dir phase. Developer Mode/elevation remains the full fix — never ship a release built this way |
| 3 | `ENOENT ... rename 'out\win-unpacked\electron.exe' -> 'FineVibe.exe'` | a stale `out/win-unpacked` from an aborted run | delete the stale output and rebuild | `dist:win:local` pre-cleans it at the **head** of the chain (DEFECT 49: a mid-chain failure used to poison the NEXT run) and again at the tail; manual dir-phase flows delete `out/win-unpacked` first |

**Pre-seeding the winCodeSign cache does not work.** The extraction directory name is a
per-run random number (`Cache\winCodeSign\297414723`, then `078468359`, …), so copying an
already-extracted tree into a known hash dir is ignored. Do not spend time on it.

**`npm run clean:caches` is the prune tool for these caches** (`scripts/clean-caches.js`):
it clears `%LOCALAPPDATA%\electron-builder\Cache` (where winCodeSign extracts) and
`%LOCALAPPDATA%\electron\Cache` (plus `~/.cache/electron*` / `~/Library/Caches/electron*`
and FineVibe temp scratch older than 24h) and prints freed MB — `--dry-run` previews.
It is not a winCodeSign keep-alive; pre-seeding stays impossible, this only reclaims
the disk the downloads leave behind.

## Gotchas that cost the most time

1. **`dist/` was shared — resolved by the output split.** `npm run build` writes the
   compiled app to `dist/`; electron-builder writes artifacts to `out/`
   (`build.directories.output: "out"`). `rm -rf dist` no longer wipes artifacts and
   clearing `out/` no longer forces a rebuild — the *"Application entry file
   dist\main\main\main.js … was not found in this archive"* trap is gone.
2. **A stale `out/win-unpacked` breaks the dir phase** (`electron.exe → FineVibe.exe`
   rename ENOENT because the target exists). Since DEFECT 49 `npm run dist:win:local`
   deletes `out/win-unpacked` (and the `FineVibe-*.exe` / `FineVibe-*-win-x64.zip`
   outputs) at the **head** of the chain, so an aborted run cannot make the next one
   fail on that misleading ENOENT; it still cleans up after the nsis+zip legs. Only
   hand-run dir phases need the manual `rm -rf out/win-unpacked`.
3. **`postinstall` swallows native-prep failures**: it wraps
   `electron-builder install-app-deps` in `try{…}catch{}`. Run
   `npx electron-builder install-app-deps` explicitly when native prep matters and read
   its output.
4. Every `npm` call prints `npm warn Unknown project config "min-release-age"` from
   `.npmrc`. That is registry noise, not a build defect (audit row P2-10).
5. **`rcedit` version-string keys are case-sensitive PascalCase**: `--set-version-string
   product-name FineVibe` is silently ignored (exit 0), `ProductName` works.
   `scripts/edit-win-exe.mjs` uses the correct casing; do not "normalize" it.

## Verify the artifact, don't trust the exit code

```bash
cat out/latest.yml                       # version, sha512, size, releaseDate
ls -la out/*.exe out/*.blockmap
node -e "const a=require('@electron/asar');
  const l=a.listPackage('out/win-unpacked/resources/app.asar').map(s=>s.replace(/\\\\/g,'/'));
  console.log(l.includes('/dist/main/main/main.js'), l.filter(s=>/node-pty.*(node|dll)$/.test(s)).length);"
find out/win-unpacked/resources/app.asar.unpacked -name "*.node" -o -name "conpty*.dll"
```

Pass criteria: entry `dist/main/main/main.js` present in the asar;
`app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/` holds the three `.node`
files **plus** `conpty/conpty.dll`; `better-sqlite3/build/Release/better_sqlite3.node`
unpacked; `latest.yml` sha512 matches the Setup.exe. For the local flow also assert the
stamp landed: `(Get-Item out/win-unpacked/FineVibe.exe).VersionInfo.ProductName` is
`FineVibe`, `FileVersion` is 4-part, and `[System.Drawing.Icon]::ExtractAssociatedIcon`
renders the dark FineVibe tile (32×32 mean RGB within a few units of `build/icon.png`).

Then smoke on a clean Windows VM (unit tests are not proof of packaged behavior, per
`CLAUDE.md`): install → first launch (window title/menu say FineVibe) → spawn one PTY per
provider (this exercises the ConPTY path, the least-verified link) → Chrome import (needs
`better-sqlite3` at the **Electron** ABI, not Node's) → uninstall keeps `%APPDATA%\FineVibe`.

## Release blockers to check before cutting an installer

Re-derive every bullet before repeating it — this list has carried dead blockers before
(it asserted "no `src/main/userdata-migration.ts`" in the very commit that added that
file, `9d7d0987`). The checks are one-liners; run them, then quote the result.

- **Legacy identity migration SHIPS** — do not re-report it as a blocker.
  `src/main/userdata-migration.ts` runs from `src/main/main.ts` before anything reads
  userData: `~/.vibeyard` → `~/.finevibe` and `%APPDATA%/Vibeyard|vibeyard` → userData,
  per-file destination-wins, marker-gated (`.finevibe-migrated`), ledger
  (`.finevibe-migrations.json`) + 30-day-grace retirement of the legacy userData tree
  only. Check: `ls src/main/userdata-migration.ts` and the `[userdata-migration]` log
  line in a packaged launch. Recovery UX: `src/main/legacy-import.ts` + the in-app
  `#btn-import-vibeyard` modal (see the `import-legacy-settings` skill).
- `publish.repo` is **already** `leo-3889/finevibe` (`package.json` → `build.publish`).
  Verify, don't repoint: `node -p "JSON.stringify(require('./package.json').build.publish)"`.
- **Windows is unsigned; macOS is signed.** `release.yml` wires `CSC_LINK` /
  `CSC_KEY_PASSWORD` (+ notarization) for the mac job and flips
  `CSC_IDENTITY_AUTO_DISCOVERY=false` for the `artifacts_only` input; the Windows job
  ships exe/zip unsigned by documented decision (**P1-9**), so Setup.exe triggers
  SmartScreen "unknown publisher" and `signtool verify` has nothing to validate.
  Integrity story on Windows is the `SHA256SUMS.txt` the publish job ships.
  Authenticode means a real cert + `certificateFile`/`CSC_LINK` + CI secrets — a change
  to the Windows job, not to this skill's local flow (which signs nothing, by design).
- Keep the `zip` win target: `bin/finevibe.js` names the Windows asset
  `FineVibe-<version>-win-x64.zip` — hardcoded x64 (`:51`), with arm64 refused up
  front (`:45-50`, `bcd96c3d`) because no win-arm64 asset ships; `win` is x64-only
  (docs/FEATURES.md §28). npm installs break without the zip.
- **Packaged auto-update needs no CI environment.** electron-builder bakes the feed into
  `resources/app-update.yml` from `build.publish`, and `src/main/auto-updater.ts` runs
  against that file when `FINEVIBE_RELEASE_REPO` is unset — failing closed if it names a
  repo other than `FORK_RELEASE_REPO`. `FINEVIBE_RELEASE_REPO` is only an OVERRIDE (a
  malformed value disables auto-update rather than falling back to the baked feed), so
  `grep -rn FINEVIBE_RELEASE_REPO .github/` returning zero hits is the expected state, not
  a blocker — it was read as one while `initAutoUpdater` still required the variable.
  The npm launcher still has no baked feed and refuses to download without it:
  `grep -n FINEVIBE_RELEASE_REPO bin/finevibe.js`. A portable `.exe` never self-updates
  (`PORTABLE_EXECUTABLE_DIR` gate), and the deb install is excluded too (linux feed ships
  the AppImage only); the About pane reports those gates as the reason instead of firing
  an `update:error` per manual click.
- Cut a real version: `release.yml` `workflow_dispatch` mints version + changelog + tag;
  a `-dev` suffix becomes `~dev` in deb metadata and is a prerelease everywhere else.
- CI builds on `windows-2022`, pinned deliberately: the `windows-latest` (2025) image
  breaks node-gyp's Visual Studio detection when compiling node-pty (`release.yml:474-476`,
  `ci.yml:17-19`). Don't "modernize" the runner label.

## Linux cross-build (no Windows host)

Verified on this box at `56831678` (Ubuntu, Node 24, Electron 41.1.0, electron-builder
26.8.1, wine-10.0): the whole win matrix builds here. wine64 covers the two steps that
shout "Windows-only" — the NSIS two-pass (`makensis`) and the rcedit stamp — and
`--config.npmRebuild=false` + a win32 prebuild swap covers the toolchain blocker.

```bash
git worktree add --detach /home/test/Ai/fv-win3 <sha>      # never build in the shared checkout
cp -rl node_modules /home/test/Ai/fv-win3/                 # hardlinked copy; re-point .bin symlinks
(cd node_modules/better-sqlite3 && npx prebuild-install@7 -r electron -t 41.1.0 \
   --platform win32 --arch x64)                           # the file MUST be PE32 (`file` it)
printf 'x64--145' > node_modules/better-sqlite3/build/Release/.forge-meta  # the ABI the guard reads
npm run icons
npx tsc -p tsconfig.main.json --noCheck                   # --noCheck ONLY for the known 787 split
npx tsc -p tsconfig.preload.json                          # MANDATORY, never skipped
npm run build:renderer && npm run copy-assets
npx electron-builder --win dir --x64 --config.npmRebuild=false --config.win.signAndEditExecutable=false
npm run win:verify:native                                 # ABI 145 + 7 pty files + asar entry points
npm run win:stamp && npm run win:verify                   # rcedit + icon/version checks under wine
npx electron-builder --win nsis zip --prepackaged out/win-unpacked --x64 \
  --config.npmRebuild=false --config.win.signAndEditExecutable=false
npm run win:verify:setup
```

- **`tsc -p tsconfig.preload.json` is not optional.** `build:core` is
  `tsc -p tsconfig.main.json && tsc -p tsconfig.preload.json`; substituting one leg for
  the other is the class of shortcut that ships a working-looking installer with a dead
  IPC layer. `--noCheck` on the *main* leg is legitimate only when the tip carries a
  known concurrent-edit typecheck split (currently `pty-manager.ts:787` TS2353
  `storageMode`), and it must be the only diagnostic that leg prints.
- **Artifacts land in the project that owns the worktree — `./out` of the build tree**,
  not the shared checkout. Copy `FineVibe-Setup-*.exe{,.blockmap}`,
  `FineVibe-<ver>-win-x64.zip`, `latest.yml` into the repo `out/` and regenerate
  `SHA256SUMS-win.txt`. `latest.yml` (nsis) coexists with `latest-linux.yml` (linux
  targets) in the same `out/` — that pairing is expected, not a collision.
- **The enforcement line is `npm run win:verify:native`.** It now lists `resources/app.asar`
  with `@electron/asar` and fails closed unless `/dist/preload/preload/preload.js`,
  `/dist/main/main/main.js` and `/dist/renderer/index.html` are all in the archive. The
  Setup-exe mode deliberately does not re-unpack `app-64.7z`: the nsis/zip legs pack the
  exact `--prepackaged` tree this gate audited.

| Shipped symptom | Root cause | Gate that catches it |
|---|---|---|
| Installer runs, window renders, **every IPC call dies**, no error anywhere | the preload leg never ran → `dist/preload/` is absent from `app.asar` | asar entry-point check (new) |
| `ERR_DLOPEN_FAILED` on first launch / Chrome import | `better_sqlite3.node` on the Node ABI | `.forge-meta` ↔ packed `NODE_MODULE_VERSION` |
| No terminal spawns on Windows | `win32-*` node-pty prebuilds missing/empty | 7-file prebuild check |
| Explorer shows the Electron atom / "Electron" | stamp skipped (`signAndEditExecutable=false`) | `npm run win:verify` + `:setup` |

Byte-level whole-blob scanning (secret/author leakage in the packed payload) is a
different audit class — see the packaging audit, not this section. Wine smoke is a
bonus, never a sign-off: Electron-on-wine is flaky; the owner's clean Windows VM is the
real first-launch test.

## Test-suite reality on a Windows dev box

`npx vitest run` fails 6 tests in `src/main/chrome-import/{cookies,importer}.test.ts` with
`NODE_MODULE_VERSION 145 … requires 137` **when the precondition holds**: `install-app-deps`
has built `better-sqlite3` for Electron's ABI and vitest then loads it under plain Node.
That is the host, not the code. It is conditional, not a standing red suite — measured
2026-10-24 on a tree where the native build was on the Node ABI, the leg is green
(`npx vitest run src/main/chrome-import` → 48 passed / 9 skipped). Reproduce by loading
better-sqlite3 under plain Node; fix by rebuilding for the Node ABI (or accept the 6 and
say which ABI produced them). Everything else (≈3000 tests) must be green. The
documented gate legs are `npm run build`, `npm run typecheck`, `npx vitest run`,
`git diff --check` (`dev/audit/gate.sh` runs them, N times).
