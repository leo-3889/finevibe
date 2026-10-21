// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// modal.ts grabs the shared overlay DOM at module load; mirror index.html's
// #modal-overlay skeleton so the module resolves its element constants.
document.body.innerHTML = `
  <div id="modal-overlay" class="hidden">
    <div class="modal">
      <div id="modal-title"></div>
      <div id="modal-body"></div>
      <div id="modal-actions">
        <button id="modal-cancel" class="btn-secondary">Cancel</button>
        <button id="modal-confirm" class="btn-primary">Create</button>
      </div>
    </div>
  </div>`;

// Run rAF callbacks inline: the modal's focus steal (and the focus restore)
// are both rAF-guarded, so synchronous frames make the focus assertions
// deterministic.
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  cb(0);
  return 1;
});

// modal.ts grabs the overlay elements at module-load time, so this import
// must run after the jsdom skeleton above exists — a static import cannot
// order itself after that DOM setup (repo's jsdom test pattern).
const { showModal, closeModal } = await import('./modal.js');

const overlay = () => document.getElementById('modal-overlay')!;

/** A composer-like element living outside the modal (the Ask AI textarea). */
function makeComposer(value = 'fix the bug'): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  closeModal();
  for (const el of Array.from(document.body.querySelectorAll('textarea'))) {
    el.remove();
  }
});

describe('modal focus restoration', () => {
  it('restores focus to the opener when the modal closes (Cancel path)', () => {
    const composer = makeComposer();
    composer.focus();
    expect(document.activeElement).toBe(composer);

    showModal('New Session', [{ label: 'Name', id: 'session-name' }], () => {});
    // The modal steals focus to the first text input while open...
    expect(document.activeElement).toBe(document.getElementById('modal-session-name'));

    closeModal();
    // ...and must give it back so the composer stays typable.
    expect(overlay().classList.contains('hidden')).toBe(true);
    expect(document.activeElement).toBe(composer);
  });

  it('restores focus after Create when onConfirm closes the modal', () => {
    const composer = makeComposer();
    composer.focus();

    const onConfirm = vi.fn(() => {
      closeModal();
    });
    showModal('New Session', [{ label: 'Name', id: 'n' }], onConfirm);
    document.getElementById('modal-confirm')!.click();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(composer);
  });

  it('skips the restore when the opener was removed while the modal was open', () => {
    const composer = makeComposer();
    composer.focus();

    showModal('T', [{ label: 'N', id: 'x' }], () => {});
    composer.remove();
    closeModal();

    // No crash, no focus() into the dead composer; focus stays where the
    // modal left it (a real browser additionally blurs to body via the
    // display:none flip — jsdom has no CSS).
    expect(document.activeElement).not.toBe(composer);
  });

  it('skips the restore-to-body when nothing meaningful was focused before the modal', () => {
    // Active element is body (nothing focused) at open.
    showModal('T', [{ label: 'N', id: 'y' }], () => {});
    closeModal();
    // The `body` guard means no focus() is forced; focus stays on the last
    // modal control (jsdom has no CSS, so a real browser's display:none
    // blur-to-body is the only difference and it matches today's behavior).
    expect(document.activeElement).toBe(document.getElementById('modal-y'));
  });
});
