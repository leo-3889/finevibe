// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function appendTerminalStandIn(): HTMLTextAreaElement {
  // Stands in for xterm's helper textarea: the element that holds focus (and
  // every keystroke) while a terminal pane is active.
  const term = document.createElement('textarea');
  term.className = 'xterm-helper-textarea';
  document.body.appendChild(term);
  term.focus();
  return term;
}

beforeEach(() => {
  // Dynamic import is deliberate: the module keeps the focus-owner WeakMap, and
  // vi.resetModules() + a fresh overlay node per test keep observers from
  // leaking between tests — a static import cannot observe the reset graph.
  vi.resetModules();
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('modal shell focus ownership', () => {
  it('moves focus into the dialog on open and back to the terminal on close', async () => {
    const term = appendTerminalStandIn();
    const { createModalShell } = await import('./modal-shell.js');
    const { overlay, body, actions } = createModalShell({ id: 'shell-focus-text', title: 'Rename' });

    const field = document.createElement('input');
    field.type = 'text';
    body.appendChild(field);
    const ok = document.createElement('button');
    actions.appendChild(ok);

    overlay.style.display = '';
    await vi.waitFor(() => expect(document.activeElement).toBe(field));

    overlay.style.display = 'none';
    await vi.waitFor(() => expect(document.activeElement).toBe(term));
  });

  it('focuses the first button when the dialog has no text input', async () => {
    appendTerminalStandIn();
    const { createModalShell } = await import('./modal-shell.js');
    const { overlay, body, actions } = createModalShell({ id: 'shell-focus-buttons', title: 'Delete' });

    const note = document.createElement('p');
    note.textContent = 'Delete this profile?';
    body.appendChild(note);
    const cancel = document.createElement('button');
    const confirm = document.createElement('button');
    actions.appendChild(cancel);
    actions.appendChild(confirm);

    overlay.style.display = '';
    await vi.waitFor(() => expect(document.activeElement).toBe(cancel));
  });

  it('focuses the box itself when the dialog has nothing focusable', async () => {
    appendTerminalStandIn();
    const { createModalShell } = await import('./modal-shell.js');
    const { overlay, body } = createModalShell({ id: 'shell-focus-empty', title: 'Working' });

    const note = document.createElement('p');
    note.textContent = 'Importing…';
    body.appendChild(note);

    overlay.style.display = '';
    const box = overlay.querySelector('.modal-box') as HTMLElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.tabIndex).toBe(-1);
  });

  it('takes focus again when a cached overlay is re-opened', async () => {
    const term = appendTerminalStandIn();
    const { createModalShell } = await import('./modal-shell.js');

    const first = createModalShell({ id: 'shell-focus-reopen', title: 'Rename' });
    const field = document.createElement('input');
    field.type = 'text';
    first.body.appendChild(field);

    first.overlay.style.display = '';
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    first.overlay.style.display = 'none';
    await vi.waitFor(() => expect(document.activeElement).toBe(term));

    // The cached branch returns the same node; its observer must still be wired.
    const cached = createModalShell({ id: 'shell-focus-reopen', title: 'Rename' });
    expect(cached.overlay).toBe(first.overlay);

    cached.overlay.style.display = '';
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('restores nothing when the focus came from inside the overlay', async () => {
    const { createModalShell } = await import('./modal-shell.js');
    const { overlay, body, actions } = createModalShell({ id: 'shell-focus-inside', title: 'Rename' });

    const field = document.createElement('input');
    field.type = 'text';
    body.appendChild(field);
    const ok = document.createElement('button');
    actions.appendChild(ok);

    overlay.style.display = '';
    field.focus();
    overlay.style.display = 'none';
    // Re-opened while focus was already inside the overlay: the element behind
    // it must not be recorded as the opener, or closing this session would yank
    // focus to a node the user never left.
    overlay.style.display = '';
    await vi.waitFor(() => expect(document.activeElement).toBe(field));

    overlay.style.display = 'none';
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
  });
});
