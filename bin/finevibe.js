#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const os = require('os');

const { version } = require('../package.json');
const APP_DIR = path.join(os.homedir(), '.finevibe', 'app');
const VERSION_FILE = path.join(APP_DIR, 'version.json');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const appPathForPlatform = () => {
  if (isWin) return path.join(APP_DIR, 'FineVibe.exe');
  if (isMac) return path.join(APP_DIR, 'FineVibe.app');
  return path.join(APP_DIR, 'FineVibe.AppImage');
};
const APP_PATH = appPathForPlatform();
// P1-7 (audit plan §1(iv), FORK identity): releases come ONLY from the fork
// repo named by FINEVIBE_RELEASE_REPO. There is no built-in default — an
// unset/malformed value means no feed, and a download then fails closed
// rather than silently pulling upstream bytes into a fork install (the same
// precedence the packaged auto-updater applies).
function parseReleaseRepo(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}
const REPO = parseReleaseRepo(process.env.FINEVIBE_RELEASE_REPO);
const RELEASES_URL = REPO ? `https://github.com/${REPO}/releases` : null;
const RELEASE_API_URL = REPO
  ? `https://api.github.com/repos/${REPO}/releases/tags/v${version}`
  : null;

function getAssetName() {
  if (isWin) {
    return `FineVibe-${version}-win-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
  }
  if (isMac) {
    return process.arch === 'arm64'
      ? `FineVibe-${version}-arm64-mac.zip`
      : `FineVibe-${version}-mac.zip`;
  }
  // electron-builder expands ${arch} to `amd64` in linux artifact names
  // (builder-util toLinuxArchString); requesting `x64` 404s every install.
  // main() restricts linux to x64, so amd64 is the only published name.
  return `FineVibe-${version}-linux-amd64.AppImage`;
}

function getInstalledVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    return data.version;
  } catch {
    return null;
  }
}

// C4S-11: a half-open TCP connection (proxy dies mid-handshake, Wi-Fi drop)
// made https.get wait forever — the launcher hung with no progress and the
// DOWNLOAD_ATTEMPTS retry / fail-closed paths never fired. Destroy the
// socket after 30 s of inactivity so the request rejects and the caller
// sees a real error.
const SOCKET_TIMEOUT_MS = 30_000;

function followRedirects(url, maxRedirects = 10, headers = {}) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Too many redirects'));
    }
    // Never downgrade to http: only https targets are followed.
    if (!url.startsWith('https://')) {
      return reject(new Error(`Refusing non-HTTPS download URL: ${url}`));
    }
    const req = https.get(url, { headers: { 'User-Agent': 'finevibe-cli', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let nextUrl;
        try {
          nextUrl = new URL(res.headers.location, url).href;
        } catch {
          return reject(new Error(`Invalid redirect location from ${url}`));
        }
        resolve(followRedirects(nextUrl, maxRedirects - 1, headers));
      } else {
        resolve(res);
      }
    });
    // The timer rides the response socket too: a stall mid-download (the
    // piped body shares this socket) destroys it and surfaces as res
    // 'error', which download() already turns into cleanup + reject.
    req.setTimeout(SOCKET_TIMEOUT_MS, () => {
      req.destroy(new Error(`Socket idle for ${SOCKET_TIMEOUT_MS / 1000}s: ${url}`));
    });
    req.on('error', reject);
  });
}

function getJson(url) {
  return followRedirects(url, 10, { Accept: 'application/vnd.github+json' }).then((res) => {
    if (res.statusCode !== 200) {
      throw new Error(`GitHub API responded with status ${res.statusCode}`);
    }
    return new Promise((resolve, reject) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`GitHub API returned invalid JSON: ${err.message}`));
        }
      });
    });
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Returns 'ok' (digest published and matched), 'mismatch' (published and
// differs), or 'unavailable' (nothing to verify against: asset absent from
// the release metadata, no digest published, or the API request failed).
// P2-2: 'unavailable' is NOT a pass — see download()'s refuse-and-redownload
// loop; unverified bytes are never extracted.
async function verifyAssetDigest(tmpFile, assetName) {
  let digest;
  try {
    const release = await getJson(RELEASE_API_URL);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((a) => a && a.name === assetName);
    if (!asset) {
      console.log(`Asset ${assetName} not found in release metadata; checksum cannot be verified.`);
      return 'unavailable';
    }
    if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
      console.log(`No sha256 digest published for ${assetName}; checksum cannot be verified.`);
      return 'unavailable';
    }
    digest = asset.digest.slice('sha256:'.length).toLowerCase();
  } catch (err) {
    console.log(`Could not fetch release metadata (${err.message}); checksum cannot be verified.`);
    return 'unavailable';
  }
  const actual = await sha256File(tmpFile);
  if (actual !== digest) {
    console.error(`Checksum mismatch for ${assetName}: expected ${digest}, got ${actual}.`);
    return 'mismatch';
  }
  console.log('Checksum verified.');
  return 'ok';
}

const DOWNLOAD_ATTEMPTS = 2;

// P2-2: a download is installable only when the published sha256 digest
// confirms it. Mismatched bytes are corrupt or hostile; a missing digest
// (asset absent, none published, API outage) means we CANNOT prove the
// bytes are the real app. Both cases: delete, redownload, re-verify; after
// DOWNLOAD_ATTEMPTS attempts refuse the install — never extract unverified
// bytes, and never silently continue.
async function download(assetName) {
  const url = `${RELEASES_URL}/download/v${version}/${assetName}`;
  const tmpFile = path.join(APP_DIR, `${assetName}.tmp`);

  fs.mkdirSync(APP_DIR, { recursive: true });

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    fs.rmSync(tmpFile, { force: true });

    console.log(`Downloading FineVibe v${version} for ${process.platform}-${process.arch}...`);

    const res = await followRedirects(url);

    if (res.statusCode === 404) {
      throw new Error(`Release v${version} not found. Download manually from: ${RELEASES_URL}`);
    }
    if (res.statusCode !== 200) {
      throw new Error(`Download failed with status ${res.statusCode}`);
    }

    const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
    const totalMB = totalBytes ? (totalBytes / 1048576).toFixed(1) : null;

    const zipPath = await new Promise((resolve, reject) => {
      let receivedBytes = 0;
      const file = fs.createWriteStream(tmpFile);

      file.on('error', (err) => {
        res.destroy();
        fs.rmSync(tmpFile, { force: true });
        reject(err);
      });

      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (totalBytes) {
          const pct = Math.round((receivedBytes / totalBytes) * 100);
          const receivedMB = (receivedBytes / 1048576).toFixed(1);
          process.stdout.write(`\r  ${pct}% (${receivedMB}/${totalMB} MB)`);
        }
      });

      res.on('error', (err) => {
        file.destroy();
        fs.rmSync(tmpFile, { force: true });
        reject(err);
      });

      res.pipe(file);

      file.on('finish', () => {
        console.log('\n');
        resolve(tmpFile);
      });
    });

    const verified = await verifyAssetDigest(zipPath, assetName);
    if (verified === 'ok') {
      return zipPath;
    }
    fs.rmSync(tmpFile, { force: true });

    const reason = verified === 'mismatch'
      ? `Checksum mismatch for ${assetName}`
      : `No verifiable sha256 digest for ${assetName}`;
    if (attempt < DOWNLOAD_ATTEMPTS) {
      console.log(`${reason}; redownloading (attempt ${attempt + 1}/${DOWNLOAD_ATTEMPTS}).`);
      continue;
    }
    throw new Error(
      `${reason} after ${DOWNLOAD_ATTEMPTS} attempts. ` +
      `Refusing to install unverified bytes. Download manually from: ${RELEASES_URL}`,
    );
  }
}

function extract(zipPath) {
  console.log('Extracting...');

  fs.rmSync(APP_PATH, { recursive: true, force: true });

  if (!isMac && !isWin) {
    fs.renameSync(zipPath, APP_PATH);
    fs.chmodSync(APP_PATH, 0o755);
  } else if (isWin) {
    // Argument-array invocation: no shell string, so paths with quotes or
    // `$` (e.g. usernames) cannot be re-interpreted.
    execFileSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive', '-Force', '-Path', zipPath, '-DestinationPath', APP_DIR], { stdio: 'ignore' });
  } else {
    execFileSync('unzip', ['-oq', zipPath, '-d', APP_DIR], { stdio: 'ignore' });
  }
  if (isMac || isWin) fs.unlinkSync(zipPath);

  // Clear macOS quarantine flag
  if (isMac) {
    try {
      execFileSync('xattr', ['-rd', 'com.apple.quarantine', APP_PATH], { stdio: 'ignore' });
    } catch {
      // xattr may fail if no quarantine attribute
    }
  }

  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version }));

  // Desktop integration runs after the version stamp so a failed install
  // is never mistaken for a completed one; Linux AppImage only.
  if (!isWin && !isMac) linuxDesktopIntegration();
  console.log('Done.');
}

// Ubuntu 24.04 ships without libfuse2, the FUSE userspace library a bare
// AppImage dlopens at startup — the spawn dies with 'dlopen libfuse.so.2'
// before any window appears. /dev/fuse is the kernel-side precondition of
// the FUSE mount path; when it is missing, launch and desktop entry set
// APPIMAGE_EXTRACT_AND_RUN=1 so the AppImage runtime self-extracts to a
// temp dir — works everywhere, costs a temp copy per launch.
function fuseAvailable() {
  return fs.existsSync('/dev/fuse');
}

// Linux desktop integration: the launcher drops a bare AppImage into
// ~/.finevibe/app, so the DE never receives a .desktop entry or icons —
// Wayland/GTK docks match windows via StartupWMClass and show a generic
// icon. Extract the AppImage's own entry/icons into $XDG_DATA_HOME.
// Pure: rewrite the embedded .desktop text for the installed AppImage.
// The Exec value is replaced wholesale (AppRun-relative paths die once the
// squashfs is gone), Icon is forced to the installed hicolor theme name,
// and StartupWMClass is pinned so docks match the running window. All
// other keys (Name, Comment, Categories, MimeType, …) are preserved.
function buildDesktopEntry(embeddedContent, appPath, fuseAvailable = true) {
  const lines = embeddedContent
    ? String(embeddedContent).split(/\r?\n/)
    : [
        '[Desktop Entry]',
        'Name=FineVibe',
        'Type=Application',
        'Categories=Development;',
        'Terminal=false',
        'Comment=Tenant IDE for AI CLI tools',
      ];
  const forced = {
    Exec: fuseAvailable
      ? `Exec=${appPath} %U`
      : `Exec=env APPIMAGE_EXTRACT_AND_RUN=1 ${appPath} %U`,
    Icon: 'Icon=finevibe',
    StartupWMClass: 'StartupWMClass=FineVibe',
  };
  const seen = new Set();
  const out = lines.map((line) => {
    const key = line.slice(0, line.indexOf('='));
    if (line.startsWith(`${key}=`) && Object.prototype.hasOwnProperty.call(forced, key)) {
      seen.add(key);
      return forced[key];
    }
    return line;
  });
  for (const [key, value] of Object.entries(forced)) {
    if (!seen.has(key)) out.push(value);
  }
  return out.join('\n');
}

// Collect hicolor icon files to install: apps/*.png under any size dir,
// plus apps/*.svg under scalable/ (the electron-builder AppImage layout).
function collectIconFiles(dir, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // missing icon tree is tolerated
  }
  for (const entry of entries) {
    const source = path.join(dir, entry.name);
    const relative = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      collectIconFiles(source, relative, out);
    } else if (path.basename(path.dirname(relative)) === 'apps') {
      const scalable = path.basename(path.dirname(path.dirname(relative))) === 'scalable';
      if (entry.name.endsWith('.png') || (scalable && entry.name.endsWith('.svg'))) {
        out.push([source, relative]);
      }
    }
  }
  return out;
}

// Install icons + .desktop from an --appimage-extract tree into dataDir
// (the DE's data root). Missing icons/desktop file are tolerated: the
// generated-base entry is still written so the app is findable.
function installDesktopIntegration({ appPath, extractRoot, dataDir, fuseAvailable = true }) {
  const share = path.join(extractRoot, 'usr', 'share');
  const iconsDest = path.join(dataDir, 'icons', 'hicolor');
  for (const [source, relative] of collectIconFiles(path.join(share, 'icons', 'hicolor'), '', [])) {
    const target = path.join(iconsDest, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  let embedded = '';
  try {
    const names = fs.readdirSync(path.join(share, 'applications')).filter((n) => n.endsWith('.desktop')).sort();
    if (names.length > 0) embedded = fs.readFileSync(path.join(share, 'applications', names[0]), 'utf8');
  } catch {
    // no packaged .desktop — fall back to the generated base entry
  }
  const entryFile = path.join(dataDir, 'applications', 'finevibe.desktop');
  fs.mkdirSync(path.dirname(entryFile), { recursive: true });
  fs.writeFileSync(entryFile, buildDesktopEntry(embedded, appPath, fuseAvailable));
}

// Production wrapper: self-extract the installed AppImage into a temp dir,
// install from the squashfs-root, refresh the DE caches. Entirely
// best-effort — a failure costs desktop integration, never the launch.
function linuxDesktopIntegration() {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-desktop-'));
    try {
      execFileSync(APP_PATH, ['--appimage-extract'], { cwd: tmp, stdio: 'ignore', timeout: 180000 });
      const dataDir = process.env.XDG_DATA_HOME
        || path.join(os.homedir(), '.local', 'share');
      installDesktopIntegration({
        appPath: APP_PATH,
        extractRoot: path.join(tmp, 'squashfs-root'),
        dataDir,
        fuseAvailable: fuseAvailable(),
      });
      for (const [cmd, arg] of [
        ['update-desktop-database', path.join(dataDir, 'applications')],
        ['gtk-update-icon-cache', path.join(dataDir, 'icons', 'hicolor')],
      ]) {
        try {
          execFileSync(cmd, [arg], { stdio: 'ignore' });
        } catch {
          // cache refresh is cosmetic; the DE picks the files up anyway
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (err) {
    console.log('Desktop integration skipped: ' + err.message);
  }
}

function launch(args) {
  let child;
  if (isWin) {
    child = spawn(APP_PATH, args, {
      detached: true,
      stdio: 'ignore',
    });
  } else if (isMac) {
    child = spawn('open', [APP_PATH, '--args', ...args], {
      detached: true,
      stdio: 'ignore',
    });
  } else {
    const options = { detached: true, stdio: 'ignore' };
    if (!fuseAvailable()) {
      options.env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };
    }
    child = spawn(APP_PATH, args, options);
  }
  child.unref();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`FineVibe v${version} — Terminal-centric IDE for AI-powered CLI tools

Usage: finevibe [options]

Options:
  --update    Force re-download of the latest app build
  --version   Print version and exit
  --help      Show this help message

Any other arguments are forwarded to the FineVibe app.`);
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    const installed = getInstalledVersion();
    console.log(`finevibe v${version} (app: ${installed ? `v${installed}` : 'not installed'})`);
    return;
  }

  if (!isMac && !isWin && process.platform !== 'linux') {
    // C4S-10: never hardcode a repo URL — the feed is exactly RELEASES_URL
    // (P1-7 fork policy); with no feed configured, point at the env var.
    console.error(`Unsupported platform ${process.platform}. Download from: ${RELEASES_URL ?? 'the GitHub releases of the repository set in FINEVIBE_RELEASE_REPO (see README.md)'}`);
    process.exit(1);
  }
  if (process.platform === 'linux' && process.arch !== 'x64') {
    throw new Error(`No Linux ${process.arch} release asset is published; use an x64 system or build from source.`);
  }

  const assetName = getAssetName();
  const forceUpdate = args.includes('--update');
  const passthroughArgs = args.filter((a) => a !== '--update');

  const installedVersion = getInstalledVersion();
  const needsDownload = forceUpdate || installedVersion !== version || !fs.existsSync(APP_PATH);

  if (needsDownload) {
    if (!REPO) {
      throw new Error(
        'No release feed configured: FINEVIBE_RELEASE_REPO is unset or not "owner/repo". ' +
        'Refusing to download from a default repository — set FINEVIBE_RELEASE_REPO to the ' +
        'fork repository that publishes these releases (see README.md).',
      );
    }
    const zipPath = await download(assetName);
    extract(zipPath);
  }

  launch(passthroughArgs);
}

// Exposed for tests (npm-launcher.test.ts); never imported in production.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REPO,
    RELEASES_URL,
    RELEASE_API_URL,
    getAssetName,
    followRedirects,
    getJson,
    sha256File,
    verifyAssetDigest,
    download,
    buildDesktopEntry,
    installDesktopIntegration,
  };
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
