import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAppState = vi.hoisted(() => ({
  starPromptDismissed: false,
  appLaunchCount: 0,
  dismissStarPrompt: vi.fn(),
}));

vi.mock('../state.js', () => ({ appState: mockAppState }));

interface FakeEl {
  id: string;
  textContent: string;
  innerHTML: string;
  className: string;
  style: Record<string, string>;
  classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; contains: ReturnType<typeof vi.fn> };
  appendChild: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  querySelector: (sel: string) => FakeEl | null;
  querySelectorAll: ReturnType<typeof vi.fn>;
  children: FakeEl[];
}

function makeEl(id: string = ''): FakeEl {
  const el: FakeEl = {
    id,
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
    appendChild: vi.fn((child: FakeEl) => { el.children.push(child); }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn((sel: string) => {
      const idMatch = sel.match(/^#(.+)$/);
      if (idMatch) {
        return findById(el, idMatch[1]);
      }
      return null;
    }) as unknown as (sel: string) => FakeEl | null,
    querySelectorAll: vi.fn(() => []),
    children: [],
  };
  return el;
}

function findById(root: FakeEl, id: string): FakeEl | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findById(c, id);
    if (found) return found;
  }
  return null;
}

let docElements: Record<string, FakeEl> = {};
let body: FakeEl;

function stubDOM(): void {
  docElements = {};
  body = makeEl('body');

  vi.stubGlobal('document', {
    getElementById: (id: string) => docElements[id] || findById(body, id) || null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createElement: (_tag: string) => makeEl(''),
    body,
  });
  vi.stubGlobal('window', {
    vibeyard: { app: { openExternal: vi.fn() } },
  });
}

import { checkStarPrompt } from './star-prompt-dialog';

beforeEach(() => {
  mockAppState.starPromptDismissed = false;
  mockAppState.appLaunchCount = 0;
  mockAppState.dismissStarPrompt.mockClear();
  stubDOM();
});

describe('checkStarPrompt', () => {
  it('does not show dialog when launch count is below threshold', () => {
    mockAppState.appLaunchCount = 5;
    checkStarPrompt();
    expect(body.appendChild).not.toHaveBeenCalled();
  });

  it('does not show dialog when already dismissed', () => {
    mockAppState.appLaunchCount = 15;
    mockAppState.starPromptDismissed = true;
    checkStarPrompt();
    expect(body.appendChild).not.toHaveBeenCalled();
  });

  it('shows dialog when launch count meets threshold and not dismissed', () => {
    mockAppState.appLaunchCount = 10;
    checkStarPrompt();
    const overlay = findById(body, 'star-prompt-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.style.display).toBe('');
  });

  it('shows dialog when launch count exceeds threshold', () => {
    mockAppState.appLaunchCount = 25;
    checkStarPrompt();
    const overlay = findById(body, 'star-prompt-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.style.display).toBe('');
  });
});
