import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { PassThrough, Writable } from 'stream';

const launcherSource = fs.readFileSync(path.join(process.cwd(), 'bin', 'vibeyard.js'), 'utf8');
const launcherVersion = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
).version as string;

type FakeResponse = PassThrough & { statusCode: number; headers: Record<string, string> };

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
      if (name === 'fs') return fakeFs;
      if (name === 'crypto') return crypto;
      if (name === 'os') return { homedir: () => '/home/test' };
      if (name === 'path') return path;
      if (name === 'child_process') return { spawn, execSync: vi.fn() };
      if (name === '../package.json') return { version: launcherVersion };
      return {};
    },
    process: {
      platform: 'linux', arch: 'x64', argv: ['node', 'vibeyard'],
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
    return { on: vi.fn() };
  });
}

function readingFile(content: Buffer) {
  return vi.fn(() => {
    const s = new PassThrough();
    s.end(content);
    return s;
  });
}

describe('Linux npm launcher', () => {
  it('starts an installed AppImage and passes app arguments', async () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'vibeyard.js'), 'utf8');
    const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version as string;
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    const fakeFs = {
      readFileSync: vi.fn(() => JSON.stringify({ version })),
      existsSync: vi.fn(() => true),
    };
    const fakeProcess = {
      platform: 'linux', arch: 'x64', argv: ['node', 'vibeyard', '--example'],
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
      path.join('/home/test', '.vibeyard', 'app', 'Vibeyard.AppImage'),
      ['--example'],
      { detached: true, stdio: 'ignore' },
    );
    expect(fakeProcess.exit).not.toHaveBeenCalled();
  });
});

describe('launcher release repo', () => {
  it('defaults to the upstream repo', () => {
    const { exports } = loadLauncher();
    expect(exports.REPO).toBe('elirantutia/vibeyard');
    expect(exports.RELEASES_URL).toBe('https://github.com/elirantutia/vibeyard/releases');
    expect(exports.RELEASE_API_URL).toBe(
      `https://api.github.com/repos/elirantutia/vibeyard/releases/tags/v${launcherVersion}`,
    );
  });

  it('VIBEYARD_RELEASE_REPO overrides the release repo for downloads and the API', () => {
    const { exports } = loadLauncher({ env: { VIBEYARD_RELEASE_REPO: 'leo-3889/vibeyard' } });
    expect(exports.REPO).toBe('leo-3889/vibeyard');
    expect(exports.RELEASES_URL).toBe('https://github.com/leo-3889/vibeyard/releases');
    expect(exports.RELEASE_API_URL).toBe(
      `https://api.github.com/repos/leo-3889/vibeyard/releases/tags/v${launcherVersion}`,
    );
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
      return { on: vi.fn() };
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
      return { on: vi.fn() };
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
  it('sends the GitHub API Accept header and the vibeyard user agent', async () => {
    const httpsGet = vi.fn((_url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
      const res = fakeResponse();
      cb(res);
      queueMicrotask(() => res.end(JSON.stringify({ assets: [] })));
      return { on: vi.fn() };
    });
    const { exports } = loadLauncher({ httpsGet });
    const body = await exports.getJson(exports.RELEASE_API_URL);
    expect(body).toEqual({ assets: [] });
    expect(httpsGet.mock.calls[0][1]).toMatchObject({
      headers: { 'User-Agent': 'vibeyard-cli', Accept: 'application/vnd.github+json' },
    });
  });
});

describe('launcher digest verification', () => {
  const asset = `Vibeyard-${launcherVersion}-linux-x64.AppImage`;
  const content = Buffer.from('vibeyard-appimage-payload');
  const contentHex = crypto.createHash('sha256').update(content).digest('hex');

  it('passes when the published sha256 digest matches', async () => {
    const { exports, fakeFs } = loadLauncher({
      httpsGet: servingRelease([{ name: asset, digest: `sha256:${contentHex}` }]),
    });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBe(true);
  });

  it('fails when the digest does not match', async () => {
    const { exports, fakeFs, consoleError } = loadLauncher({
      httpsGet: servingRelease([{ name: asset, digest: `sha256:${'f'.repeat(64)}` }]),
    });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Checksum mismatch'));
  });

  it('proceeds with a warning when the asset has no published digest', async () => {
    const { exports, fakeFs, consoleLog } = loadLauncher({
      httpsGet: servingRelease([{ name: asset }]),
    });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBeNull();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('skipping checksum verification'));
  });

  it('proceeds with a warning when the asset is missing from the release', async () => {
    const { exports, consoleLog } = loadLauncher({
      httpsGet: servingRelease([{ name: 'Other-asset.zip', digest: `sha256:${contentHex}` }]),
    });
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBeNull();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('not found in release metadata'));
  });

  it('proceeds with a warning when the API returns an error status', async () => {
    const { exports, consoleLog } = loadLauncher({
      httpsGet: vi.fn((_url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
        const res = fakeResponse({ statusCode: 403 });
        cb(res);
        queueMicrotask(() => res.end('rate limited'));
        return { on: vi.fn() };
      }),
    });
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBeNull();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Could not fetch release metadata'));
  });

  it('proceeds with a warning when the API request errors', async () => {
    const { exports, consoleLog } = loadLauncher({
      httpsGet: vi.fn((_url: string, _opts: unknown, _cb: unknown) => ({
        on: (event: string, handler: (err: Error) => void) => {
          if (event === 'error') queueMicrotask(() => handler(new Error('ETIMEDOUT')));
        },
      })),
    });
    await expect(exports.verifyAssetDigest('/tmp/asset.tmp', asset)).resolves.toBeNull();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('ETIMEDOUT'));
  });
});

describe('launcher download', () => {
  const asset = `Vibeyard-${launcherVersion}-linux-x64.AppImage`;
  const tmpFile = path.join('/home/test', '.vibeyard', 'app', `${asset}.tmp`);
  const content = Buffer.from('vibeyard-appimage-payload');
  const contentHex = crypto.createHash('sha256').update(content).digest('hex');

  function servingDownloadAndApi(digest: string | undefined) {
    return vi.fn((url: string, _opts: unknown, cb: (res: FakeResponse) => void) => {
      const res = fakeResponse();
      cb(res);
      if (url.includes('api.github.com')) {
        const assets = digest === undefined ? [{ name: asset }] : [{ name: asset, digest }];
        queueMicrotask(() => res.end(JSON.stringify({ assets })));
      } else {
        expect(url).toBe(`https://github.com/elirantutia/vibeyard/releases/download/v${launcherVersion}/${asset}`);
        queueMicrotask(() => res.end(content));
      }
      return { on: vi.fn() };
    });
  }

  it('keeps the file when the digest matches', async () => {
    const { exports, fakeFs } = loadLauncher({ httpsGet: servingDownloadAndApi(`sha256:${contentHex}`) });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    await expect(exports.download(asset)).resolves.toBe(tmpFile);
    // only the pre-download cleanup delete runs
    expect(fakeFs.rmSync).toHaveBeenCalledTimes(1);
  });

  it('deletes the temp file and fails when the digest mismatches', async () => {
    const { exports, fakeFs } = loadLauncher({ httpsGet: servingDownloadAndApi(`sha256:${'0'.repeat(64)}`) });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    const message = await rejectsWith(exports.download(asset));
    expect(message).toMatch(/checksum verification/i);
    expect(fakeFs.rmSync).toHaveBeenLastCalledWith(tmpFile, { force: true });
    expect(fakeFs.rmSync).toHaveBeenCalledTimes(2);
  });

  it('still installs when no digest is published', async () => {
    const { exports, fakeFs, consoleLog } = loadLauncher({ httpsGet: servingDownloadAndApi(undefined) });
    fakeFs.createReadStream.mockImplementation(readingFile(content));
    await expect(exports.download(asset)).resolves.toBe(tmpFile);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('skipping checksum verification'));
  });
});
