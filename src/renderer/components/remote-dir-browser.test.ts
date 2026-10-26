// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { crumbSteps, remoteParentPath, showRemoteDirBrowser } from './remote-dir-browser.js';

// The browser is the T5 (UR-6) remote Browse pane. The fs stub carries a
// spy on browseDirectory: a remote browse must NEVER construct the local
// dialog. listDirs scripts one page per directory.

let listDirs: Mock;
let browseDirectory: Mock;

function dirRow(overlay: HTMLElement, name: string): HTMLButtonElement {
  const row = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.remote-browser-item'))
    .find((b) => b.textContent === name);
  if (!row) throw new Error(`no row for ${name}: ${overlay.querySelector('.remote-browser-list')?.textContent}`);
  return row;
}

function selectBtn(overlay: HTMLElement): HTMLButtonElement {
  return overlay.querySelector('.modal-actions .btn-primary') as HTMLButtonElement;
}

function cancelBtn(overlay: HTMLElement): HTMLButtonElement {
  return overlay.querySelector('.modal-actions .btn-secondary') as HTMLButtonElement;
}

function crumbs(overlay: HTMLElement): string[] {
  return Array.from(overlay.querySelectorAll('.remote-browser-crumb-item'))
    .filter((b) => !b.classList.contains('remote-browser-up'))
    .map((b) => b.textContent ?? '');
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function open(startPath: string | undefined, opts?: { onSelect?: Mock; onDismiss?: Mock }): Promise<HTMLElement> {
  const onSelect = opts?.onSelect ?? vi.fn();
  showRemoteDirBrowser({
    hostId: 'h1',
    title: 'Browse strix',
    startPath,
    onSelect,
    onDismiss: opts?.onDismiss,
  });
  await flush();
  return document.getElementById('remote-dir-browser-overlay')!;
}

beforeEach(() => {
  // No vi.resetModules(): the top-level import is not rebound by it, and the
  // component's cached modal shell survives resetModules — the body wipe
  // below then orphans the cached node and every later open paints into
  // detached DOM. The module-level cache is the real one-browser-at-a-time
  // contract; the shell re-attaches via createModalShell's id lookup.
  document.body.innerHTML = '';
  listDirs = vi.fn(async (_id: string, dir: string) => ({
    ok: true,
    dirs: dir === '~'
      ? ['~/projects', '~/notes']
      : dir === '~/projects' ? ['~/projects/demo'] : [],
  }));
  browseDirectory = vi.fn(async () => '/local/should/never/open');
  (window as unknown as { finevibe: unknown }).finevibe = {
    hosts: { listDirs },
    fs: { browseDirectory },
  };
});

describe('remoteParentPath / crumbSteps (pure navigation table)', () => {
  it('walks the canonical spellings up to their roots', () => {
    expect(remoteParentPath('~/projects/demo')).toBe('~/projects');
    expect(remoteParentPath('~/projects')).toBe('~');
    expect(remoteParentPath('~')).toBeNull();
    expect(remoteParentPath('/home/dev')).toBe('/home');
    expect(remoteParentPath('/home')).toBe('/');
    expect(remoteParentPath('/')).toBeNull();
  });

  it('builds a clickable prefix per segment', () => {
    expect(crumbSteps('~')).toEqual([{ label: '~', path: '~' }]);
    expect(crumbSteps('~/projects/demo')).toEqual([
      { label: '~', path: '~' },
      { label: 'projects', path: '~/projects' },
      { label: 'demo', path: '~/projects/demo' },
    ]);
    expect(crumbSteps('/home/dev')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'dev', path: '/home/dev' },
    ]);
  });
});

describe('remote dir browser', () => {
  it('lists the start directory over hosts:listDirs and never touches the local dialog', async () => {
    const overlay = await open('~');
    expect(overlay.style.display).toBe('');
    expect(listDirs).toHaveBeenCalledWith('h1', '~');
    expect(browseDirectory).not.toHaveBeenCalled();
    expect(dirRow(overlay, 'projects')).toBeTruthy();
    expect(dirRow(overlay, 'notes')).toBeTruthy();
    expect(crumbs(overlay)).toEqual(['~']);
  });

  it('navigates into a directory, updates the breadcrumb, answers the CURRENT dir on Select', async () => {
    const onSelect = vi.fn();
    const overlay = await open('~', { onSelect });
    dirRow(overlay, 'projects').click();
    await flush();
    expect(listDirs).toHaveBeenLastCalledWith('h1', '~/projects');
    expect(crumbs(overlay)).toEqual(['~', 'projects']);
    expect(dirRow(overlay, 'demo')).toBeTruthy();

    selectBtn(overlay).click();
    expect(onSelect).toHaveBeenCalledWith('~/projects');
    expect(overlay.style.display).toBe('none');
  });

  it('up navigation reaches the parent (and the up control dies at the root)', async () => {
    const overlay = await open('~/projects/demo');
    expect(crumbs(overlay)).toEqual(['~', 'projects', 'demo']);
    const up = overlay.querySelector('.remote-browser-up') as HTMLButtonElement;
    expect(up.disabled).toBe(false);
    up.click();
    await flush();
    expect(listDirs).toHaveBeenLastCalledWith('h1', '~/projects');
    expect(crumbs(overlay)).toEqual(['~', 'projects']);

    overlay.querySelector('.remote-browser-up')!.dispatchEvent(new MouseEvent('click'));
    await flush();
    overlay.querySelector('.remote-browser-up')!.dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(listDirs).toHaveBeenLastCalledWith('h1', '~');
    expect((overlay.querySelector('.remote-browser-up') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a breadcrumb click jumps to that prefix', async () => {
    const overlay = await open('~/projects/demo');
    const homeCrumb = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.remote-browser-crumb-item'))
      .find((b) => b.textContent === '~')!;
    homeCrumb.click();
    await flush();
    expect(listDirs).toHaveBeenLastCalledWith('h1', '~');
  });

  it('Cancel dismisses with no answer', async () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    const overlay = await open('~', { onSelect, onDismiss });
    cancelBtn(overlay).click();
    expect(overlay.style.display).toBe('none');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a listing failure surfaces the error and keeps the modal open', async () => {
    listDirs.mockResolvedValueOnce({ ok: false, error: 'No such directory: ~/gone' });
    const overlay = await open('~/gone');
    const err = overlay.querySelector('.remote-browser-error')!;
    expect(err.classList.contains('hidden')).toBe(false);
    expect(err.textContent).toContain('No such directory');
    expect(overlay.style.display).toBe('');
  });

  it('drops a stale listing reply when the browse state already moved (seq guard)', async () => {
    let resolveSlow: (v: { ok: boolean; dirs?: string[] }) => void = () => {};
    // `~` answers instantly; `~/projects` hangs. Navigate into the slow page,
    // then away, then let the slow reply land — it must not paint. (Each
    // mockImplementationOnce serves the NEXT call: ~, then ~/projects.)
    listDirs
      .mockImplementationOnce(async () => ({ ok: true, dirs: ['~/projects', '~/notes'] }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }));
    const overlay = await open('~');
    dirRow(overlay, 'projects').click();
    await flush();
    expect(overlay.querySelector('.remote-browser-list')!.textContent).toContain('Loading');
    // Move on before the slow reply lands.
    const homeCrumb = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.remote-browser-crumb-item'))
      .find((b) => b.textContent === '~')!;
    homeCrumb.click();
    await flush();
    resolveSlow({ ok: true, dirs: ['~/projects/demo'] });
    await flush();
    expect(overlay.querySelector('.remote-browser-list')?.textContent).not.toContain('demo');
    expect(dirRow(overlay, 'notes')).toBeTruthy();
  });
});
