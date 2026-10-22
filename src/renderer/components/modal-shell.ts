export interface ModalShell {
  overlay: HTMLElement;
  titleEl: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
}

export interface ModalShellOptions {
  id: string;
  title: string;
  wide?: boolean;
}

interface FocusOwner {
  visible: boolean;
  opener: HTMLElement | null;
}

const focusOwners = new WeakMap<HTMLElement, FocusOwner>();

const FOCUSABLE = 'button, textarea, input:not([type="hidden"]), select';

/** Same priority as modal.ts: a text input first, then any control (body before actions). */
function firstFocusable(box: HTMLElement): HTMLElement | null {
  const textInput = box.querySelector<HTMLElement>('input[type="text"]');
  if (textInput) return textInput;
  const body = box.querySelector('.modal-body');
  const actions = box.querySelector('.modal-actions');
  return body?.querySelector<HTMLElement>(FOCUSABLE)
    ?? actions?.querySelector<HTMLElement>(FOCUSABLE)
    ?? null;
}

/**
 * A dialog opened over a terminal pane does not own the keyboard unless focus
 * moves into it: xterm's helper textarea keeps focus and swallows every
 * keystroke, and the PTY never gets focus back when the dialog closes.
 *
 * Watching the overlay's `style` attribute is the single choke point that
 * covers every consumer: they all open with `display = ''` and close with
 * `display = 'none'` (ModalCloser.close, bindModalDismiss, or their own hide).
 */
function trackFocus(overlay: HTMLElement, box: HTMLElement): void {
  // Node-env tests (e.g. preferences-modal.test.ts) drive createModalShell with
  // a fake document and no DOM globals; focus wiring is browser/jsdom only.
  if (typeof MutationObserver !== 'function') return;

  const owner: FocusOwner = { visible: overlay.style.display !== 'none', opener: null };
  focusOwners.set(overlay, owner);

  const observer = new MutationObserver(() => {
    const visible = overlay.style.display !== 'none';
    // Transition-only guard: focus() writes no `style`, so even a focus handler
    // that mutates the attribute lands here with no visible change and cannot
    // loop.
    if (visible === owner.visible) return;
    owner.visible = visible;

    if (visible) {
      const active = document.activeElement as HTMLElement | null;
      owner.opener = active && active.isConnected && !overlay.contains(active) ? active : null;
      const target = firstFocusable(box);
      if (target) {
        target.focus();
      } else {
        // Nothing focusable: at least pull focus off the PTY.
        box.tabIndex = -1;
        box.focus();
      }
    } else {
      const opener = owner.opener;
      owner.opener = null;
      if (opener && opener.isConnected) opener.focus();
    }
  });
  observer.observe(overlay, { attributes: true, attributeFilter: ['style'] });
}

export function createModalShell({ id, title, wide }: ModalShellOptions): ModalShell {
  const existing = document.getElementById(id);
  if (existing) {
    // A node created by an earlier call (or present in the static markup) has
    // no observer yet; attach at most one per node.
    if (!focusOwners.has(existing)) {
      trackFocus(existing, existing.querySelector('.modal-box') as HTMLElement);
    }
    return {
      overlay: existing,
      titleEl: existing.querySelector('.modal-title') as HTMLElement,
      body: existing.querySelector('.modal-body') as HTMLElement,
      actions: existing.querySelector('.modal-actions') as HTMLElement,
    };
  }

  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'modal-overlay';
  overlay.style.display = 'none';

  const box = document.createElement('div');
  box.className = wide ? 'modal-box modal-wide' : 'modal-box';

  const titleEl = document.createElement('div');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;
  box.appendChild(titleEl);

  const body = document.createElement('div');
  body.className = 'modal-body';
  box.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  box.appendChild(actions);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  trackFocus(overlay, box);

  return { overlay, titleEl, body, actions };
}

export function createModalButton(label: string, primary: boolean): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = primary ? 'btn-primary' : 'btn-secondary';
  btn.textContent = label;
  return btn;
}
