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
# = build && icons
#   → electron-builder --win dir --x64 --publish never \
#       --config.npmRebuild=false --config.win.signAndEditExecutable=false
#   → node scripts/edit-win-exe.mjs     (stamp icon + version resources via the rcedit npm pkg)
#   → electron-builder --win nsis zip --prepackaged out/win-unpacked --x64 \
#       --publish never --config.npmRebuild=false --config.win.signAndEditExecutable=false
# -> out/FineVibe-Setup-<version>.exe (+ .exe.blockmap + latest.yml) and the win zip
```

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
| 2 | `ERROR: Cannot create symbolic link : A required privilege is not held by the client` extracting `winCodeSign-2.6.0.7z` (the `darwin/10.12/lib/*.dylib` symlinks) | electron-builder runs rcedit (exe metadata + asar-integrity resource) from that archive; the account lacks `SeCreateSymbolicLinkPrivilege` (Developer Mode off, not elevated) | enable Windows Developer Mode, run from an elevated shell, or build on CI | `--config.win.signAndEditExecutable=false` in **both** electron-builder phases, then stamp the exe: `npm run win:stamp` (`scripts/edit-win-exe.mjs`) drives the `rcedit` npm package, whose binary ships directly in `node_modules/rcedit/bin` — no winCodeSign extraction. Sets icon, 4-part file/product version, product name, file description, company name, original filename. **Cost: the Setup.exe installer-stub icon itself stays default NSIS** (rcedit on the installer stub hits the same blocker) and nothing is signed; the app exe and installed shortcuts carry the FineVibe identity. On 26.8.1 electron-builder still updates the asar-integrity resource of `FineVibe.exe` in the dir phase. Developer Mode/elevation remains the full fix — never ship a release built this way |
| 3 | `ENOENT ... rename 'out\win-unpacked\electron.exe' -> 'FineVibe.exe'` | a stale `out/win-unpacked` from an aborted run | delete the stale output and rebuild | `dist:win:local` cleans it itself (Gotcha 2); manual dir-phase flows delete `out/win-unpacked` first |

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
   rename ENOENT because the target exists). `npm run dist:win:local` now deletes
   `out/win-unpacked` itself after the nsis+zip legs; only hand-run dir phases need
   the manual `rm -rf out/win-unpacked` after an aborted attempt.
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

- **userData migration is absent on `rebuild`**: no `src/main/userdata-migration.ts`, no
  `app.setName`, no `app.setPath('userData')`. An install whose identity changes from
  Vibeyard to FineVibe boots into a fresh empty `%APPDATA%\FineVibe` and leaves state in
  `%APPDATA%\Vibeyard`. Tracked as a P1 release blocker in `todos/AUDIT_STATUS.md`.
- `publish.repo` is the stale slug (`leo-3889/vibeyard`, works via GitHub's redirect) —
  repoint to `leo-3889/finevibe`.
- **Nothing is signed**: no `sign`/`csc*`/`certificateFile` anywhere; Setup.exe triggers
  SmartScreen "unknown publisher". Integrity story today is `SHA256SUMS.txt` from the
  publish job. Authenticode means adding `certificateFile`/`CSC_LINK` + CI secrets.
- Keep the `zip` win target: `bin/finevibe.js` hardcodes the asset name
  `FineVibe-<version>-win-<arch>.zip`; npm installs break without it.
- The updater/launcher read the publishing repo **only** from `FINEVIBE_RELEASE_REPO` and
  refuse a built-in default — set it in `release.yml` for the release to self-update.
- Cut a real version: `release.yml` `workflow_dispatch` mints version + changelog + tag;
  a `-dev` suffix becomes `~dev` in deb metadata and is a prerelease everywhere else.

## Test-suite reality on a Windows dev box

`npx vitest run` fails 6 tests in `src/main/chrome-import/{cookies,importer}.test.ts` with
`NODE_MODULE_VERSION 145 … requires 137` whenever `install-app-deps` has built
better-sqlite3 for Electron's ABI. That is the host, not the code: reproduce by loading
better-sqlite3 under plain Node. Everything else (≈3000 tests) must be green. The
documented gate legs are `npm run build`, `npm run typecheck`, `npx vitest run`,
`git diff --check` (`dev/audit/gate.sh` runs them, N times).
