import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { finished } from 'stream/promises';
import type { Readable } from 'stream';
import path from 'path';
import JSZip from 'jszip';
import { dialog, BrowserWindow } from 'electron';
import type { ArchivedSession, ProviderId } from '../shared/types.js';
import { getProvider } from './providers/registry.js';
import { launchSessionDir, type LaunchSessionProvider } from './launch-session-dir.js';
import { statusFilePath } from './hook-status.js';

export type SessionExportFormat = 'zip' | 'file';

export interface SessionExportParams {
  providerId: ProviderId;
  cliSessionId: string | null;
  projectPath: string;
  configDir?: string;
  meta: ArchivedSession;
  format: SessionExportFormat;
}

/**
 * The exclusive per-launch session dir of a Pi/OMP tab, when the export
 * carries the live (or finalizing) UI session id. Their transcripts live
 * ONLY in that dir — the provider tree scan never sees them.
 */
export function resolveLaunchSessionDir(providerId: ProviderId, liveSessionId?: string): string | undefined {
  if ((providerId !== 'pi' && providerId !== 'omp') || !liveSessionId) return undefined;
  return launchSessionDir(providerId as LaunchSessionProvider, liveSessionId);
}

/** Resolve the provider-native transcript file for an export/resume request. */
export function resolveExportTranscript(
  providerId: ProviderId,
  cliSessionId: string | null,
  projectPath: string,
  configDir: string | undefined,
  liveSessionId?: string,
): string | null {
  if (!cliSessionId) return null;
  try {
    const provider = getProvider(providerId);
    if (!provider.getTranscriptPath) return null;
    return provider.getTranscriptPath(cliSessionId, projectPath, configDir, resolveLaunchSessionDir(providerId, liveSessionId));
  } catch (err) {
    console.warn(`resolveExportTranscript: getTranscriptPath failed for ${providerId}:`, err);
    return null;
  }
}

/**
 * Backup a session via a save dialog, in one of two formats:
 * - `zip`:  the provider-native transcript file (verbatim) + `meta.json`
 *   (the FineVibe history entry) + readable hook sidecars when present.
 * - `file`: the transcript alone, verbatim, as a single file (meta.json
 *   when no transcript exists, so the export is never empty).
 * The transcript is the provider's own record — FineVibe never owns a copy —
 * so exports are reference snapshots; `meta.json` carries the resume
 * coordinates (provider, CLI session id, profile config dir, project path).
 */
export async function exportSessionArchive(
  win: BrowserWindow,
  params: SessionExportParams,
): Promise<string | null> {
  const safeName = params.meta.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60) || 'session';
  const shortId = (params.cliSessionId ?? 'local').slice(0, 8);
  const transcriptPath = resolveExportTranscript(
    params.providerId,
    params.cliSessionId,
    params.projectPath,
    params.configDir,
    params.meta.liveSessionId,
  );

  const metaJson = JSON.stringify(
    {
      format: 'finevibe-session-backup-v1',
      exportedAt: new Date().toISOString(),
      projectPath: params.projectPath,
      configDir: params.configDir ?? null,
      session: params.meta,
    },
    null,
    2,
  );

  if (params.format === 'file') {
    const ext = transcriptPath ? path.extname(transcriptPath) || '.json' : '.json';
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export session as single file',
      defaultPath: `${safeName}-${shortId}${transcriptPath ? ext : '-meta.json'}`,
      filters: transcriptPath
        ? [{ name: 'Transcript', extensions: [ext.replace(/^\./, '') || 'json'] }]
        : [{ name: 'Session metadata', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    if (transcriptPath) {
      await fs.copyFile(transcriptPath, filePath);
    } else {
      await fs.writeFile(filePath, metaJson);
    }
    return filePath;
  }

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Backup session',
    defaultPath: `${safeName}-${shortId}.zip`,
    filters: [{ name: 'Zip archive', extensions: ['zip'] }],
  });
  if (canceled || !filePath) return null;

  const zip = new JSZip();
  zip.file('meta.json', metaJson);
  zip.file(
    'README.txt',
    'FineVibe session backup.\n' +
      'meta.json    - FineVibe history entry (provider, session id, profile, costs, exit info).\n' +
      (transcriptPath ? 'transcript/  - the provider-native transcript file, copied verbatim.\n' : '') +
      (params.meta.liveSessionId ? 'sidecars/    - hook event/status files; present while the session is live (cleaned up at close).\n' : '') +
      (params.cliSessionId
        ? `\nResume in FineVibe: import is not wired; the entry's providerId + cliSessionId + projectPath locate the session in the provider's own storage.\n`
        : '\nNo CLI session id was known for this session: meta.json only.\n'),
  );
  if (transcriptPath) {
    // Streamed, not buffered: transcripts grow unbounded and this runs in the
    // main process with live PTYs (docs/performance.md read-budget rule).
    zip.file(`transcript/${path.basename(transcriptPath)}`, createReadStream(transcriptPath));
  }
  for (const [name, stream] of await openSidecarStreams(params.meta.liveSessionId)) {
    zip.file(`sidecars/${name}`, stream);
  }

  // `pipe()` returns the DESTINATION, so an error listener chained off it only
  // sees write-side failures. A source-side error — the transcript file being
  // removed underneath us (Codex compacts .jsonl into .jsonl.zst while the user
  // sits in the save dialog) — then surfaces as an unhandled 'error' event on
  // the zip stream: src/main installs no uncaughtException handler, so it is a
  // crash, and this promise never settles.
  const out = createWriteStream(filePath);
  // Hoisted so the catch below can reach it: on a write-side failure the
  // promise rejects while the generator is still piped and paused, and the
  // executor's local reference is gone with it.
  let zipStream: Readable | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      zipStream = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } }) as Readable;
      zipStream.on('error', reject);
      zipStream.pipe(out);
      finished(out).then(resolve, reject);
    });
  } catch (err) {
    // A half-written zip is not a backup: leave no file the user will trust.
    // The fd MUST be closed before the unlink: `pipe()` leaves the
    // destination open when the SOURCE errors, and Windows refuses unlink()
    // on a file with an open handle (EPERM) — the partial archive survived
    // the cleanup on exactly the platform this IDE ships to. The same
    // Windows-open-handle rule runs the other way on a WRITE-side failure:
    // the generator — and through it the transcript fd it is reading — must
    // be destroyed here too, or the provider's transcript stays locked.
    zipStream?.destroy();
    out.destroy();
    await finished(out).catch(() => {});
    await fs.unlink(filePath).catch(() => {});
    throw err;
  }
  return filePath;
}

/**
 * Open `STATUS_DIR/<uiSessionId>.*` sidecars as read streams; missing files
 * are skipped. PA-20: the `.events` file is uncapped on disk (the 64 KiB
 * read budget bounds readers, not writers), so buffering all seven suffixes
 * whole spikes main-process memory during the export; JSZip's
 * `streamFiles: true` consumes each stream incrementally, exactly as the
 * transcript above already does.
 */
async function openSidecarStreams(uiSessionId: string | undefined): Promise<Array<[string, NodeJS.ReadableStream]>> {
  if (!uiSessionId) return [];
  // The id is renderer-supplied history data: the STATUS_DIR guard rejects
  // anything that could escape the directory via `..`.
  const suffixes = ['.events', '.status', '.cost', '.name', '.sessionid', '.toolfailure', '.subagents'];
  const out: Array<[string, NodeJS.ReadableStream]> = [];
  for (const suffix of suffixes) {
    const filePath = statusFilePath(uiSessionId, suffix.slice(1));
    if (filePath === null) return out;
    try {
      // Existence check only — bytes never touch memory here. Sidecars are
      // ephemeral tmp files; absent is the common case.
      await fs.stat(filePath);
    } catch {
      continue;
    }
    // A file unlinked between stat and open errors the stream mid-zip; the
    // export's stream-error path already rejects and deletes the partial
    // archive — the same exposure the transcript stream accepts.
    out.push([`${uiSessionId}${suffix}`, createReadStream(filePath)]);
  }
  return out;
}
