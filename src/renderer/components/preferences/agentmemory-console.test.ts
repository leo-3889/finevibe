import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));

const pushModalMock = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock('../modal-manager.js', () => ({ pushModal: pushModalMock }));

type ListenerMap = Record<string, Array<(...args: unknown[]) => void>>;

// Hand-rolled DOM mock following preferences-modal.test.ts, plus a
// textContent set-counter so "no DOM churn on identical content" is
// observable.
function makeElement(tagName = 'div'): Record<string, any> {
  const children: Record<string, any>[] = [];
  const listeners: ListenerMap = {};
  const classValues = new Set<string>();
  let textValue = '';
  const element: Record<string, any> = {
    tagName,
    children,
    dataset: {},
    style: {},
    className: '',
    value: '',
    checked: false,
    type: '',
    id: '',
    textSetCount: 0,
    parentElement: null,
    appendChild(child: Record<string, any>) {
      child.parentElement = element;
      children.push(child);
      return child;
    },
    append(...nodes: Record<string, any>[]) {
      for (const node of nodes) element.appendChild(node);
    },
    remove() {
      if (!element.parentElement) return;
      const siblings = element.parentElement.children as Record<string, any>[];
      element.parentElement.children = siblings.filter((child) => child !== element);
      element.parentElement = null;
    },
    querySelector(selector: string) {
      if (!selector.startsWith('.')) return null;
      const targetClass = selector.slice(1);
      return findInTree(element, (node) => node.className?.split(/\s+/).includes(targetClass));
    },
    addEventListener(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    removeEventListener(event: string, cb: (...args: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((listener) => listener !== cb);
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of listeners[event.type] ?? []) listener(event);
    },
    classList: {
      add(...tokens: string[]) { tokens.forEach((token) => classValues.add(token)); },
      remove(...tokens: string[]) { tokens.forEach((token) => classValues.delete(token)); },
      toggle(token: string, force?: boolean) {
        const shouldAdd = force ?? !classValues.has(token);
        if (shouldAdd) classValues.add(token);
        else classValues.delete(token);
      },
      contains(token: string) { return classValues.has(token); },
    },
  };

  Object.defineProperty(element, 'textContent', {
    get() { return textValue; },
    set(value: string) {
      textValue = value;
      element.textSetCount += 1;
    },
    configurable: true,
  });

  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set(_value: string) {
      children.length = 0;
    },
    configurable: true,
  });

  return element;
}

function findInTree(root: Record<string, any>, predicate: (node: Record<string, any>) => boolean): Record<string, any> | null {
  for (const child of root.children as Record<string, any>[]) {
    if (predicate(child)) return child;
    const nested = findInTree(child, predicate);
    if (nested) return nested;
  }
  return null;
}

let docBody: Record<string, any>;

function findById(root: Record<string, any>, id: string): Record<string, any> | null {
  if (root.id === id) return root;
  for (const child of root.children as Record<string, any>[]) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function click(el: Record<string, any>): void {
  el.dispatchEvent({ type: 'click' });
}

const LOG_PATH = 'C:/userData/agentmemory.log';

let logMock: Mock;
let openExternalMock: Mock;

async function openModal(): Promise<{
  overlay: Record<string, any>;
  pre: Record<string, any>;
  hint: Record<string, any>;
  pathEl: Record<string, any>;
  CONSOLE_URL: string;
}> {
  // The module owns per-modal state (the poll interval + cleanup closure), so
  // each test needs a fresh instance: vi.resetModules() + dynamic import is
  // the only way to get one; a static import would share state across tests.
  const mod = await import('./agentmemory-console.js');
  mod.openAgentmemoryConsoleModal();
  const overlay = findById(docBody, 'agentmemory-console-overlay');
  if (!overlay) throw new Error('console overlay not found');
  const pre = findInTree(overlay, (node) => node.tagName === 'pre');
  const hint = findInTree(overlay, (node) => node.className === 'agentmemory-console-hint');
  const pathEl = findInTree(overlay, (node) => node.className === 'agentmemory-console-path');
  if (!pre || !hint || !pathEl) throw new Error('console modal body not rendered');
  return { overlay, pre, hint, pathEl, CONSOLE_URL: mod.CONSOLE_URL };
}

describe('openAgentmemoryConsoleModal', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    docBody = makeElement('body');

    logMock = vi.fn(async () => ({ path: LOG_PATH, content: '' }));
    openExternalMock = vi.fn(async () => {});

    vi.stubGlobal('document', {
      documentElement: { dataset: {} as Record<string, string> },
      body: docBody,
      getElementById(id: string) { return findById(docBody, id); },
      createElement(tagName: string) { return makeElement(tagName); },
      createTextNode(text: string) { return { textContent: text }; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', {
      finevibe: {
        agentmemory: { log: logMock },
        app: { openExternal: openExternalMock },
      },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the pre, the empty hint and the log path, and shows the overlay', async () => {
    const { overlay, pre, hint, pathEl } = await openModal();

    expect(overlay.style.display).toBe('');
    expect(pre.textContent).toBe('');
    expect(hint.textContent).toBe('agentmemory.consoleEmpty');
    expect(pushModalMock).toHaveBeenCalledTimes(1);

    // The initial poll fills the path label.
    await vi.advanceTimersByTimeAsync(0);
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(pathEl.textContent).toBe(LOG_PATH);
  });

  it('polls every second and shows the returned content', async () => {
    const { pre } = await openModal();
    await vi.advanceTimersByTimeAsync(0);
    expect(pre.textContent).toBe('');

    logMock.mockImplementation(async () => ({ path: LOG_PATH, content: 'line 1' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(pre.textContent).toBe('line 1');

    logMock.mockImplementation(async () => ({ path: LOG_PATH, content: 'line 1\nline 2' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(pre.textContent).toBe('line 1\nline 2');
    expect(logMock).toHaveBeenCalledTimes(3);
  });

  it('leaves the DOM untouched when the tail is identical between polls', async () => {
    logMock.mockImplementation(async () => ({ path: LOG_PATH, content: 'stable' }));
    const { pre, hint } = await openModal();
    await vi.advanceTimersByTimeAsync(0);

    expect(pre.textSetCount).toBe(1);
    expect(hint.style.display).toBe('none');

    await vi.advanceTimersByTimeAsync(3000);
    expect(logMock).toHaveBeenCalledTimes(4);
    expect(pre.textSetCount).toBe(1);
    expect(pre.textContent).toBe('stable');
  });

  it('stops polling once closed and opens the web UI on demand', async () => {
    const { overlay, CONSOLE_URL } = await openModal();
    await vi.advanceTimersByTimeAsync(0);

    const actions = overlay.querySelector('.modal-actions');
    const webBtn = findInTree(actions, (node) => node.className === 'btn-secondary');
    const closeBtn = findInTree(actions, (node) => node.className === 'btn-primary');
    if (!webBtn || !closeBtn) throw new Error('console actions not rendered');

    click(webBtn);
    expect(openExternalMock).toHaveBeenCalledWith(CONSOLE_URL);
    expect(CONSOLE_URL).toBe('http://127.0.0.1:3113');

    click(closeBtn);
    expect(overlay.style.display).toBe('none');
    const callsAtClose = logMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5000);
    expect(logMock).toHaveBeenCalledTimes(callsAtClose);
  });

  it('warns instead of rejecting when opening the web UI fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { overlay, CONSOLE_URL } = await openModal();
      await vi.advanceTimersByTimeAsync(0);
      openExternalMock.mockRejectedValue(new Error('no default handler'));

      const actions = overlay.querySelector('.modal-actions');
      const webBtn = findInTree(actions, (node) => node.className === 'btn-secondary');
      if (!webBtn) throw new Error('console actions not rendered');

      click(webBtn);
      await vi.advanceTimersByTimeAsync(0); // flush the rejection's microtask
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(CONSOLE_URL), expect.any(Error));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
