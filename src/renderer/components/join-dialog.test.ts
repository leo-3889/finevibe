// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showJoinDialog, closeJoinDialog } from './join-dialog';

vi.mock('../sharing/share-manager', () => ({ joinRemoteSession: vi.fn() }));
vi.mock('../state', () => ({ appState: { activeProject: { id: 'p1' } } }));
vi.mock('./modal-manager', () => ({ bindModalDismiss: vi.fn(() => vi.fn()) }));
vi.mock('../i18n', () => ({ t: (key: string) => `T:${key}` }));

vi.mock('../sharing/share-crypto', () => {
  class DecryptionError extends Error {}
  return {
    DecryptionError,
    validateShareKey: vi.fn((key: string) => (key.length === 32 ? null : 'Share key must be 32 characters')),
  };
});

import { joinRemoteSession } from '../sharing/share-manager';
import { appState } from '../state';
import { bindModalDismiss } from './modal-manager';

const mockedJoin = vi.mocked(joinRemoteSession);
const mockedBind = vi.mocked(bindModalDismiss);

function dialog(): Element | null {
  return document.querySelector('.share-dialog');
}
function pinInput(): HTMLInputElement {
  return document.querySelector('.share-pin-input') as HTMLInputElement;
}
function joinBtn(): HTMLButtonElement {
  return [...document.querySelectorAll('.share-actions button')].find((b) => /Join|Connecting/.test(b.textContent ?? '')) as HTMLButtonElement;
}
function statusText(): string {
  return document.querySelector('.share-status')?.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
  mockedJoin.mockReset();
  mockedBind.mockReset().mockReturnValue(vi.fn());
  (appState as { activeProject: unknown }).activeProject = { id: 'p1' };
  (window as unknown as { finevibe: unknown }).finevibe = {};
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn() }, configurable: true });
});

afterEach(() => {
  closeJoinDialog();
  document.body.innerHTML = '';
});

describe('join-dialog (J-matrix #7)', () => {
  it('without an active project nothing opens', () => {
    (appState as { activeProject: unknown }).activeProject = null;
    showJoinDialog();
    expect(dialog()).toBeNull();
  });

  it('renders the full offer form', () => {
    showJoinDialog();
    expect(dialog()).not.toBeNull();
    expect(pinInput()).not.toBeNull();
    expect(document.querySelector('.share-code')).not.toBeNull();
    expect(document.querySelector('.share-status')?.textContent).toBe('');
    // Answer section starts hidden.
    expect(document.querySelector('.share-section.hidden')).not.toBeNull();
  });

  it('re-opening replaces the previous overlay (single instance)', () => {
    showJoinDialog();
    showJoinDialog();
    expect(document.querySelectorAll('.share-overlay')).toHaveLength(1);
  });

  it('invalid share key surfaces the validator error without connecting', async () => {
    showJoinDialog();
    pinInput().value = 'short';
    joinBtn().click();
    await Promise.resolve();
    expect(statusText()).toBe('Share key must be 32 characters');
    expect(mockedJoin).not.toHaveBeenCalled();
  });

  it('valid key with empty code asks for the code', async () => {
    showJoinDialog();
    pinInput().value = 'k'.repeat(32);
    (document.querySelectorAll('.share-code')[0] as HTMLTextAreaElement).value = '  ';
    joinBtn().click();
    await Promise.resolve();
    expect(statusText()).toBe('Please paste the connection code from the host.');
    expect(mockedJoin).not.toHaveBeenCalled();
  });

  it('successful join shows the answer and flips Cancel to Close', async () => {
    mockedJoin.mockImplementation(async (_p, _o, _k, _close, _cb) => {
      return { answer: 'ANSWER-CODE' };
    });
    showJoinDialog();
    pinInput().value = 'k'.repeat(32);
    (document.querySelectorAll('.share-code')[0] as HTMLTextAreaElement).value = 'OFFER';
    joinBtn().click();
    expect(joinBtn().textContent).toBe('Connecting...');
    expect(joinBtn().disabled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    const answer = document.querySelectorAll('.share-code')[1] as HTMLTextAreaElement;
    expect(answer.value).toBe('ANSWER-CODE');
    expect(statusText()).toBe('Send the response code to the host. The session will appear once they connect.');
    const close = [...document.querySelectorAll('.share-actions button')].find((b) => b.textContent === 'Close');
    expect(close).toBeDefined();
  });

  it('a DecryptionError names the share key and re-enables Join', async () => {
    const { DecryptionError } = await import('../sharing/share-crypto');
    mockedJoin.mockRejectedValue(new DecryptionError('bad key'));
    showJoinDialog();
    pinInput().value = 'k'.repeat(32);
    (document.querySelectorAll('.share-code')[0] as HTMLTextAreaElement).value = 'OFFER';
    joinBtn().click();
    await Promise.resolve();
    await Promise.resolve();
    expect(statusText()).toBe('Could not decrypt connection code. Check the share key and try again.');
    expect(joinBtn().disabled).toBe(false);
    expect(joinBtn().textContent).toBe('Join');
  });

  it('a generic error surfaces its message and re-enables Join', async () => {
    mockedJoin.mockRejectedValue(new Error('webrtc offline'));
    showJoinDialog();
    pinInput().value = 'k'.repeat(32);
    (document.querySelectorAll('.share-code')[0] as HTMLTextAreaElement).value = 'OFFER';
    joinBtn().click();
    await Promise.resolve();
    await Promise.resolve();
    expect(statusText()).toBe('Error: webrtc offline');
    expect(joinBtn().disabled).toBe(false);
  });

  it('cancel closes and unbinds the dismiss handler', () => {
    showJoinDialog();
    const unbind = mockedBind.mock.results[0].value as ReturnType<typeof vi.fn>;
    const cancel = [...document.querySelectorAll('.share-actions button')].find((b) => b.textContent === 'Cancel')!;
    cancel.click();
    expect(dialog()).toBeNull();
    expect(unbind).toHaveBeenCalled();
  });
});
