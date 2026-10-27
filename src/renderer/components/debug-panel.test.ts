// @vitest-environment jsdom
// N-row close (FEATURE_LEDGER_2026-10-26 §16): the debug panel's ring,
// rendering and visibility were untested. Pins the contract the rest of the
// app relies on: 500-event ring with FIFO eviction, row shape (time/type/
// session, 120-char data truncation), and the hidden-class visibility toggle.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const fitAllVisible = vi.fn();
vi.mock('../terminal-pane.js', () => ({ fitAllVisible }));
vi.mock('../i18n.js', () => ({
  t: (key: string) => key,
  onLocaleChange: () => () => {},
}));
vi.mock('../ansi', () => ({ stripAnsi: (s: string) => s }));
vi.mock('../state.js', () => ({
  appState: { projects: [] },
}));

describe('debug-panel', () => {
  beforeAll(() => {
    document.body.innerHTML = '';
  });

  it('renders logged events as rows when opened, truncating long payloads', async () => {
    const { logDebugEvent, setDebugVisible } = await import('./debug-panel.js');
    logDebugEvent('ptyExit', 'sess-abcdefghij123', { code: 0 });
    logDebugEvent('hookStatus', 'short-id', 'x'.repeat(200));

    setDebugVisible(true);
    const rows = document.querySelectorAll('#debug-panel .debug-event-row');
    expect(rows.length).toBe(2);
    const first = rows[0];
    expect(first.querySelector('.debug-type')!.textContent).toBe('ptyExit');
    // >12-char ids render as `first8..` with the full id kept in the title.
    expect(first.querySelector('.debug-session')!.textContent).toBe('sess-abc..');
    expect(first.querySelector('.debug-session')!.title).toBe('sess-abcdefghij123');
    const data = first.querySelector('.debug-data')!;
    expect(data.textContent).toContain('"code": 0');
    expect(data.textContent!.endsWith('...')).toBe(false); // short payload: no truncation
    // 200-char string payload exceeds 120 chars → truncated head in the cell.
    const data2 = rows[1].querySelector('.debug-data')!;
    expect(data2.textContent!.endsWith('...')).toBe(true);
    expect(data2.textContent!.length).toBe(123); // 120 chars + '...'
  });

  it('caps the ring at MAX_EVENTS=500 with FIFO eviction', async () => {
    const { logDebugEvent, setDebugVisible } = await import('./debug-panel.js');
    for (let i = 0; i < 600; i++) logDebugEvent('stateEvent', `s${i}`);
    setDebugVisible(true);
    const rows = document.querySelectorAll('#debug-panel .debug-event-row');
    expect(rows.length).toBe(500);
    // The two earlier events were evicted; the newest survives.
    const titles = [...rows].map((r) => r.querySelector('.debug-session')!.title);
    expect(titles).toContain('s599');
    expect(titles).not.toContain('sess-abcdefghij123');
  });

  it('setDebugVisible(false) hides the panel and clears the body flag', async () => {
    const { setDebugVisible } = await import('./debug-panel.js');
    setDebugVisible(false);
    const panel = document.getElementById('debug-panel')!;
    expect(panel.classList.contains('hidden')).toBe(true);
    expect(document.body.classList.contains('debug-panel-open')).toBe(false);
  });
});
