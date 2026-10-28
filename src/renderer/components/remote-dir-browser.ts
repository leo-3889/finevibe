// Remote directory browser (per-host providers T5, plan §6, UR-6): the
// Add-project modal's Browse verb under a non-local tab. Lists directories
// over `hosts:listDirs` — the local native dialog is never constructed on
// this path (the single branch point lives in sidebar.promptNewProject).
// Custom layout (breadcrumb + list pane) → createModalShell + bindModalDismiss
// per the ui-dev convention. All DOM via createElement/textContent.

import { createModalShell, createModalButton, type ModalShell } from './modal-shell.js';
import { bindModalDismiss } from './modal-manager.js';
import { t } from '../i18n.js';

const OVERLAY_ID = 'remote-dir-browser-overlay';

interface RemoteDirBrowserOptions {
  hostId: string;
  title: string;
  /** Canonical remote spelling (`~`, `~/x`, `/x`); default the remote home. */
  startPath?: string;
  onSelect: (path: string) => void;
  /** Cancel/Escape/overlay click — the browser answers with nothing. */
  onDismiss?: () => void;
}

/** Parent of a canonical remote path; null at the root(s). Pure so the
 * navigation table is testable without a DOM. */
export function remoteParentPath(p: string): string | null {
  if (p === '~' || p === '/' || p === '') return null;
  if (p.startsWith('~/')) {
    const rest = p.slice(2);
    const cut = rest.lastIndexOf('/');
    return cut === -1 ? '~' : `~/${rest.slice(0, cut)}`;
  }
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? '/' : p.slice(0, cut);
}

/** Breadcrumb steps: `~` / dev / repo — each clickable to its own prefix. */
export function crumbSteps(p: string): Array<{ label: string; path: string }> {
  const home = p === '~' || p.startsWith('~/');
  const root = home ? { label: '~', path: '~' } : { label: '/', path: '/' };
  const rest = p === '~' ? '' : home ? p.slice(2) : p;
  const steps = [root];
  let acc = '';
  for (const seg of rest.split('/').filter(Boolean)) {
    acc = `${acc}/${seg}`;
    steps.push({ label: seg, path: home ? `~${acc}` : acc });
  }
  return steps;
}

// One browser at a time (the overlay node is cached by id): a re-open
// dismisses the previous caller, whose selection can no longer land.
let active: { close: () => void } | null = null;
let cachedShell: ModalShell | null = null;

export function showRemoteDirBrowser(opts: RemoteDirBrowserOptions): void {
  active?.close();

  // The cache only helps while the node is in the document: a consumer that
  // wipes document.body (tests) leaves a detached overlay, and painting into
  // it would render nothing. Re-create when disconnected.
  const shell = (cachedShell && cachedShell.overlay.isConnected) ? cachedShell
    : createModalShell({ id: OVERLAY_ID, title: '', wide: true });
  cachedShell = shell;
  const { overlay, body, actions, titleEl } = shell;
  titleEl.textContent = opts.title;
  body.replaceChildren();
  actions.replaceChildren();

  const start = opts.startPath?.trim() || '~';
  let current = start;
  // Generation guard: a slow readdir reply must never paint over the
  // directory the browse state already moved to.
  let seq = 0;
  let answered = false;

  const crumb = document.createElement('div');
  crumb.className = 'remote-browser-crumb';
  const list = document.createElement('div');
  list.className = 'remote-browser-list';
  const errorEl = document.createElement('div');
  errorEl.className = 'remote-browser-error hidden';
  body.appendChild(crumb);
  body.appendChild(list);
  body.appendChild(errorEl);

  const selectBtn = createModalButton(t('sidebar.newProject.selectButton'), true);
  const cancelBtn = createModalButton(t('preferences.cancel'), false);
  actions.appendChild(cancelBtn);
  actions.appendChild(selectBtn);

  const dismiss = bindModalDismiss({ overlay, onClose: () => close(false) });

  const close = (selected: boolean): void => {
    if (answered) return;
    answered = true;
    overlay.style.display = 'none';
    dismiss();
    active = null;
    if (!selected) opts.onDismiss?.();
  };
  active = { close: () => close(false) };

  cancelBtn.addEventListener('click', () => close(false));
  selectBtn.addEventListener('click', () => {
    const path = current;
    close(true);
    opts.onSelect(path);
  });

  const row = (text: string, className: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    return el;
  };

  const renderCrumb = (): void => {
    crumb.replaceChildren();
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'remote-browser-crumb-item remote-browser-up';
    up.textContent = '↑';
    up.title = t('sidebar.remoteBrowser.up');
    up.disabled = remoteParentPath(current) === null;
    up.addEventListener('click', () => {
      const parent = remoteParentPath(current);
      if (parent !== null) void goTo(parent);
    });
    crumb.appendChild(up);
    for (const step of crumbSteps(current)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'remote-browser-crumb-item';
      item.textContent = step.label;
      item.addEventListener('click', () => { void goTo(step.path); });
      crumb.appendChild(item);
    }
  };

  const load = async (): Promise<void> => {
    const mySeq = ++seq;
    selectBtn.disabled = true;
    errorEl.classList.add('hidden');
    list.replaceChildren(row(t('sidebar.remoteBrowser.loading'), 'remote-browser-empty'));
    type Dirs = Awaited<ReturnType<typeof window.finevibe.hosts.listDirs>>;
    const res: Dirs = await window.finevibe.hosts.listDirs(opts.hostId, current)
      .catch((): Dirs => ({ ok: false }));
    if (mySeq !== seq || answered) return;
    selectBtn.disabled = false;
    if (!res.ok) {
      errorEl.textContent = res.error ?? t('sidebar.remoteBrowser.error');
      errorEl.classList.remove('hidden');
    }
    const dirs = res.ok ? res.dirs ?? [] : [];
    list.replaceChildren();
    if (dirs.length === 0) {
      list.appendChild(row(t('sidebar.remoteBrowser.empty'), 'remote-browser-empty'));
      return;
    }
    // Child names off the canonical parent spelling: `~` → `~/x`, `/` → `/x`.
    const base = current === '~' ? '~/' : current === '/' ? '/' : `${current}/`;
    for (const dir of dirs) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'remote-browser-item';
      item.textContent = dir.startsWith(base) ? dir.slice(base.length) : dir;
      item.addEventListener('click', () => { void goTo(dir); });
      list.appendChild(item);
    }
  };

  const goTo = async (path: string): Promise<void> => {
    current = path;
    renderCrumb();
    await load();
  };

  renderCrumb();
  overlay.style.display = '';
  void load();
}
