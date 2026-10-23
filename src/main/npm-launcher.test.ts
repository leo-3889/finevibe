import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vm from 'vm';
import { PassThrough, Writable } from 'stream';

const launcherSource = fs.readFileSync(path.join(process.cwd(), 'bin', 'finevibe.js'), 'utf8');
const launcherVersion = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
).version as string;

// P1-7 (fork identity): releases come only from the fork repo named by
// FINEVIBE_RELEASE_REPO — there is no built-in default.
const forkEnv = { FINEVIBE_RELEASE_REPO: 'leo-3889/vibeyard' };

type FakeResponse = PassThrough & { statusCode: number; headers: Record<string, string> };

// C4S-11: followRedirects arms req.setTimeout(30 s) — fakes carry the handle.
function fakeRequest() {
  return { on: vi.fn(), setTimeout: vi.fn() };
}

function fakeResponse(opts: { statusCode?: number; headers?: Record<string, string> } = {}): FakeResponse {
  const res = new PassThrough() as FakeResponse;
  res.statusCode = opts.statusCode ?? 200;
  res.headers = opts.headers ?? {};
  return res;
}

function rejectsWith(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => {
      throw new Error('expected rejection, got fulfillment');
    },
    (err: { message?: string }) => String(err?.message ?? err),
  );
}

interface LoadOptions {
  env?: Record<string, string>;
  httpsGet?: Mock;
  installedVersion?: string | null;
  // Replace the fake fs wholesale — desktop-integration tests exercise
  // real readdirSync/copyFileSync against a temp-dir fixture.
  fs?: Record<string, unknown>;
}

function loadLauncher(options: LoadOptions = {}) {
  const httpsGet = options.httpsGet ?? vi.fn();
  const spawn = vi.fn(() => ({ unref: vi.fn() }));
  const fakeFs = {
    readFileSync: vi.fn(() => {
      if (options.installedVersion === null) throw new Error('missing');
      return JSON.stringify({ version: options.installedVersion ?? launcherVersion });
    }),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    renameSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
    createWriteStream: vi.fn(() => new Writable({ write(_chunk, _enc, cb) { cb(); } })),
    createReadStream: vi.fn(() => new PassThrough()),
  };
  const consoleLog = vi.fn();
  const consoleError = vi.fn();
  const context: Record<string, unknown> = {
    require: (name: string) => {
      if (name === 'https') return { get: httpsGet };
      if (name === 'http') throw new Error('launcher must never require http');
      if (name === 'fs') return options.fs ?? fakeFs;
      if (name === 'crypto') return crypto;
      if (name === 'os') return { homedir: () => '/home/test' };
      if (name === 'path') return path;
      if (name === 'child_process') return { spawn, execSync: vi.fn() };
      if (name === '../package.json') return { version: launcherVersion };
      return {};
    },
    process: {
      platform: 'linux', arch: 'x64', argv: ['node', 'finevibe'],
      env: options.env ?? {}, exit: vi.fn(), stdout: { write: vi.fn() },
    },
    console: { log: consoleLog, error: consoleError },
    module: { exports: {} },
    // URL is a Node global, not a vm-context intrinsic; the real CLI always has it.
    URL,
  };
  vm.runInNewContext(launcherSource, context);
  const exports = (context.module as { exports: Record<string, any> }).exports;
  return { exports, httpsGet, fakeFs, consoleLog, consoleError, spawn };
}

function servingRelease(assets: Array<{ name: string; digest?: string }>) {
  return vi.fn((_url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
    const res = fakeResponse();
    cb(res);
    queueMicrotask(() => res.end(JSON.stringify({ assets })));
    return fakeRequest();
  });
}

function readingFile(content: Buffer) {
  return vi.fn(() => {
    const s = new PassThrough();
    s.end(content);
    return s;
  });
}

// The launcher auto-runs main() at load; its install chain (download → extract
// → launch) is async with no exported handle, so tests wait on the observable
// end state and surface the launcher's own error output on timeout.
async function until(ready: () => boolean, diagnose: () => string = () => 'no observable result'): Promise<void> {
  for (let tick = 0; tick < 1000; tick++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`launcher never reached the expected state: ${diagnose()}`);
}

describe('Linux npm launcher', () => {
  it('starts an installed AppImage and passes app arguments', async () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'finevibe.js'), 'utf8');
    const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version as string;
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    const fakeFs = {
      readFileSync: vi.fn(() => JSON.stringify({ version })),
      existsSync: vi.fn(() => true),
    };
    const fakeProcess = {
      platform: 'linux', arch: 'x64', argv: ['node', 'finevibe', '--example'],
      env: {}, exit: vi.fn(), stdout: { write: vi.fn() },
    };
    const context = {
      require: (name: string) => {
        if (name === 'fs') return fakeFs;
        if (name === 'os') return { homedir: () => '/home/test' };
        if (name === 'path') return path;
        if (name === 'child_process') return { spawn, execSync: vi.fn() };
        if (name === '../package.json') return { version };
        return {};
      },
      process: fakeProcess,
      console: { log: vi.fn(), error: vi.fn() },
    };
    await vm.runInNewContext(source, context);
    expect(spawn).toHaveBeenCalledWith(
      path.join('/home/test', '.finevibe', 'app', 'FineVibe.AppImage'),
      ['--example'],
      { detached: true, stdio: 'ignore' },
    );
    expect(fakeProcess.exit).not.toHaveBeenCalled();
  });

  // Ubuntu 24.04 ships without libfuse2: a bare AppImage spawn dies with
  // 'dlopen libfuse.so.2'. Without /dev/fuse the launcher must set
  // APPIMAGE_EXTRACT_AND_RUN=1 so the runtime extracts to temp (works
  // everywhere, costs a temp copy) instead of mounting via FUSE.
  it('launches with APPIMAGE_EXTRACT_AND_RUN when /dev/fuse is missing', async () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'finevibe.js'), 'utf8');
    const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version as string;
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    const fakeFs = {
      readFileSync: vi.fn(() => JSON.stringify({ version })),
      existsSync: vi.fn((p: string) => p !== '/dev/fuse'),
    };
    const context = {
      require: (name: string) => {
        if (name === 'fs') return fakeFs;
        if (name === 'os') return { homedir: () => '/home/test' };
        if (name === 'path') return path;
        if (name === 'child_process') return { spawn, execSync: vi.fn() };
        if (name === '../package.json') return { version };
        return {};
      },
      process: {
        platform: 'linux', arch: 'x64', argv: ['node', 'finevibe', '--example'],
        env: {}, exit: vi.fn(), stdout: { write: vi.fn() },
      },
      console: { log: vi.fn(), error: vi.fn() },
    };
    await vm.runInNewContext(source, context);
    expect(spawn).toHaveBeenCalledWith(
      path.join('/home/test', '.finevibe', 'app', 'FineVibe.AppImage'),
      ['--example'],
      { detached: true, stdio: 'ignore', env: { APPIMAGE_EXTRACT_AND_RUN: '1' } },
    );
  });
});

describe('launcher release repo', () => {
  // P2-77/P1-7 retarget (plan §1(iv), FORK identity): the previously pinned
  // "defaults to the upstream repo" behavior is the bug — a fork launcher
  // must never download from the upstream feed. Unset/malformed = no feed,
  // and a fresh install then refuses to download.
  it('has no release feed when FINEVIBE_RELEASE_REPO is unset', () => {
    const { exports } = loadLauncher();
    expect(exports.REPO).toBeNull();
    expect(exports.RELEASES_URL).toBeNull();
    expect(exports.RELEASE_API_URL).toBeNull();
  });

  it('has no release feed for a malformed FINEVIBE_RELEASE_REPO', () => {
    const { exports } = loadLauncher({ env: { FINEVIBE_RELEASE_REPO: 'not-a-slug' } });
    expect(exports.REPO).toBeNull();
    expect(exports.RELEASES_URL).toBeNull();
  });

  it('FINEVIBE_RELEASE_REPO points downloads and the API at the fork repo', () => {
    const { exports } = loadLauncher({ env: forkEnv });
    expect(exports.REPO).toBe('leo-3889/vibeyard');
    expect(exports.RELEASES_URL).toBe('https://github.com/leo-3889/vibeyard/releases');
    expect(exports.RELEASE_API_URL).toBe(
      `https://api.github.com/repos/leo-3889/vibeyard/releases/tags/v${launcherVersion}`,
    );
  });

  it('refuses the download on a fresh install with no feed configured', async () => {
    const httpsGet = vi.fn();
    const { consoleError, spawn } = loadLauncher({ env: {}, installedVersion: null, httpsGet });
    await until(
      () => consoleError.mock.calls.length > 0,
      () => 'launcher neither reported an error nor launched',
    );
    const message = consoleError.mock.calls.map((call) => String(call[0])).join('\n');
    expect(message).toMatch(/FINEVIBE_RELEASE_REPO/);
    expect(httpsGet).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('launcher followRedirects', () => {
  it('follows https redirects, including relative locations', async () => {
    const finalRes = fakeResponse();
    const httpsGet = vi.fn((url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
      if (url === 'https://github.com/o/r/releases/download/v1/asset.zip') {
        cb(fakeResponse({ statusCode: 302, headers: { location: '/redirected/asset.zip' } }));
      } else if (url === 'https://github.com/redirected/asset.zip') {
        cb(fakeResponse({ statusCode: 302, headers: { location: 'https://objects.example.com/asset.zip' } }));
      } else {
        cb(finalRes);
      }
      return fakeRequest();
    });
    const { exports } = loadLauncher({ httpsGet });
    const res = await exports.followRedirects('https://github.com/o/r/releases/download/v1/asset.zip');
    expect(res).toBe(finalRes);
    expect(httpsGet.mock.calls.map((c) => c[0])).toEqual([
      'https://github.com/o/r/releases/download/v1/asset.zip',
      'https://github.com/redirected/asset.zip',
      'https://objects.example.com/asset.zip',
    ]);
  });

  it('rejects a redirect that downgrades to http', async () => {
    const httpsGet = vi.fn((_url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
      cb(fakeResponse({ statusCode: 302, headers: { location: 'http://evil.example/asset.zip' } }));
      return fakeRequest();
    });
    const { exports } = loadLauncher({ httpsGet });
    const message = await rejectsWith(
      exports.followRedirects('https://github.com/o/r/releases/download/v1/asset.zip'),
    );
    expect(message).toMatch(/non-HTTPS/i);
    expect(httpsGet).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-https initial URL without any request', async () => {
    const { exports, httpsGet } = loadLauncher();
    const message = await rejectsWith(exports.followRedirects('http://example.com/asset.zip'));
    expect(message).toMatch(/non-HTTPS/i);
    expect(httpsGet).not.toHaveBeenCalled();
  });
});

describe('launcher getJson', () => {
  it('sends the GitHub API Accept header and the finevibe user agent', async () => {
    const httpsGet = vi.fn((_url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
      const res = fakeResponse();
      cb(res);
      queueMicrotask(() => res.end(JSON.stringify({ assets: [] })));
      return fakeRequest();
    });
    const { exports } = loadLauncher({ env: forkEnv, httpsGet });
    const body = await exports.getJson(exports.RELEASE_API_URL);
    expect(body).toEqual({ assets: [] });
    expect(httpsGet.mock.calls[0][1]).toMatchObject({
      headers: { 'User-Agent': 'finevibe-cli', Accept: 'application/vnd.github+json' },
    });
  });
});

describe('launcher digest verification', () => {
  const asset = `FineVibe-${launcherVersion}-linux-x64.AppImage`;
  const content = Buffer.from('finevibe-appimage-payload');
  const contentHex = crypto.createHash('sha256').update(content).digest('hex');

  it('passes when the published sha256 digest matches', async () => {
    const { exports, fakeFs } = loadLauncher({
      env: forkEnv,
      httpsGet: servingRelease([{ name: asset, digest: `sha256:${contentHex}` }]),
    });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBe('ok');
  });

  it('fails when the digest does not match', async () => {
    const { exports, fakeFs, consoleError } = loadLauncher({
      env: forkEnv,
      httpsGet: servingRelease([{ name: asset, digest: `sha256:${'f'.repeat(64)}` }]),
    });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBe('mismatch');
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Checksum mismatch'));
  });

  // P2-2: a missing digest is 'unavailable', NOT a silent pass. download()
  // turns every non-'ok' into refuse-and-redownload.
  it('reports unavailable when the asset has no published digest', async () => {
    const { exports, fakeFs, consoleLog } = loadLauncher({
      env: forkEnv,
      httpsGet: servingRelease([{ name: asset }]),
    });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBe('unavailable');
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('cannot be verified'));
  });

  it('reports unavailable when the asset is missing from the release', async () => {
    const { exports, consoleLog } = loadLauncher({
      env: forkEnv,
      httpsGet: servingRelease([{ name: 'Other-asset.zip', digest: `sha256:${contentHex}` }]),
    });
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBe('unavailable');
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('not found in release metadata'));
  });

  it('reports unavailable when the API returns an error status', async () => {
    const { exports, consoleLog } = loadLauncher({
      env: forkEnv,
      httpsGet: vi.fn((_url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
        const res = fakeResponse({ statusCode: 403 });
        cb(res);
        queueMicrotask(() => res.end('rate limited'));
        return fakeRequest();
      }),
    });
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBe('unavailable');
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Could not fetch release metadata'));
  });

  it('reports unavailable when the API request errors', async () => {
    const { exports, consoleLog } = loadLauncher({
      env: forkEnv,
      httpsGet: vi.fn((_url: string, _opts: unknown, _cb: unknown) => ({
        on: (event: string, handler: (err: Error) => void) => {
          if (event === 'error') queueMicrotask(() => handler(new Error('ETIMEDOUT')));
        },
        setTimeout: vi.fn(),
      })),
    });
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBe('unavailable');
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('ETIMEDOUT'));
  });
});

describe('launcher download', () => {
  const asset = `FineVibe-${launcherVersion}-linux-x64.AppImage`;
  const tmpFile = path.join('/home/test', '.finevibe', 'app', `${asset}.tmp`);
  const content = Buffer.from('finevibe-appimage-payload');
  const contentHex = crypto.createHash('sha256').update(content).digest('hex');

  function servingDownloadAndApi(digest: string | undefined) {
    return vi.fn((url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
      const res = fakeResponse();
      cb(res);
      if (url.includes('api.github.com')) {
        const assets = digest === undefined ? [{ name: asset }] : [{ name: asset, digest }];
        queueMicrotask(() => res.end(JSON.stringify({ assets })));
      } else {
        expect(url).toBe(`https://github.com/leo-3889/vibeyard/releases/download/v${launcherVersion}/${asset}`);
        queueMicrotask(() => res.end(content));
      }
      return fakeRequest();
    });
  }

  it('keeps the file when the digest matches', async () => {
    const { exports, fakeFs } = loadLauncher({ env: forkEnv, httpsGet: servingDownloadAndApi(`sha256:${contentHex}`) });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    await expect(exports.download(asset)).resolves.toBe(tmpFile);
    // only the pre-download cleanup delete runs
    expect(fakeFs.rmSync).toHaveBeenCalledTimes(1);
  });

  it('redownloads once, then refuses when the digest mismatches', async () => {
    const { exports, fakeFs, httpsGet } = loadLauncher({
      env: forkEnv,
      httpsGet: servingDownloadAndApi(`sha256:${'0'.repeat(64)}`),
    });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    const message = await rejectsWith(exports.download(asset));
    expect(message).toMatch(/Refusing to install unverified bytes/i);
    expect(message).toMatch(/Checksum mismatch/i);
    expect(fakeFs.rmSync).toHaveBeenLastCalledWith(tmpFile, { force: true });
    // 2 attempts × (pre-download cleanup + post-failure delete)
    expect(fakeFs.rmSync).toHaveBeenCalledTimes(4);
    const downloads = httpsGet.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => !url.includes('api.github.com'));
    expect(downloads).toHaveLength(2);
  });

  // P2-2 regression: an unpublished digest used to fail OPEN — the launcher
  // logged "skipping checksum verification" and installed the bytes.
  it('refuses to install when no digest is published', async () => {
    const { exports, fakeFs, consoleLog, httpsGet } = loadLauncher({
      env: forkEnv,
      httpsGet: servingDownloadAndApi(undefined),
    });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    const message = await rejectsWith(exports.download(asset));
    expect(message).toMatch(/Refusing to install unverified bytes/i);
    expect(message).toMatch(/No verifiable sha256 digest/i);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('cannot be verified'));
    expect(fakeFs.rmSync).toHaveBeenLastCalledWith(tmpFile, { force: true });
    const downloads = httpsGet.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => !url.includes('api.github.com'));
    expect(downloads).toHaveLength(2);
  });

  it('installs when the redownload verifies (transient corruption/API)', async () => {
    const good = Buffer.from('finevibe-appimage-payload-good');
    const goodHex = crypto.createHash('sha256').update(good).digest('hex');
    const { exports, fakeFs, httpsGet } = loadLauncher({
      env: forkEnv,
      httpsGet: servingDownloadAndApi(`sha256:${goodHex}`),
    });
    // Attempt 1 hashes corrupt bytes → mismatch → redownload; attempt 2 the
    // verified bytes install.
    let reads = 0;
    fakeFs.createReadStream.mockImplementation(() => readingFile(reads++ === 0 ? content : good)());
    await expect(exports.download(asset)).resolves.toBe(tmpFile);
    const downloads = httpsGet.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => !url.includes('api.github.com'));
    expect(downloads).toHaveLength(2);
  });
});

describe('launcher linux asset name', () => {
  // electron-builder publishes the linux artifact as `-linux-amd64`; a launcher
  // asking for `-linux-x64` gets a 404 and every fresh install fails.
  const amd64Asset = `FineVibe-${launcherVersion}-linux-amd64.AppImage`;
  const appDir = path.join('/home/test', '.finevibe', 'app');
  const appPath = path.join(appDir, 'FineVibe.AppImage');
  const content = Buffer.from('finevibe-appimage-payload');
  const contentHex = crypto.createHash('sha256').update(content).digest('hex');

  function servingAmd64Only() {
    const downloadUrl = `https://github.com/leo-3889/vibeyard/releases/download/v${launcherVersion}/${amd64Asset}`;
    const apiUrl = `https://api.github.com/repos/leo-3889/vibeyard/releases/tags/v${launcherVersion}`;
    const httpsGet = vi.fn((url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
      const known = url === downloadUrl || url === apiUrl;
      const res = fakeResponse(known ? {} : { statusCode: 404 });
      cb(res);
      queueMicrotask(() => {
        if (url === apiUrl) res.end(JSON.stringify({ assets: [{ name: amd64Asset, digest: `sha256:${contentHex}` }] }));
        else if (url === downloadUrl) res.end(content);
        else res.end('Not Found');
      });
      return fakeRequest();
    });
    return { httpsGet, downloadUrl, apiUrl };
  }

  it('asks the release API for the linux-amd64 asset name on linux/x64', () => {
    const { exports } = loadLauncher();
    expect(exports.getAssetName()).toBe(amd64Asset);
  });

  it('downloads and installs the linux-amd64 AppImage on a fresh linux install', async () => {
    const { httpsGet, downloadUrl, apiUrl } = servingAmd64Only();
    const { exports, fakeFs, consoleError, spawn } = loadLauncher({ env: forkEnv, httpsGet, installedVersion: null });
    fakeFs.createReadStream.mockImplementation(readingFile(content));

    // A stale asset name 404s, so `until` reports the launcher's own error text;
    // the generous timeout keeps that message ahead of vitest's default 5s.
    await until(
      () => spawn.mock.calls.length > 0,
      () => consoleError.mock.calls.map((call) => String(call[0])).join('\n') || 'no launch and no launcher error',
    );

    const requested = httpsGet.mock.calls.map((call) => String(call[0]));
    expect(requested).toContain(downloadUrl);
    expect(requested).toContain(apiUrl);
    expect(requested.filter((url) => url.includes('-linux-x64'))).toEqual([]);

    // The downloaded asset becomes the AppImage the launcher runs.
    expect(fakeFs.renameSync).toHaveBeenCalledWith(path.join(appDir, `${amd64Asset}.tmp`), appPath);
    expect(fakeFs.chmodSync).toHaveBeenCalledWith(appPath, 0o755);
    expect(fakeFs.writeFileSync).toHaveBeenCalledWith(
      path.join(appDir, 'version.json'),
      JSON.stringify({ version: launcherVersion }),
    );
    expect(spawn).toHaveBeenCalledWith(appPath, [], { detached: true, stdio: 'ignore' });
    expect(consoleError).not.toHaveBeenCalled();
    expect(exports.RELEASE_API_URL).toBe(apiUrl);
  }, 15000);
});

describe('launcher linux desktop entry', () => {
  // Linux icon bug: the AppImage's embedded .desktop points at AppRun
  // paths that die with the squashfs, and Wayland/GTK docks match windows
  // via StartupWMClass — without a corrected entry the app is a generic
  // icon (or invisible) in the launcher.
  const appPath = '/home/test/.finevibe/app/FineVibe.AppImage';

  function builtEntry() {
    const { exports } = loadLauncher();
    return exports.buildDesktopEntry(
      [
        '[Desktop Entry]',
        'Name=FineVibe',
        'Type=Application',
        'Exec=AppRun --appimage-extract-and-run %U',
        'Icon=old-icon',
        'Categories=Development;IDE;',
        'MimeType=x-scheme-handler/finevibe;',
        'Comment=Tenant IDE for AI CLI tools',
      ].join('\n'),
      appPath,
    );
  }

  it('rewrites Exec to the absolute AppImage path and forces Icon=finevibe', () => {
    const text = builtEntry();
    expect(text).toContain(`Exec=${appPath} %U`);
    expect(text).not.toContain('AppRun');
    expect(text).toContain('Icon=finevibe');
    expect(text).not.toContain('Icon=old-icon');
  });

  it('adds StartupWMClass=FineVibe and preserves unrelated keys', () => {
    const text = builtEntry();
    expect(text).toContain('StartupWMClass=FineVibe');
    expect(text).toContain('Name=FineVibe');
    expect(text).toContain('Categories=Development;IDE;');
    expect(text).toContain('MimeType=x-scheme-handler/finevibe;');
    expect(text).toContain('Comment=Tenant IDE for AI CLI tools');
  });

  // No FUSE (Ubuntu 24.04 without libfuse2): the installed entry must
  // launch through the runtime's self-extraction path, mirroring the
  // launcher's own spawn fallback. The param defaults to true (plain Exec,
  // covered by the tests above).
  it('prefixes Exec with env APPIMAGE_EXTRACT_AND_RUN=1 when FUSE is unavailable', () => {
    const { exports } = loadLauncher();
    const text = exports.buildDesktopEntry('[Desktop Entry]\nExec=AppRun %U\n', appPath, false);
    expect(text).toContain(`Exec=env APPIMAGE_EXTRACT_AND_RUN=1 ${appPath} %U`);
    expect(text).not.toContain(`\nExec=${appPath} %U\n`);
    expect(text).toContain('Icon=finevibe');
  });

  it('generates a valid base entry from empty embedded content', () => {
    const { exports } = loadLauncher();
    const text = exports.buildDesktopEntry('', appPath);
    expect(text).toContain('[Desktop Entry]');
    expect(text).toContain('Name=FineVibe');
    expect(text).toContain('Type=Application');
    expect(text).toContain('Categories=Development;');
    expect(text).toContain('Terminal=false');
    expect(text).toContain('Comment=Tenant IDE for AI CLI tools');
    expect(text).toContain(`Exec=${appPath} %U`);
    expect(text).toContain('Icon=finevibe');
    expect(text).toContain('StartupWMClass=FineVibe');
  });
});

describe('launcher linux desktop install', () => {
  // The DE only surfaces apps whose .desktop and icons live under
  // $XDG_DATA_HOME; installDesktopIntegration writes them from an
  // --appimage-extract fixture. No AppImage is executed and no network
  // is touched: the fixture is plain files under os.tmpdir().
  const appPath = '/home/test/.finevibe/app/FineVibe.AppImage';

  it('copies hicolor icons to the same relpath and writes the rewritten entry', () => {
    const { exports } = loadLauncher({ fs: fs as unknown as Record<string, unknown> });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-desktop-test-'));
    try {
      const share = path.join(root, 'squashfs-root', 'usr', 'share');
      const iconsDir = path.join(share, 'icons', 'hicolor', '256x256', 'apps');
      fs.mkdirSync(iconsDir, { recursive: true });
      fs.writeFileSync(path.join(iconsDir, 'X.png'), 'png-bytes');
      const appsDir = path.join(share, 'applications');
      fs.mkdirSync(appsDir, { recursive: true });
      fs.writeFileSync(
        path.join(appsDir, 'finevibe.desktop'),
        ['[Desktop Entry]', 'Name=FineVibe', 'Exec=AppRun %U', 'MimeType=x-scheme-handler/finevibe;'].join('\n'),
      );

      const dataDir = path.join(root, 'data');
      exports.installDesktopIntegration({ appPath, extractRoot: path.join(root, 'squashfs-root'), dataDir });

      expect(
        fs.readFileSync(path.join(dataDir, 'icons', 'hicolor', '256x256', 'apps', 'X.png'), 'utf8'),
      ).toBe('png-bytes');
      const desktop = fs.readFileSync(path.join(dataDir, 'applications', 'finevibe.desktop'), 'utf8');
      expect(desktop).toContain(`Exec=${appPath} %U`);
      expect(desktop).toContain('Icon=finevibe');
      expect(desktop).toContain('StartupWMClass=FineVibe');
      expect(desktop).toContain('MimeType=x-scheme-handler/finevibe;');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('tolerates a missing icon tree and desktop file', () => {
    const { exports } = loadLauncher({ fs: fs as unknown as Record<string, unknown> });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-desktop-test-'));
    try {
      const dataDir = path.join(root, 'data');
      exports.installDesktopIntegration({ appPath, extractRoot: path.join(root, 'squashfs-root'), dataDir });
      const desktop = fs.readFileSync(path.join(dataDir, 'applications', 'finevibe.desktop'), 'utf8');
      expect(desktop).toContain('[Desktop Entry]');
      expect(desktop).toContain('Name=FineVibe');
      expect(desktop).toContain(`Exec=${appPath} %U`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('published launcher manifest', () => {
  // P2-14 (audit plan §6): the npm package is the thin launcher — a
  // downloader for the packaged app (bin/finevibe.js never links any of
  // the app's runtime deps). The PUBLISHED manifest must carry zero app
  // dependencies: shipping them made `npm i -g finevibe` resolve 16 app
  // packages and compile native modules (better-sqlite3, node-pty) on the
  // user's machine. P2-6: the publish step must run with --provenance,
  // which needs the runner's OIDC id-token. These tests pin the
  // publish-npm job contract in release.yml; they are the gate for the
  // manifest strip living in CI (the repo's own package.json keeps
  // "dependencies" for the electron-builder app package).
  const releaseWorkflow = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  // publish-npm is the last job in the file; slice from its key to EOF.
  const npmJob = releaseWorkflow.slice(releaseWorkflow.indexOf('  publish-npm:'));

  it('ships only bin/ plus docs in the tarball', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.files).toEqual(['bin/', 'README.md', 'LICENSE']);
    expect(pkg.bin).toEqual({ finevibe: 'bin/finevibe.js' });
  });

  it('strips app dependencies from the manifest handed to npm', () => {
    expect(npmJob).toMatch(/delete pkg\.dependencies/);
    expect(npmJob).toMatch(/delete pkg\.devDependencies/);
    expect(npmJob).toMatch(/delete pkg\.scripts/);
  });

  it('publishes with provenance and the OIDC token permission', () => {
    expect(npmJob).toMatch(/npm publish --provenance/);
    expect(npmJob).toMatch(/id-token: write/);
  });
});
