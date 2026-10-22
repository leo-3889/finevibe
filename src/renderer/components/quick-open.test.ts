// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

const mockState = vi.hoisted(() => ({
  activeProject: { id: 'p1', path: '/proj' } as { id: string; path: string } | null,
}));

vi.mock('../state.js', () => ({ appState: mockState }));
vi.mock('../open-file-reader.js', () => ({ openFileReaderChecked: vi.fn() }));

interface Deferred {
  promise: Promise<string[]>;
  resolve: (files: string[]) => void;
}

/**
 * Installs a window.finevibe whose listFiles hands out one controllable
 * deferred per query, so responses can be resolved out of order.
 */
function installFileLister(): Map<string, Deferred> {
  const pending = new Map<string, Deferred>();
  const listFiles: Mock = vi.fn((_path: string, query: string) => {
    let resolve!: (files: string[]) => void;
    const promise = new Promise<string[]>((done) => { resolve = done; });
    pending.set(query, { promise, resolve });
    return promise;
  });
  (window as unknown as { finevibe: { fs: { listFiles: Mock } } }).finevibe = {
    fs: { listFiles },
  };
  return pending;
}

function typeQuery(value: string): void {
  const input = document.querySelector('.quick-open-input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function renderedFiles(): string[] {
  return Array.from(document.querySelectorAll('.quick-open-filename'))
    .map((el) => el.textContent ?? '');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  document.body.innerHTML = '';
  mockState.activeProject = { id: 'p1', path: '/proj' };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('quick-open search races', () => {
  it('keeps the newest results when an older listFiles response lands last', async () => {
    // Dynamic import is deliberate: quick-open keeps module-scope state
    // (overlay, results, token) that vi.resetModules() clears per test, so a
    // static import cannot observe the reset graph.
    const pending = installFileLister();
    const { showQuickOpen } = await import('./quick-open.js');
    showQuickOpen();

    typeQuery('alpha');
    vi.advanceTimersByTime(150);
    typeQuery('beta');
    vi.advanceTimersByTime(150);

    pending.get('beta')!.resolve(['src/beta.ts']);
    await vi.runAllTimersAsync();
    expect(renderedFiles()).toEqual(['beta.ts']);

    // The stale response for the first query lands last.
    pending.get('alpha')!.resolve(['src/alpha.ts']);
    await vi.runAllTimersAsync();
    expect(renderedFiles()).toEqual(['beta.ts']);
  });

  it('drops an in-flight search when the overlay is dismissed', async () => {
    const pending = installFileLister();
    const { showQuickOpen } = await import('./quick-open.js');
    showQuickOpen();

    typeQuery('alpha');
    vi.advanceTimersByTime(150);
    const input = document.querySelector('.quick-open-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    pending.get('alpha')!.resolve(['src/alpha.ts']);
    await vi.runAllTimersAsync();
    expect(document.querySelector('.quick-open-item')).toBeNull();
  });

  it('does not paint a previous session response into a re-opened overlay', async () => {
    const pending = installFileLister();
    const { showQuickOpen } = await import('./quick-open.js');
    showQuickOpen();

    typeQuery('alpha');
    vi.advanceTimersByTime(150);
    const input = document.querySelector('.quick-open-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    showQuickOpen();
    pending.get('alpha')!.resolve(['src/alpha.ts']);
    await vi.runAllTimersAsync();
    expect(document.querySelector('.quick-open-item')).toBeNull();
  });

  it('clears a pending debounce on hide so a queued search cannot fire after close', async () => {
    const pending = installFileLister();
    const { showQuickOpen } = await import('./quick-open.js');
    showQuickOpen();

    typeQuery('alpha');
    const input = document.querySelector('.quick-open-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    vi.advanceTimersByTime(150);

    expect(pending.has('alpha')).toBe(false);
  });
});
