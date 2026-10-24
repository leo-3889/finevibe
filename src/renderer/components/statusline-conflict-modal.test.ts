// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Identity t(): asserts the modal renders its own statuslineConflict keys.
// The bug this pins: the dialog once shipped the legacy project-import
// buttons ("Import from Vibeyard" / "Start fresh"), promising a full
// reimport the consent flow never performs (Replace = installStatusLine only).
vi.mock('../i18n.js', () => ({ t: (key: string) => key }));

const OVERLAY_ID = 'statusline-conflict-overlay';
const FOREIGN = 'C:\\Users\\x\\.other\\statusline.cmd';

let showStatusLineConflictModal: (cmd: string) => Promise<'replace' | 'keep'>;

function overlay(): HTMLElement {
  return document.getElementById(OVERLAY_ID)!;
}

function keepBtn(): HTMLButtonElement {
  return overlay().querySelector('#statusline-conflict-keep') as HTMLButtonElement;
}

function replaceBtn(): HTMLButtonElement {
  return overlay().querySelector('#statusline-conflict-replace') as HTMLButtonElement;
}

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '';
  // Module-scope pending promise + cached overlay: a static import would pin
  // one generation across the suite.
  const mod = await import('./statusline-conflict-modal.js');
  showStatusLineConflictModal = mod.showStatusLineConflictModal;
});

describe('statusline-conflict-modal', () => {
  it('offers statusLine-scoped choices, no import framing', async () => {
    const done = showStatusLineConflictModal(FOREIGN);
    expect(overlay().style.display).toBe('');
    expect(overlay().querySelector('.modal-title')!.textContent).toBe('statuslineConflict.title');
    expect(replaceBtn().textContent).toBe('statuslineConflict.replaceButton');
    expect(keepBtn().textContent).toBe('statuslineConflict.keepButton');
    expect(overlay().textContent).not.toMatch(/import/i);
    expect(overlay().querySelector('code')!.textContent).toBe(FOREIGN);
    keepBtn().click();
    expect(await done).toBe('keep');
    expect(overlay().style.display).toBe('none');
  });

  it('escapes the foreign command markup', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const done = showStatusLineConflictModal(hostile);
    const commandBox = overlay().querySelector('.statusline-conflict-command')!;
    expect(commandBox.querySelector('img')).toBeNull();
    expect(commandBox.querySelector('code')!.textContent).toBe(hostile);
    replaceBtn().click();
    expect(await done).toBe('replace');
  });

  it('re-showing resolves the pending prompt as keep; ESC on the live prompt keeps', async () => {
    const first = showStatusLineConflictModal('a');
    const second = showStatusLineConflictModal('b');
    expect(await first).toBe('keep');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await second).toBe('keep');
  });
});
