#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const os = require('os');

const { version } = require('../package.json');
const APP_DIR = path.join(os.homedir(), '.vibeyard', 'app');
const VERSION_FILE = path.join(APP_DIR, 'version.json');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const appPathForPlatform = () => {
  if (isWin) return path.join(APP_DIR, 'Vibeyard.exe');
  if (isMac) return path.join(APP_DIR, 'Vibeyard.app');
  return path.join(APP_DIR, 'Vibeyard.AppImage');
};
const APP_PATH = appPathForPlatform();
const REPO = process.env.VIBEYARD_RELEASE_REPO || 'elirantutia/vibeyard';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const RELEASE_API_URL = `https://api.github.com/repos/${REPO}/releases/tags/v${version}`;

function getAssetName() {
  if (isWin) {
    return `Vibeyard-${version}-win-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
  }
  if (isMac) {
    return process.arch === 'arm64'
      ? `Vibeyard-${version}-arm64-mac.zip`
      : `Vibeyard-${version}-mac.zip`;
  }
  // Linux
  return `Vibeyard-${version}-linux-${process.arch}.AppImage`;
}

function getInstalledVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    return data.version;
  } catch {
    return null;
  }
}

function followRedirects(url, maxRedirects = 10, headers = {}) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Too many redirects'));
    }
    // Never downgrade to http: only https targets are followed.
    if (!url.startsWith('https://')) {
      return reject(new Error(`Refusing non-HTTPS download URL: ${url}`));
    }
    https.get(url, { headers: { 'User-Agent': 'vibeyard-cli', ...headers } }, (res) => {
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
    }).on('error', reject);
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

// Returns true (digest matched), false (mismatch), or null (no digest
// available — GitHub API failure or asset without a published digest).
async function verifyAssetDigest(tmpFile, assetName) {
  let digest;
  try {
    const release = await getJson(RELEASE_API_URL);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((a) => a && a.name === assetName);
    if (!asset) {
      console.log(`Asset ${assetName} not found in release metadata; skipping checksum verification.`);
      return null;
    }
    if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
      console.log(`No sha256 digest published for ${assetName}; skipping checksum verification.`);
      return null;
    }
    digest = asset.digest.slice('sha256:'.length).toLowerCase();
  } catch (err) {
    // Rate limits or API outages must not brick installs.
    console.log(`Could not fetch release metadata (${err.message}); skipping checksum verification.`);
    return null;
  }
  const actual = await sha256File(tmpFile);
  if (actual !== digest) {
    console.error(`Checksum mismatch for ${assetName}: expected ${digest}, got ${actual}.`);
    return false;
  }
  console.log('Checksum verified.');
  return true;
}

async function download(assetName) {
  const url = `${RELEASES_URL}/download/v${version}/${assetName}`;
  const tmpFile = path.join(APP_DIR, `${assetName}.tmp`);

  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.rmSync(tmpFile, { force: true });

  console.log(`Downloading Vibeyard v${version} for ${process.platform}-${process.arch}...`);

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
  if (verified === false) {
    fs.rmSync(tmpFile, { force: true });
    throw new Error(`Downloaded ${assetName} failed checksum verification. Download manually from: ${RELEASES_URL}`);
  }
  return zipPath;
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
  console.log('Done.');
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
    child = spawn(APP_PATH, args, { detached: true, stdio: 'ignore' });
  }
  child.unref();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Vibeyard v${version} — Terminal-centric IDE for AI-powered CLI tools

Usage: vibeyard [options]

Options:
  --update    Force re-download of the latest app build
  --version   Print version and exit
  --help      Show this help message

Any other arguments are forwarded to the Vibeyard app.`);
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    const installed = getInstalledVersion();
    console.log(`vibeyard v${version} (app: ${installed ? `v${installed}` : 'not installed'})`);
    return;
  }

  if (!isMac && !isWin && process.platform !== 'linux') {
    console.error(`Unsupported platform ${process.platform}. Download from: ${RELEASES_URL}`);
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
  };
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
