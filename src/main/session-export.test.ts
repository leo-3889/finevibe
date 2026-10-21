import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { PassThrough } from 'stream';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import type { ArchivedSession } from '../shared/types';

const showSaveDialog = vi.fn();
vi.mock('electron', () => ({
  dialog: { showSaveDialog: (...a: unknown[]) => showSaveDialog(...a) },
  BrowserWindow: { getAllWindows: () => [] },
}));

const launchSessionDir = vi.fn((p: string, id: string) => `${p}-launch-${id}`);
vi.mock('./launch-session-dir', () => ({
  launchSessionDir: (...a: [string, string]) => launchSessionDir(...a),
}));

const statusDir = path.join(os.tmpdir(), 'finevibe-export-test-status');
vi.mock('./hook-status', () => ({
  get STATUS_DIR() { return statusDir; },
  statusFilePath: (id: string, ext: string) =>
    /^[A-Za-z0-9_-]{1,128}$/.test(id) ? path.join(statusDir, `${id}.${ext}`) : null,
}));

const getTranscriptPath = vi.fn();
vi.mock('./providers/registry', () => ({
  getProvider: () => ({ getTranscriptPath }),
}));

import { exportSessionArchive, resolveLaunchSessionDir, type SessionExportParams } from './session-export';

const win = {} as never;

function meta(over: Partial<ArchivedSession> = {}): ArchivedSession {
  return {
    id: 'a1',
    name: 'My Session',
    providerId: 'claude',
    cliSessionId: 'cli-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    closedAt: '2026-01-01T01:00:00.000Z',
    cost: null,
    ...over,
  };
}

function params(over: Partial<SessionExportParams> = {}): SessionExportParams {
  return {
    providerId: 'claude',
    cliSessionId: 'cli-1',
    projectPath: '/proj',
    configDir: '/cfg',
    meta: meta(),
    format: 'zip',
    ...over,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-export-'));
  await fs.mkdir(statusDir, { recursive: true });
  showSaveDialog.mockReset();
  launchSessionDir.mockClear();
  getTranscriptPath.mockReset();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(statusDir, { recursive: true, force: true });
});

describe('resolveLaunchSessionDir()', () => {
  it('only resolves the exclusive launch dir for Pi/OMP rows with a live session', () => {
    expect(resolveLaunchSessionDir('claude', 'ui-1')).toBeUndefined();
    expect(resolveLaunchSessionDir('pi', undefined)).toBeUndefined();
    expect(resolveLaunchSessionDir('pi', 'ui-1')).toBe('pi-launch-ui-1');
    expect(resolveLaunchSessionDir('omp', 'ui-2')).toBe('omp-launch-ui-2');
  });
});

describe('exportSessionArchive() zip', () => {
  it('bundles the verbatim transcript, meta.json and readable sidecars', async () => {
    const transcript = path.join(tmp, 't.jsonl');
    await fs.writeFile(transcript, 'A\nB');
    await fs.writeFile(path.join(statusDir, 'ui-1.status'), 'working');
    getTranscriptPath.mockReturnValue(transcript);
    const out = path.join(tmp, 'out.zip');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });

    const written = await exportSessionArchive(win, params({
      providerId: 'pi',
      meta: meta({ providerId: 'pi', liveSessionId: 'ui-1' }),
    }));

    expect(written).toBe(out);
    // Pi rows resolve through the exclusive launch dir.
    expect(getTranscriptPath).toHaveBeenCalledWith('cli-1', '/proj', '/cfg', 'pi-launch-ui-1');

    const zip = await JSZip.loadAsync(await fs.readFile(out));
    expect(await zip.file('transcript/t.jsonl')!.async('string')).toBe('A\nB');
    const metaJson = JSON.parse(await zip.file('meta.json')!.async('string'));
    expect(metaJson.format).toBe('finevibe-session-backup-v1');
    expect(metaJson.session.id).toBe('a1');
    expect(metaJson.projectPath).toBe('/proj');
    expect(await zip.file('sidecars/ui-1.status')!.async('string')).toBe('working');
    expect(zip.file('sidecars/ui-1.events')).toBeNull();
  });

  it('meta-only zip when no transcript resolves', async () => {
    getTranscriptPath.mockReturnValue(null);
    const out = path.join(tmp, 'out.zip');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });

    await exportSessionArchive(win, params({ meta: meta({ cliSessionId: null }) }));

    const zip = await JSZip.loadAsync(await fs.readFile(out));
    expect(zip.file('meta.json')).not.toBeNull();
    expect(zip.file('README.txt')).not.toBeNull();
    expect(zip.file('transcript/t.jsonl')).toBeNull();
  });

  it('returns null and writes nothing when the dialog is canceled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    const out = path.join(tmp, 'out.zip');
    const res = await exportSessionArchive(win, params());
    expect(res).toBeNull();
    await expect(fs.access(out)).rejects.toThrow();
  });

  // The transcript file can vanish while the user sits in the save dialog:
  // Codex compacts its rollouts (.jsonl -> .jsonl.zst) under ~/.codex/sessions.
  // The stream is created at zip time, so the read error surfaces mid-pipe.
  // `pipe()` returns the destination, so an error listener chained off the
  // pipe only sees write-side failures: before the fix this was an unhandled
  // 'error' event (no uncaughtException handler in src/main) and the promise
  // never settled.
  it('rejects and removes the partial zip when the zip stream errors', async () => {
    const transcript = path.join(tmp, 'rollout.jsonl');
    await fs.writeFile(transcript, 'A\nB');
    getTranscriptPath.mockReturnValue(transcript);
    const out = path.join(tmp, 'out.zip');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });
    const boom = new Error('ENOENT: transcript compacted mid-export');
    const spy = vi.spyOn(JSZip.prototype, 'generateNodeStream').mockImplementation(() => {
      const s = new PassThrough();
      // Microtask, not a timer: the executor body (which registers the error
      // handler and pipes) is synchronous, so this fires exactly after it.
      // Chunks FIRST, then the error — the ordering a real JSZip stream
      // produces: zip header/entry bytes have already been piped into the
      // destination (its fd is open and the partial file exists on disk)
      // when the compacted transcript read fails mid-stream.
      queueMicrotask(() => {
        s.write(Buffer.from('PK\u0003\u0004partial-archive-bytes'));
        s.emit('error', boom);
      });
      return s as unknown as NodeJS.ReadableStream;
    });
    try {
      await expect(exportSessionArchive(win, params())).rejects.toThrow(boom);
      // No half-written archive left behind for the user to trust. The
      // destination fd is left OPEN by `pipe()` on a source error, so this
      // pins that production closes the fd before unlinking — on Windows an
      // open handle makes the unlink EPERM and the partial zip survives.
      await expect(fs.access(out)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('exportSessionArchive() single file', () => {
  it('copies the transcript verbatim, keeping its extension', async () => {
    const transcript = path.join(tmp, 'rollout-xyz.jsonl');
    await fs.writeFile(transcript, '{"a":1}');
    getTranscriptPath.mockReturnValue(transcript);
    const out = path.join(tmp, 'copy.jsonl');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });

    const written = await exportSessionArchive(win, params({ format: 'file' }));

    expect(written).toBe(out);
    expect(await fs.readFile(out, 'utf8')).toBe('{"a":1}');
    expect(showSaveDialog.mock.calls[0][1].defaultPath).toBe('My Session-cli-1.jsonl');
  });

  it('falls back to meta.json when no transcript exists', async () => {
    getTranscriptPath.mockReturnValue(null);
    const out = path.join(tmp, 'm.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });

    await exportSessionArchive(win, params({ format: 'file' }));

    const body = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(body.format).toBe('finevibe-session-backup-v1');
    expect(body.session.id).toBe('a1');
  });

  it('resolves Pi transcripts through the launch dir', async () => {
    const transcript = path.join(tmp, 'pi.jsonl');
    await fs.writeFile(transcript, 'P');
    getTranscriptPath.mockImplementation((_id: string, _p: string, _c: string, sessionDir?: string) =>
      sessionDir === 'pi-launch-ui-9' ? transcript : null);
    const out = path.join(tmp, 'pi.jsonl');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });

    await exportSessionArchive(win, params({
      providerId: 'pi',
      format: 'file',
      meta: meta({ providerId: 'pi', liveSessionId: 'ui-9' }),
    }));

    expect(await fs.readFile(out, 'utf8')).toBe('P');
  });
});
