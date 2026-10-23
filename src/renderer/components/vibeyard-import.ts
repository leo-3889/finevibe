// One-time import of projects recorded by the previous name of this app.
//
// The file migration (`src/main/userdata-migration.ts`) copies `~/.vibeyard`
// to `~/.finevibe` with destination-wins, so the legacy `state.json` project
// LIST was never merged into the live one: a user who had projects in
// Vibeyard starts FineVibe with an empty sidebar. This component offers the
// delta at runtime — enumerate what the legacy state lists, let the user pick,
// then add each pick through `appState.addProject`, i.e. through the app's own
// record creation (persist + `project-added` emit), never a hand-rolled record.
//
// The whole feature is optional: every read of the legacy state degrades to an
// empty list, which keeps the header entry point hidden and boot untouched.

import { appState } from '../state.js';
import { isWin } from '../platform.js';
import { t, onLocaleChange } from '../i18n.js';
import { createModalShell, createModalButton } from './modal-shell.js';
import { bindModalDismiss } from './modal-manager.js';
import type { ImportableLegacyProject } from '../../shared/types.js';

const OVERLAY_ID = 'vibeyard-import-overlay';
const BUTTON_ID = 'btn-import-vibeyard';
// How long the post-import result stays on screen before the modal closes.
const RESULT_MS = 1600;

/** The scan result, cached after the first fetch (null = never fetched). */
let cached: ImportableLegacyProject[] | null = null;
/** The in-flight scan, so the startup probe and a modal open share one IPC. */
let inFlight: Promise<ImportableLegacyProject[]> | null = null;
// The open itself is async (the scan is awaited mid-build), so the open is
// single-flighted: a second click while a scan runs must not build the modal a
// second time on the cached overlay. Mirrors chrome-import-modal.
let openInFlight = false;
// Module scope: a dismissal mid-scan tears down the generation that is
// building; a re-open runs the previous generation's teardown first.
let cleanupFn: (() => void) | null = null;
let dismissActive: (() => void) | null = null;
/** The result state's auto-close timer; cleared by every explicit close. */
let resultTimer: ReturnType<typeof setTimeout> | null = null;

/** The repo's `…One` / `…Other` plural pattern (see session-close.ts). */
function tCount(key: string, count: number): string {
  return count === 1 ? t(`${key}One`) : t(`${key}Other`, { count });
}

/**
 * Path identity for the duplicate check. Legacy `state.json` stores Windows
 * separators, so `/` vs `\` cannot be trusted across the migration; on win32
 * the filesystem is case-insensitive, so the comparison has to be too.
 */
function pathKey(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWin ? slashed.toLowerCase() : slashed;
}

/** Every project path FineVibe already owns, as identity keys. */
function existingKeys(): Set<string> {
  return new Set(appState.projects.map((p) => pathKey(p.path)));
}

/**
 * Enumerate the importable legacy projects. Never rejects: a missing legacy
 * file, an unparseable one, an unregistered IPC channel, a main-process
 * rejection — all of them mean "nothing to import", not an error to show.
 */
function fetchImportable(): Promise<ImportableLegacyProject[]> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      // Optional ACCESS, required type: a renderer running against an older
      // preload has no `vibeyard` namespace at all, and that is an empty
      // list, not a crash.
      const api = window.finevibe.vibeyard;
      if (!api) return [];
      const list = await api.listImportableProjects();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  })().then((list) => {
    cached = list;
    inFlight = null;
    return list;
  });
  return inFlight;
}

function applyButtonTitle(): void {
  const btn = document.getElementById(BUTTON_ID);
  if (btn) btn.title = t('legacyImport.buttonTitle');
}

/**
 * Wire the header entry point and probe the legacy state once. Sync on
 * purpose — it sits with the other `init*()` calls, and the scan's result only
 * decides whether the button is visible, so nothing may await it.
 */
export function initVibeyardImport(): void {
  const btn = document.getElementById(BUTTON_ID);
  if (btn) {
    // init runs before initI18n() applies the persisted locale, so the tooltip
    // has to re-translate on locale change like the other header labels.
    applyButtonTitle();
    onLocaleChange(applyButtonTitle);
    btn.addEventListener('click', () => {
      void showVibeyardImportModal();
    });
  }
  fetchImportable().then((list) => {
    if (btn && list.length > 0) btn.classList.remove('hidden');
  });
}

/** Re-apply the header button's visibility from the (possibly trimmed) cache. */
function syncButtonVisibility(): void {
  const btn = document.getElementById(BUTTON_ID);
  if (!btn) return;
  btn.classList.toggle('hidden', (cached?.length ?? 0) === 0);
}

export function showVibeyardImportModal(): Promise<void> {
  if (openInFlight) return Promise.resolve();
  openInFlight = true;
  return openModal().finally(() => { openInFlight = false; });
}

async function openModal(): Promise<void> {
  dismissActive?.();
  dismissActive = null;
  cleanupFn?.();
  cleanupFn = null;
  if (resultTimer) {
    clearTimeout(resultTimer);
    resultTimer = null;
  }

  const { overlay, body, actions, titleEl } = createModalShell({
    id: OVERLAY_ID,
    title: t('legacyImport.title'),
  });
  titleEl.textContent = t('legacyImport.title');
  body.innerHTML = '';
  actions.innerHTML = '';

  // A dismissal detaches this generation: continuations must stop writing into
  // the shared (cached) overlay's detached DOM.
  let disposed = false;
  const close = (): void => {
    if (disposed) return;
    disposed = true;
    if (resultTimer) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
    cleanupFn?.();
    cleanupFn = null;
    if (dismissActive === close) dismissActive = null;
    overlay.style.display = 'none';
  };
  dismissActive = close;

  const cancelBtn = createModalButton(t('legacyImport.cancel'), false);
  const importBtn = createModalButton(t('legacyImport.import'), true);
  actions.appendChild(cancelBtn);
  actions.appendChild(importBtn);
  cancelBtn.addEventListener('click', close);
  const teardownDismiss = bindModalDismiss({ overlay, onClose: close });
  cleanupFn = teardownDismiss;

  const intro = document.createElement('div');
  intro.className = 'modal-message';
  intro.textContent = t('legacyImport.intro');
  body.appendChild(intro);

  const rowsBox = document.createElement('div');
  rowsBox.className = 'vibeyard-import-list';
  body.appendChild(rowsBox);

  overlay.style.display = '';

  const scanned = await fetchImportable();
  if (disposed) return;

  // Only the delta is offerable: a project FineVibe already lists is not
  // "importable", and showing it checked would invite a duplicate.
  const existing = existingKeys();
  const importable = scanned.filter((p) => !existing.has(pathKey(p.path)));

  if (importable.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'modal-message vibeyard-import-empty';
    empty.textContent = t('legacyImport.empty');
    rowsBox.appendChild(empty);
    importBtn.disabled = true;
    return;
  }

  const rows: Array<{ input: HTMLInputElement; project: ImportableLegacyProject }> = [];
  for (const project of importable) {
    const label = document.createElement('label');
    label.className = 'vibeyard-import-row';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'vibeyard-import-check';
    // All selected by default: the list is already filtered to projects the
    // app does not have, so the common case is "import everything".
    input.checked = true;

    const name = document.createElement('span');
    name.className = 'vibeyard-import-name';
    name.textContent = project.name;

    const sessions = document.createElement('span');
    sessions.className = 'vibeyard-import-sessions';
    sessions.textContent = tCount('legacyImport.sessions', project.sessions);

    const path = document.createElement('span');
    path.className = 'vibeyard-import-path';
    path.textContent = project.path;

    label.append(input, name, sessions, path);
    rowsBox.appendChild(label);
    rows.push({ input, project });
  }

  importBtn.addEventListener('click', () => {
    importBtn.disabled = true;
    cancelBtn.disabled = true;
    // Re-read the project list at confirm time: a project added while the modal
    // sat open (a clone, a manual add, an earlier import) must not be added a
    // second time.
    const current = existingKeys();
    const selected = rows.filter((r) => r.input.checked).map((r) => r.project);
    let imported = 0;
    let skipped = 0;
    for (const project of selected) {
      const key = pathKey(project.path);
      if (current.has(key)) {
        skipped++;
        continue;
      }
      current.add(key);
      // The app's own creation path: id, board, layout, persist, emits.
      appState.addProject(project.name, project.path);
      imported++;
    }

    // The imported projects are FineVibe's now; drop them from the cached scan
    // so a re-open (and the header button) reflects reality.
    const picked = new Set(selected.map((p) => pathKey(p.path)));
    if (cached) cached = cached.filter((p) => !picked.has(pathKey(p.path)));
    syncButtonVisibility();

    renderResult(rowsBox, actions, close, imported, skipped);
  });
}

/**
 * The list is spent — replace it with a one-line result and end the dialog:
 * a Close button for the user, plus a timer so the flow closes on its own
 * (the projects are already in the sidebar, there is nothing left to confirm).
 */
function renderResult(
  rowsBox: HTMLElement,
  actions: HTMLElement,
  close: () => void,
  imported: number,
  skipped: number,
): void {
  rowsBox.innerHTML = '';

  if (imported === 0 && skipped === 0) {
    // Confirm with nothing checked: reuse the state the modal already owns,
    // instead of announcing an "Imported 0 projects" non-event.
    const none = document.createElement('div');
    none.className = 'modal-message vibeyard-import-empty';
    none.textContent = t('legacyImport.empty');
    rowsBox.appendChild(none);
  }
  if (imported > 0) {
    const result = document.createElement('div');
    result.className = 'modal-message vibeyard-import-result';
    result.textContent = tCount('legacyImport.result', imported);
    rowsBox.appendChild(result);
  }

  if (skipped > 0) {
    const note = document.createElement('div');
    note.className = 'modal-message vibeyard-import-skipped';
    note.textContent = tCount('legacyImport.skipped', skipped);
    rowsBox.appendChild(note);
  }

  actions.innerHTML = '';
  const closeBtn = createModalButton(t('legacyImport.close'), true);
  closeBtn.addEventListener('click', close);
  actions.appendChild(closeBtn);
  closeBtn.focus();

  resultTimer = setTimeout(close, RESULT_MS);
}
