/**
 * Row 26 slice 4: the 18 `hosts:*` IPC registrations.
 *
 * Follows the seam contract of leaf-domains.ts / app-domains.ts /
 * support-domains.ts: channels stay string literals
 * (`ipc-channel-parity.test.ts` scans all of src/main, so both ends stay
 * pinned), handler bodies are a verbatim move, and nothing imports back into
 * `ipc-handlers.ts`.
 *
 * The hosts block closes over exactly one value from `registerIpcHandlers`:
 * the `ptyDataSink` coalescer factory (shared with the `pty:*` handlers, so it
 * stays there and arrives as `createPtyDataSink`). Everything else it uses —
 * host-registry, enrollment, settings-sync, remote-fs, keys, secrets,
 * pty-manager, main-window — is a module, not closure state, and is imported
 * directly (the slice-3 precedent).
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import { getHost, listHosts, createHost, updateHost, deleteHost } from '../hosts/host-registry';
import { enrollHost, testHost, unenrollHost } from '../hosts/enrollment';
import { syncSettingsToHost } from '../hosts/settings-sync';
import { cloneRemoteRepo, ensureRemoteDir, listRemoteDirs, statRemotePath } from '../hosts/remote-fs';
import { generateManagedKeypair } from '../hosts/keys';
import { deleteHostSecret, setHostSecret, secretsAvailable } from '../hosts/secrets';
import { spawnShellPty } from '../pty-manager';
import { getMainWindow } from '../main-window';
import { SPAWN_REJECTED_EXIT_REASON } from '../../shared/constants';
import type { ProviderId } from '../../shared/types';

export interface HostsDomainsDeps {
  /** Coalescing pty sink factory from ipc-handlers (shared with the pty:* handlers). */
  createPtyDataSink: (
    getWindow: () => BrowserWindow | null | undefined,
    sessionId: string,
  ) => ((data: string) => void) & { flush(): void };
}

export function registerHostsDomains(deps: HostsDomainsDeps): void {
  // ---- Multi-host Phase 1: hosts registry --------------------------------
  // Secrets never cross these channels (secrets.ts is write-only over IPC);
  // every mutation re-validates through the shared validateHostRecordShape.
  ipcMain.handle('hosts:list', () => listHosts());

  ipcMain.handle('hosts:create', (_event, draft: unknown) => createHost(draft));

  ipcMain.handle('hosts:update', (_event, id: string, patch: Record<string, unknown>) =>
    updateHost(id, patch),
  );

  ipcMain.handle('hosts:delete', (_event, id: string) => {
    deleteHost(id);
  });

  // Open a plain `ssh -tt` shell tab on an enrolled host (Phase 1 verb).
  // The remote gate is the enrolled HostRecord itself — the P1-15
  // local-project check does not apply to remote cwds (council R-1); the
  // remote cwd is the record's defaultFolder (fallback: remote home).
  ipcMain.handle('hosts:openShell', (_event, id: string, sessionId: string) => {
    const win = getMainWindow();
    if (!win) return;
    const record = getHost(id);
    if (!record || record.enrollmentStatus !== 'enrolled') {
      console.warn(`hosts:openShell blocked: ${id} is not an enrolled host`);
      win.webContents.send('pty:data', sessionId, '\r\n\x1b[31mRefused: host is not enrolled.\x1b[0m\r\n');
      win.webContents.send('pty:exit', sessionId, 1, undefined, SPAWN_REJECTED_EXIT_REASON, undefined);
      return;
    }
    const dataSink = deps.createPtyDataSink(() => getMainWindow(), sessionId);
    spawnShellPty(
      sessionId,
      process.cwd(),
      dataSink,
      (exitCode, signal) => {
        dataSink.flush();
        const w = getMainWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send('pty:exit', sessionId, exitCode, signal);
        }
      },
      { host: record.host, port: record.port, defaultFolder: record.defaultFolder },
    );
  });

  // Secret storage availability for the wizard (R1: key-auth-only banner).
  ipcMain.handle('hosts:secretsAvailable', () => secretsAvailable());

  // Generate a finevibe-owned ed25519 pair under <userData>/hosts/<id>/ for
  // a host the wizard is about to create; returns the draft seeds.
  ipcMain.handle('hosts:generateKey', () => {
    const id = crypto.randomUUID();
    const { privateKeyPath, publicKeyPath } = generateManagedKeypair(app.getPath('userData'), id);
    const publicKey = fs.readFileSync(publicKeyPath, 'utf8').trim();
    return { id, privateKeyPath, publicKey };
  });

  // Store a wizard-entered secret: password under <id>, key passphrase
  // under keypass:<id>. Write-only over IPC (never returned).
  ipcMain.handle('hosts:setSecret', (_event, id: string, kind: 'password' | 'keypass', secret: string) => {
    setHostSecret(kind === 'keypass' ? `keypass:${id}` : id, secret);
  });

  ipcMain.handle('hosts:forgetPassword', (_event, id: string) => {
    deleteHostSecret(id);
  });

  ipcMain.handle('hosts:test', async (_event, id: string) => {
    const record = getHost(id);
    if (!record) return { ok: false, hostKeyChanged: false, steps: [{ step: 'record', ok: false, detail: 'unknown host' }] };
    return testHost(record);
  });

  // TOFU accept after the wizard showed the fingerprint (§4 step 2).
  ipcMain.handle('hosts:approveHostKey', (_event, id: string, fingerprint: string) => {
    if (!getHost(id)) return null;
    return updateHost(id, { hostKeyFingerprint: fingerprint });
  });

  ipcMain.handle('hosts:enroll', async (_event, id: string, opts?: { pin?: string }) => {
    const record = getHost(id);
    if (!record) return { ok: false, steps: [{ step: 'record', ok: false, detail: 'unknown host' }] };
    const emit = (event: { id: string; status: string; detail?: string }) => {
      const w = getMainWindow();
      if (w && !w.isDestroyed()) w.webContents.send('hosts:status', event);
    };
    return enrollHost(record, emit, opts);
  });

  ipcMain.handle('hosts:unenroll', async (_event, id: string) => {
    const record = getHost(id);
    if (!record) return { ok: false, detail: 'unknown host' };
    return unenrollHost(record);
  });

  // Settings push (per-host providers T3, UR-5): the renderer sends ids
  // only — the bundle builder owns the file set, main owns every read/write.
  // `confirmOverwrite` is the drift dialog's Overwrite answer (plan §4).
  ipcMain.handle('hosts:syncSettings', async (_event, id: string, providerIds: unknown, confirmOverwrite?: boolean) => {
    const record = getHost(id);
    if (!record) return { ok: false, steps: [{ step: 'record', ok: false, detail: 'unknown host' }] };
    if (!Array.isArray(providerIds)) return { ok: false, steps: [{ step: 'sync', ok: false, detail: 'providerIds must be an array' }] };
    return await syncSettingsToHost(record, providerIds.filter((p): p is ProviderId => typeof p === 'string'), {
      confirmOverwrite: confirmOverwrite === true,
    });
  });

  // Remote open/add folder (per-host providers T5, plan §6, UR-6): the
  // Add-project modal's verbs under a non-local tab. Ids + strings only —
  // remote-fs.ts owns the path normalization, the traversal gate, the argv
  // and the quoting. NO enumerate-confirm here on purpose: the local
  // fs:listDirs confirm (P1-19) is a LOCAL privacy concept (enumerating the
  // user's own disk outside the home tree); on a registry host the consent is
  // the enrolled HostRecord itself — the user created it, pinned its key and
  // ran the enrollment — which is the same gate hosts:openShell and
  // settings-sync run (council R-1). remote-fs.ts' gateHost is the single
  // place that answers it (host exists + enrolled|partial).
  ipcMain.handle('hosts:listDirs', (_event, id: unknown, dirPath: unknown, prefix?: unknown) =>
    listRemoteDirs(id, dirPath, typeof prefix === 'string' ? prefix : undefined),
  );

  ipcMain.handle('hosts:stat', (_event, id: unknown, target: unknown) =>
    statRemotePath(id, target),
  );

  ipcMain.handle('hosts:ensureDir', (_event, id: unknown, dirPath: unknown) =>
    ensureRemoteDir(id, dirPath),
  );

  ipcMain.handle('hosts:cloneRepo', (_event, id: unknown, url: unknown, destPath: unknown) =>
    cloneRemoteRepo(id, url, destPath),
  );
}
