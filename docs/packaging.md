# Packaging and releases

How FineVibe ships. Build configuration lives in `package.json` under `build`
(`electron-builder`); release automation lives in
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

## Icons

The icon master is `assets/icon-source.png` (1024×1024, tracked), rendered by
`scripts/generate-icon.mjs` (pure Node, SDF; deterministic — reruns are
byte-identical). `npm run icons` (`scripts/build-icons.mjs`, via `png2icons`)
derives the packaged assets. Every packaging entrypoint runs it before
`electron-builder` — `pack`/`dist` locally, all three release jobs,
`package-ubuntu.yml`, and `ci.yml` — so packages are built from the master:

| Asset | Consumers |
|---|---|
| `build/icon.png` | `build.icon` + linux icon; shipped in the asar and used as the window icon (`src/main/main.ts`) |
| `build/icon.icns` | macOS (`build.mac.icon`) |
| `build/icon.ico` | Windows (`build.win.icon`, 16–256px sizes) |

After changing the icon design, edit `scripts/generate-icon.mjs`, run
`node scripts/generate-icon.mjs && npm run icons`, and commit the regenerated
master and `build/` assets.

## Artifact matrix

Each release (`release.yml`, `workflow_dispatch` with a version bump) builds on
its native runner and publishes to GitHub Releases:

| Job | Runner | Targets | Arch |
|---|---|---|---|
| `build` | macos-latest | `dmg`, `zip` (signed + notarized) | arm64 + x64 |
| `build-linux` | ubuntu-latest | `AppImage`, `deb` | x64 |
| `build-windows` | windows-2022 | NSIS Setup `.exe`, portable `.exe`, `zip` | x64 |

Artifact names come from `build.linux/win/mac.artifactName`, e.g.
`FineVibe-<version>-linux-amd64.deb`, plus `latest.yml` for the
electron-updater/npm launcher. Versions with a `-dev` suffix normalize to dpkg
`~dev` (`0.3.9-dev` → `0.3.9~dev`) inside the deb control metadata.

## Build output directories

`dist/` holds compiled app code only (tsc/esbuild: `dist/main`,
`dist/preload`, `dist/renderer`). Every electron-builder artifact —
Setup.exe, zips, portable exe, `win-unpacked/`, `latest.yml`, blockmaps,
debs, AppImages, dmgs — lands in `out/`, set by
`build.directories.output`. The split means wiping builder artifacts never
destroys the compiled tree (and vice versa); CI upload globs and local
verification commands read `out/*`. `npm run pack` / `npm run dist` /
`npm run dist:win:local` all write there; the local Windows flow also
deletes `out/win-unpacked` automatically after the nsis+zip legs.

## Disk hygiene

- `npm run clean` — removes `dist/`, `out/`, `coverage/`, and any
  `*.tsbuildinfo` in the repo root.
- `npm run clean:caches` (`scripts/clean-caches.js`) — prunes the
  electron / electron-builder download caches
  (`%LOCALAPPDATA%\electron\Cache`,
  `%LOCALAPPDATA%\electron-builder\Cache`, `~/.cache/electron*`,
  `~/Library/Caches/electron*`) and FineVibe temp-scratch entries in
  `%TEMP%` older than 24h. Prints freed MB per target; `--dry-run` shows
  what would be freed without deleting. The download caches regrow on the
  next build — CI caches them with `actions/cache` keyed on the lockfile,
  so CI builds after a prune only pay one re-download.

## Update policy

Both update paths — the packaged auto-updater (`src/main/auto-updater.ts`)
and the npm launcher (`bin/finevibe.js`) — take their release feed from
`FINEVIBE_RELEASE_REPO` (P1-7 fork policy, audit plan §1(iv)): it must name
the fork repository that publishes these releases (`owner/repo`, served as
GitHub Releases with `latest.yml`). Unset or malformed is a *deliberate*
no-auto-update configuration: both components fail closed with a warning
and never fall back to the upstream feed.

Per target:

- **NSIS Setup (Windows) and dmg/zip (macOS):** electron-updater checks the
  configured repo's `latest.yml` / `latest-mac.yml` and installs on quit.
- **deb (Linux):** no updater channel — electron-updater has no deb target.
  A deb install updates through apt/your package repo (or a manual
  `apt install ./FineVibe-<new>.deb`).
- **portable `.exe` (Windows):** excluded from auto-update.
  electron-updater does not support the portable target — an "update" would
  download the NSIS setup and clobber the portable layout — so
  `initAutoUpdater` skips initialization when `PORTABLE_EXECUTABLE_DIR` is
  set. Portable installs update through the launcher/npm package path
  (`npx finevibe`).

## The Ubuntu (.deb) package

A deb can only be built on Linux. `postinstall` runs
`electron-builder install-app-deps`, which compiles `node-pty` from source for
the target Electron ABI (`node-pty` ships no linux prebuilds, only
darwin/win32) and resolves `better-sqlite3` against Electron's ABI
(prebuilds exist per-ABI on its GitHub releases). A Windows/macOS machine can
run `electron-builder --linux deb` and produce a syntactically valid deb, but
it would pack host-platform `.node` binaries that crash on Ubuntu — CI
builds are the only supported path.

Native modules are auto-unpacked from the asar (`*.node` detection plus the
explicit `asarUnpack` for `better-sqlite3`), so they load as real files under
`/opt/FineVibe/resources/app.asar.unpacked/`.

Installed layout (generated by electron-builder's deb target):

- `/opt/FineVibe/` — app files; `/usr/bin/finevibe` via `update-alternatives`
- `/usr/share/applications/finevibe.desktop`, hicolor icons
- apt `Depends` on the standard Electron runtime set (libgtk-3-0, libnss3, …)

Install on Ubuntu:

```bash
sudo apt install ./FineVibe-<version>-linux-amd64.deb
```

### Linux desktop integration

The deb installs the files a desktop environment needs for menu entries and
dock icons:

- `/usr/share/applications/finevibe.desktop` — `Icon=finevibe`,
  `StartupWMClass=FineVibe`
- `/usr/share/icons/hicolor/<size>/apps/finevibe.png`

Linux has no in-file exe icon (unlike the Windows `.exe` version/icon
resources described under the Windows sections), so the
npm-launcher/AppImage path gets its integration from `bin/finevibe.js`'s
post-install step: it extracts the embedded desktop entry and hicolor icons
into `$XDG_DATA_HOME` (`~/.local/share/applications/finevibe.desktop`, with
the icon entries rewritten to the installed AppImage path), giving the
launcher the same menu/dock identity as the deb. Wayland docks ignore the
`BrowserWindow` icon and match a running window to its `.desktop` file via
`StartupWMClass=FineVibe`, so that value must stay in sync with the app's
`WM_CLASS`.

### AppImage FUSE requirement (Ubuntu 24.04)

A bare AppImage mounts itself through FUSE: its runtime `dlopen`s
`libfuse.so.2` at startup. Ubuntu 24.04 no longer ships `libfuse2`, so
launching the downloaded AppImage there dies before any window appears with
`dlopen libfuse.so.2: No such file or directory`. The npm launcher probes
`/dev/fuse` and, when it is missing, launches the AppImage with
`APPIMAGE_EXTRACT_AND_RUN=1` (the runtime then extracts to a temp dir on
every start — works everywhere, costs a temp copy per launch), and writes
the same `env APPIMAGE_EXTRACT_AND_RUN=1 …` prefix into the installed
`.desktop` `Exec` so desktop launches take the same path. The `.deb` is a
plain installed tree and is unaffected.

### Wayland posture (XWayland)

The app ships no `--ozone-platform-hint` / `ELECTRON_OZONE_PLATFORM_HINT`, so
under a Wayland session Electron runs on XWayland. This is an intentional,
documented posture: the Linux surface (drag & drop via Chromium's X11
`XDND`, clipboard, IME) is verified on XWayland, and switching to native
Wayland would move all of it onto the Wayland protocols at once — including
the areas where Electron cannot offer feature parity (window focus from
notification clicks hits focus-stealing prevention, global-style clipboard
behaviour, per-monitor scale handling). Known costs of staying on XWayland:
blurry terminal text under fractional scaling, and banner-click focus is
best-effort. Revisit as a deliberate, tested migration when the Ubuntu CI
matrix can run a native Wayland session; until then do not add the hint to
launcher, `.desktop` `Exec`, or spawn arguments.

### Ad-hoc packages without a release

[`package-ubuntu.yml`](../.github/workflows/package-ubuntu.yml)
(`workflow_dispatch`) builds a deb from any branch and uploads it as the
`finevibe-deb-x64` artifact — for testing installers between releases. It
mirrors `build-linux` minus tag/publish and verifies the package with
`dpkg-deb --info/--contents`, asserting the native binaries are unpacked and
the desktop-integration files (`.desktop` entry + hicolor icons) are present.

## Verifying a deb before shipping

```bash
dpkg-deb --info FineVibe-*.deb        # metadata: version, arch, Depends
dpkg-deb --contents FineVibe-*.deb | grep -E 'pty\.node|better_sqlite3'
dpkg-deb --contents FineVibe-*.deb | grep 'usr/share/applications/finevibe.desktop'
dpkg-deb --contents FineVibe-*.deb | grep 'usr/share/icons/hicolor'
file opt/FineVibe/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node
# must report: ELF 64-bit LSB shared object
```

`finevibe --version` core-dumps over headless SSH (Electron needs a display);
the definitive smoke test is launching from the desktop session and opening a
terminal (PTY) session.

## Verifying a Windows build (host prerequisites)

The native-module step described under the deb section runs on whatever host performs
the build: `postinstall` → `electron-builder install-app-deps` compiles `node-pty`
against the target Electron ABI. On Windows that requires the platform native
toolchain, so a release verification started on a plain developer box can stop before
it produces an artifact:

| Requirement | Why | Observed failure without it |
|---|---|---|
| Visual C++ build toolchain (detected through `vswhere`) | node-pty's native rebuild for the Electron ABI; Python + node-gyp alone are not enough | `electron-builder --dir` fails at the node-pty rebuild — `vswhere` not found on the host |
| Symlink privilege (Windows Developer Mode, or an elevated shell) | electron-builder extracts `winCodeSign` through symlinks | with the native rebuild skipped (`npmRebuild=false`), `electron-builder --dir` fails extracting `winCodeSign` |

Both were observed on 2026-10-21 on a plain Windows 10.0.26300 host during the
2026-10-19/20 audit program's packaged-smoke attempt, which was recorded BLOCKED rather
than failed: an environment gap, not an app defect — the same tree had produced the
previously packaged app on the packaging machine. Run `npm run pack` / `npm run dist`
for release
verification on a host that has both prerequisites, or on the CI `windows-2022` runner
(`build-windows` in `release.yml`); read a toolchain or symlink error on a bare box as a
host problem, never as a regression in the tree under test.

### Icon-stamped Windows builds without Developer Mode

On a host with neither the C++ toolchain nor symlink privilege,
`npm run dist:win:local` produces a full installer whose app exe carries the
FineVibe identity: the electron-builder dir phase runs with both host-workaround
flags, `scripts/edit-win-exe.mjs` then stamps the icon and version resources into
`out/win-unpacked/FineVibe.exe` using the `rcedit` npm package (the rcedit
binary ships inside the package, so no `winCodeSign` 7z extraction and no
symlink privilege are needed), and electron-builder repacks the stamped
directory with `--prepackaged out/win-unpacked` into the NSIS Setup and the zip.
`VersionInfo` of `FineVibe.exe` then reports `ProductName=FineVibe` with a
4-part `FileVersion`, and the file icon is the FineVibe tile. The Setup.exe's
own installer-stub icon stays the default NSIS icon — editing that stub hits
the same symlink blocker — and releases remain the CI `windows-2022` path,
which embeds every icon through the full flow. See the
[windows-packaging skill](../.claude/skills/windows-packaging/SKILL.md) for the
blocker table and verification steps.

Linux has no equivalent in-file icon for the AppImage/deb binaries; the
desktop-integration files described under
[Linux desktop integration](#linux-desktop-integration) are the Linux side of
the same identity, and `release.yml`/`package-ubuntu.yml` assert them in CI.

## Sharing network gates

P2P session sharing (`src/renderer/sharing/`) creates an `RTCPeerConnection` in
the renderer, so a packaged build depends on two OS network permissions that
only appear at runtime — nothing in the build itself grants them:

- **macOS 15 (Sequoia):** the first local-network peer connection triggers the
  TCC *Local Network* prompt (Apple TN3179). `build.mac.extendInfo` carries
  `NSLocalNetworkUsageDescription` so the prompt states the purpose; if the
  user denies it, local joins fail with a terminal ICE `failed`. Recovery:
  System Settings → Privacy & Security → Local Network → allow FineVibe.
- **Windows:** Chromium's first `RTCPeerConnection` raises a Defender Firewall
  inbound-allow prompt (electron#23756) on the first share; an app cannot
  pre-authorize it silently. *Cancel* blocks the inbound direction, so a
  peer's join never arrives and ICE ends `failed`.

`src/renderer/components/share-dialog.ts` appends the matching per-OS hint to
its status area when a share disconnects. ICE is STUN-only
(`src/renderer/sharing/webrtc-utils.ts`: Google plus a Cloudflare fallback for
networks that block Google): LAN-only shares need no STUN at all, and an
internet share behind a symmetric NAT needs a relay — a self-hosted TURN
server, which is not shipped.
