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
import { HostValidationError, getHost, listHosts, createHost, updateHost, deleteHost } from '../hosts/host-registry';
import { enrollHost, testHost, unenrollHost } from '../hosts/enrollment';
import { syncSettingsToHost } from '../hosts/settings-sync';
import { cloneRemoteRepo, ensureRemoteDir, listRemoteDirs, statRemotePath, invalidateRemoteHome } from '../hosts/remote-fs';
import { generateManagedKeypair, isManagedKeyPath, isRendererKeyPathAllowed } from '../hosts/keys';
import { deleteHostSecret, setHostSecret, secretsAvailable } from '../hosts/secrets';
import { spawnShellPty } from '../pty-manager';
import { getMainWindow } from '../main-window';
import { SPAWN_REJECTED_EXIT_REASON } from '../../shared/constants';
import type { HostRecord, ProviderId } from '../../shared/types';

export interface HostsDomainsDeps {
  /** Coalescing pty sink factory from ipc-handlers (shared with the pty:* handlers). */
  createPtyDataSink: (
    getWindow: () => BrowserWindow | null | undefined,
    sessionId: string,
  ) => ((data: string) => void) & { flush(): void };
}

/**
 * Audit row 31: the fields the renderer may write through `hosts:update` — the
 * add/edit form's own set, nothing else. Every other HostRecord field is
 * main-owned, and the stripped ones are consent gates: `enrollmentStatus:
 * 'enrolled'` would skip the whole enrollment state machine (hosts:openShell
 * and remote-fs' gateHost key on it), `hostKeyFingerprint` is the TOFU pin
 * (hosts:approveHostKey is its only writer) and `prerequisites[].path`
 * interpolates into remote commands.
 */
const HOST_EDITABLE_FIELDS = ['name', 'user', 'host', 'port', 'authKind', 'color', 'privateKeyPath', 'defaultFolder', 'settingsSync'] as const;

/**
 * Audit row 32: a pin is exactly {@link fingerprintOf} output — `SHA256:` plus
 * the base64 of a 32-byte SHA-256 (43 chars + one '='). The empty string is
 * the dangerous value: ssh-client reads a falsy `hostKeyFingerprint` as
 * "nothing pinned yet", so approving with '' silently DISABLES pinning for
 * every later connect. Any other malformed string can never match a real
 * handshake and bricks the host until it is edited by hand.
 */
const HOST_KEY_PIN = /^SHA256:[A-Za-z0-9+/]{43}=$/;

/** Audit 34: the shared refusal for a key path outside the two legal roots. */
function refuseKeyPath(channel: string): never {
  console.warn(`${channel} refused: privateKeyPath outside the managed key dir and ~/.ssh`);
  throw new HostValidationError('privateKeyPath must live under ~/.ssh or the FineVibe managed key dir');
}

/**
 * Audit 34 + 31: validate a renderer-supplied `privateKeyPath` and DERIVE
 * `managedKey` from it. Main owns that flag — it drives the enrollment
 * key-deploy step (which ships the public half to the host) and the delete-time
 * unlink — so a renderer value must never make FineVibe unlink a foreign
 * `~/.ssh/id_ed25519`. `currentPath` is the stored one: the edit form re-sends
 * it, and only a CHANGED path can steer a new local read, so an unchanged value
 * passes through and a host whose key predates this gate stays editable.
 * Returns the fields to merge, or null when the patch carried no key path
 * (a non-string value also returns null: the shape gate already rejects it).
 */
function gateKeyPatch(
  channel: 'hosts:create' | 'hosts:update',
  userData: string,
  keyPath: unknown,
  currentPath?: string,
): Record<string, unknown> | null {
  if (typeof keyPath !== 'string') return null;
  if (currentPath !== undefined && keyPath === currentPath) return { privateKeyPath: keyPath };
  if (!isRendererKeyPathAllowed(userData, keyPath)) refuseKeyPath(channel);
  return { privateKeyPath: keyPath, managedKey: isManagedKeyPath(userData, keyPath) };
}

/** A create draft as it crosses IPC: an unvalidated object bag (createHost owns
 * the grammar, validateHostRecordShape the rejection). */
type HostDraft = Record<string, unknown>;

/** {@link gateKeyPatch} for the create draft (the wizard's Browse button). null
 * when the payload is not an object bag — `createHost` rejects those itself. */
function gateDraftKeyPath(draft: unknown): HostDraft | null {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return null;
  const raw = draft as HostDraft;
  const patch = gateKeyPatch('hosts:create', app.getPath('userData'), raw.privateKeyPath);
  return patch ? { ...raw, ...patch } : raw;
}

export function registerHostsDomains(deps: HostsDomainsDeps): void {
  // ---- Multi-host Phase 1: hosts registry --------------------------------
  // Secrets never cross these channels (secrets.ts is write-only over IPC);
  // every mutation re-validates through the shared validateHostRecordShape.
  ipcMain.handle('hosts:list', () => listHosts());

  // Audit 34: the wizard's Browse button lands here, so the draft's key path
  // gets the same containment as the update path (non-object drafts pass
  // through untouched — createHost's own shape gate rejects them).
  ipcMain.handle('hosts:create', (_event, draft: unknown) => createHost(gateDraftKeyPath(draft) ?? draft));

  ipcMain.handle('hosts:update', (_event, id: string, patch: Record<string, unknown>) => {
    const editable: Record<string, unknown> = {};
    if (typeof patch === 'object' && patch !== null && !Array.isArray(patch)) {
      for (const field of HOST_EDITABLE_FIELDS) {
        if (field in patch) editable[field] = patch[field];
      }
    }
    const keyPatch = gateKeyPatch('hosts:update', app.getPath('userData'), editable.privateKeyPath, getHost(id)?.privateKeyPath);
    if (keyPatch) Object.assign(editable, keyPatch);
    const merged = updateHost(id, editable as Partial<Omit<HostRecord, 'id'>>);
    // Row 129 review: the home cache is the per-host memo the connection-
    // invalidation idiom covers — an edited user/host/port must not leave
    // `~` expanding to the previous account's home (unconditional drop is
    // cheap: the cache re-probes lazily on the next `~`-anchored call).
    invalidateRemoteHome(id);
    return merged;
  });

  ipcMain.handle('hosts:delete', (_event, id: string) => {
    deleteHost(id);
    invalidateRemoteHome(id);
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
      // hostId selects the per-host trust store the ssh argv points at (row 35).
      { hostId: record.id, host: record.host, port: record.port, defaultFolder: record.defaultFolder },
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
  // under keypass:<id>. Write-only over IPC (never returned). Row 46: the id
  // must name a registry host — a stale/deleted id (double submit, a card
  // deleted while the modal was open) used to park an orphan ciphertext entry
  // in host-secrets.json for a host that no longer exists.
  ipcMain.handle('hosts:setSecret', (_event, id: string, kind: 'password' | 'keypass', secret: string) => {
    if (!getHost(id)) throw new Error(`unknown host ${JSON.stringify(id)}`);
    setHostSecret(kind === 'keypass' ? `keypass:${id}` : id, secret);
  });

  ipcMain.handle('hosts:forgetPassword', (_event, id: string) => {
    deleteHostSecret(id);
  });

  ipcMain.handle('hosts:test', async (_event, id: string) => {
    const record = getHost(id);
    if (!record) return { ok: false, hostKeyChanged: false, steps: [{ step: 'record', ok: false, detail: 'unknown host' }] };
    const result = await testHost(record);
    // Row 46: `auth-ok` had no producer. A passed auth test on a record that
    // was never enrolled is the honest rung (docs/hosts.md lifecycle) — a
    // wizard closed after Test & Approve used to leave the host sitting on
    // `draft`. An enrolled/partial record is never demoted by a re-test.
    if (result.ok && record.enrollmentStatus === 'draft') updateHost(id, { enrollmentStatus: 'auth-ok' });
    return result;
  });

  // TOFU accept after the wizard showed the fingerprint (§4 step 2).
  ipcMain.handle('hosts:approveHostKey', (_event, id: string, fingerprint: unknown) => {
    if (!getHost(id)) return null;
    if (typeof fingerprint !== 'string' || !HOST_KEY_PIN.test(fingerprint)) {
      console.warn(`hosts:approveHostKey refused: ${id} pin is not a SHA256:<base64> fingerprint`);
      return null;
    }
    return updateHost(id, { hostKeyFingerprint: fingerprint });
  });

  ipcMain.handle('hosts:enroll', async (_event, id: string) => {
    const record = getHost(id);
    if (!record) return { ok: false, steps: [{ step: 'record', ok: false, detail: 'unknown host' }] };
    const emit = (event: { id: string; status: string; detail?: string }) => {
      const w = getMainWindow();
      if (w && !w.isDestroyed()) w.webContents.send('hosts:status', event);
    };
    // The pin is main-owned (hosts:approveHostKey is the only writer); a
    // renderer-supplied fingerprint over this channel was a second, consent-free
    // pin writer (row 118 review) and is gone.
    return enrollHost(record, emit);
  });

  ipcMain.handle('hosts:unenroll', async (_event, id: string) => {
    const record = getHost(id);
    if (!record) return { ok: false, detail: 'unknown host' };
    const res = await unenrollHost(record);
    invalidateRemoteHome(id);
    return res;
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

  // Row 93: the DIR-BROWSER stat. Deliberately NOT project-contained — the
  // Add-project modal names folders that are not projects yet, and the enrolled
  // HostRecord is that flow's consent (council R-1). The contained twin is the
  // TREE rail `fs:stat` (ipc-handlers.ts), which runs
  // remote-fs' isRemotePathInKnownProject first; keeping the two lanes apart is
  // what the contract paragraph in docs/security-boundaries.md documents.
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
