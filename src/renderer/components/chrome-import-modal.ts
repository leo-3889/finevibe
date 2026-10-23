import { createModalShell, createModalButton } from './modal-shell.js';
import { bindModalDismiss } from './modal-manager.js';
import { createCustomSelect, type CustomSelectInstance } from './custom-select.js';
import type { ChromeProfile, ChromeImportProgress, ChromeImportResult } from '../../shared/types.js';
import { isLinux } from '../platform.js';

let cleanupFn: (() => void) | null = null;
// CI-10: the live generation's full dismiss (disposed flag + both progress
// subscriptions + onClosed). A re-open runs it; `cleanupFn` alone only tore the
// DOM wiring down.
let dismissActive: (() => void) | null = null;

// Module scope: a dismissed modal detaches its import; a re-opened modal
// must not start a second concurrent run on the same profile/partition.
let importInFlight = false;
// UI2-6: the open itself is async (the profile scan is awaited mid-build), so
// the open is single-flighted: a second click while a scan runs must not
// build the modal a second time on the cached overlay.
let openInFlight = false;

export function showChromeImportModal(onClosed?: () => void): Promise<void> {
  if (openInFlight) return Promise.resolve();
  openInFlight = true;
  return openChromeImportModal(onClosed).finally(() => { openInFlight = false; });
}

async function openChromeImportModal(onClosed?: () => void): Promise<void> {
  // CI-10: a re-open dismisses the previous generation completely — its
  // `disposed` flag, BOTH progress subscriptions and its onClosed. The old
  // `cleanupFn?.()` alone left an in-flight import subscribed to progress
  // events that kept writing into the shared (cached) overlay's detached DOM,
  // and left the caller's onClosed unfired.
  dismissActive?.();
  dismissActive = null;
  cleanupFn?.();
  cleanupFn = null;

  // P2-109: dismissal detaches an in-flight import — progress events must
  // stop writing into detached DOM, and late promise continuations must
  // not touch it either.
  let disposed = false;
  let unsubProgress: (() => void) | null = null;
  let liveUnsub: (() => void) | null = null;

  // Declared before the first await: this generation's cleanup closure reads it.
  let select: CustomSelectInstance | null = null;

  const { overlay, body, actions, titleEl } = createModalShell({
    id: 'chrome-import-overlay',
    title: 'Import cookies from Chrome',
  });
  body.innerHTML = '';
  actions.innerHTML = '';
  titleEl.textContent = 'Import cookies from Chrome';

  const intro = document.createElement('div');
  intro.className = 'chrome-import-intro';
  intro.textContent =
    'Import all cookies from your installed Chrome profile so the embedded browser starts already logged in to the sites you use.';
  body.appendChild(intro);

  const profileLabel = document.createElement('div');
  profileLabel.className = 'chrome-import-label';
  profileLabel.textContent = 'Chrome profile';
  body.appendChild(profileLabel);

  const profileSlot = document.createElement('div');
  profileSlot.className = 'chrome-import-profile-slot';
  body.appendChild(profileSlot);

  const note = document.createElement('div');
  note.className = 'chrome-import-note';
  body.appendChild(note);

  const progressBox = document.createElement('div');
  progressBox.className = 'chrome-import-progress';
  progressBox.style.display = 'none';
  body.appendChild(progressBox);

  const statusLine = document.createElement('div');
  statusLine.className = 'chrome-import-status';
  progressBox.appendChild(statusLine);

  const cookiesBar = document.createElement('div');
  cookiesBar.className = 'chrome-import-bar';
  cookiesBar.innerHTML = '<span class="chrome-import-bar-label">Cookies</span><span class="chrome-import-bar-counts">0 / 0</span><div class="chrome-import-bar-track"><div class="chrome-import-bar-fill"></div></div>';
  cookiesBar.style.display = 'none';
  progressBox.appendChild(cookiesBar);

  const cancelBtn = createModalButton('Cancel', false);
  const importBtn = createModalButton('Import', true);
  actions.appendChild(cancelBtn);
  actions.appendChild(importBtn);

  // UI2-6: dismissal wiring and this generation's cleanup are installed
  // synchronously, BEFORE the profile scan's await — a dismissal during the
  // scan tears the listeners down immediately, and the continuations below
  // check `disposed` instead of writing into a detached modal.
  cancelBtn.addEventListener('click', close);
  const teardownDismiss = bindModalDismiss({ overlay, onClose: close });
  cleanupFn = () => {
    select?.destroy();
    teardownDismiss();
    liveUnsub?.();
    liveUnsub = null;
    // CI-10: the import's own progress subscription has to be part of the
    // teardown, so any path that drops this generation detaches the run.
    unsubProgress?.();
    unsubProgress = null;
  };
  // Hoisted `close` below: the module-level dismiss points at this generation.
  dismissActive = close;

  // Load profiles
  let profiles: ChromeProfile[] = [];
  try {
    profiles = await window.finevibe.chromeImport.listProfiles();
  } catch (err) {
    note.textContent = `Failed to read Chrome profiles: ${(err as Error).message}`;
  }
  if (disposed) return; // dismissed mid-scan: this generation is already torn down
  if (profiles.length === 0) {
    note.textContent = 'Chrome installation not found. Install Google Chrome and sign in to a profile, then try again.';
    importBtn.disabled = true;
  } else {
    select = createCustomSelect(
      'chrome-import-profile-select',
      profiles.map((p) => ({ value: p.id, label: p.displayName })),
      profiles[0]!.id,
    );
    profileSlot.appendChild(select.element);

    note.append(
      'On macOS, the system may ask permission to read ',
      Object.assign(document.createElement('strong'), { textContent: 'Chrome Safe Storage' }),
      ' — click ',
      Object.assign(document.createElement('em'), { textContent: 'Allow' }),
      ' when prompted. On Windows, cookies encrypted with Chrome 127+ App-Bound Encryption can’t be imported and will be skipped.',
    );
    if (isLinux) {
      note.append(
        ' On Linux, the import reads Chrome’s safe-storage key from the login keyring via ',
        Object.assign(document.createElement('code'), { textContent: 'secret-tool' }),
        ': if cookies fail to decrypt, unlock the login keyring and, on Debian/Ubuntu, install the ',
        Object.assign(document.createElement('code'), { textContent: 'libsecret-tools' }),
        ' package (it provides ',
        Object.assign(document.createElement('code'), { textContent: 'secret-tool' }),
        ').',
      );
    }

    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      cancelBtn.disabled = true;

      progressBox.style.display = 'block';
      cookiesBar.style.display = 'flex';
      statusLine.textContent = 'Starting…';

      unsubProgress = window.finevibe.chromeImport.onProgress((p: ChromeImportProgress) => {
        if (p.stage === 'starting') statusLine.textContent = 'Reading Chrome data…';
        else if (p.stage === 'copy') statusLine.textContent = 'Copying database files…';
        else if (p.stage === 'cookies') {
          const total = p.total ?? 0;
          const done = p.done ?? 0;
          updateBar(cookiesBar, done, total);
          statusLine.textContent = `Importing cookies… ${done}/${total}`;
        } else if (p.stage === 'done') {
          statusLine.textContent = 'Done.';
        } else if (p.stage === 'error') {
          statusLine.textContent = `Error: ${p.message || 'Unknown error'}`;
        }
      });

      importInFlight = true;
      let result: ChromeImportResult | null = null;
      let runErr: Error | null = null;
      try {
        result = await window.finevibe.chromeImport.run({
          profileId: select!.getValue(),
        });
      } catch (err) {
        runErr = err as Error;
      }
      importInFlight = false;
      unsubProgress?.();
      unsubProgress = null;
      if (disposed) return; // modal dismissed mid-import: detached, no DOM writes

      if (runErr) {
        statusLine.textContent = `Failed: ${runErr.message}`;
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Close';
        return;
      }

      // Replace progress with summary
      progressBox.innerHTML = '';
      const summary = document.createElement('div');
      summary.className = 'chrome-import-summary';
      const lines: string[] = [`Imported ${result!.cookieCount} cookies`];
      // Label matches the skip channel in decrypt.ts: Chrome 127+ on Windows
      // writes the v20 App-Bound prefix, so "v11" here was never true. The
      // result field stays `skippedV11` (stable IPC shape).
      if (result!.skippedV11 > 0) lines.push(`Skipped ${result!.skippedV11} entries (Chrome App-Bound Encryption)`);
      if (result!.errors.length > 0) {
        // P2-49: show the actual reasons (e.g. keychain denial), not a bare
        // error count that lets a failed import read as a success.
        const shown = result!.errors.slice(0, 3).join(' · ');
        lines.push(result!.errors.length > 3 ? `${shown} (+${result!.errors.length - 3} more errors)` : shown);
      }
      const warnings = result!.warnings ?? [];
      if (warnings.length > 0) {
        // P2-49: non-fatal key problems (Linux keyring diagnosis on a
        // `peanuts`-legacy success) must reach the user without
        // failing an import that delivered cookies.
        lines.push(`Warning: ${warnings.slice(0, 2).join(' · ')}${warnings.length > 2 ? ` (+${warnings.length - 2} more warnings)` : ''}`);
      }
      summary.textContent = lines.join(' · ');
      progressBox.appendChild(summary);

      importBtn.style.display = 'none';
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'Done';
    });
  }

  function close() {
    disposed = true;
    // P2-109: detach the in-flight import now — no cancel channel exists in
    // main, so dismissal stops all renderer writes for this run immediately.
    unsubProgress?.();
    unsubProgress = null;
    overlay.style.display = 'none';
    cleanupFn?.();
    cleanupFn = null;
    // CI-10: only clear the module pointer while it is still ours — a close
    // that races a re-open must not unregister the newer generation.
    if (dismissActive === close) dismissActive = null;
    onClosed?.();
  }

  // P2-109: re-open while a detached import is still running — offer live
  // progress of that run, not a second concurrent import.
  if (importInFlight) {
    importBtn.disabled = true;
    note.textContent =
      'An import is already running in the background. Wait for it to finish before starting another.';
    progressBox.style.display = 'block';
    statusLine.textContent = 'Import running…';
    liveUnsub = window.finevibe.chromeImport.onProgress((p: ChromeImportProgress) => {
      if (p.stage === 'cookies') {
        cookiesBar.style.display = 'flex';
        updateBar(cookiesBar, p.done ?? 0, p.total ?? 0);
        statusLine.textContent = `Importing cookies… ${p.done ?? 0}/${p.total ?? 0}`;
      } else if (p.stage === 'done' || p.stage === 'error') {
        liveUnsub?.();
        liveUnsub = null;
        importBtn.disabled = false;
        statusLine.textContent = p.stage === 'done' ? 'Previous import finished.' : `Error: ${p.message || 'Unknown error'}`;
      }
    });
  }

  overlay.style.display = 'flex';
}

function updateBar(bar: HTMLElement, done: number, total: number): void {
  const counts = bar.querySelector('.chrome-import-bar-counts');
  if (counts) counts.textContent = `${done} / ${total}`;
  const fill = bar.querySelector<HTMLElement>('.chrome-import-bar-fill');
  if (fill) fill.style.width = total > 0 ? `${Math.min(100, (done / total) * 100)}%` : '0%';
}
