// Row 31: the renderer log funnel. The contract that matters is that a line
// reaches BOTH sinks, and that the funnel can never break or flood the app.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { rlog, _resetBudgetForTesting } from './log.js';

type WriteFn = (level: string, message: string) => void;

function bridge(): { write: WriteFn & ReturnType<typeof vi.fn> } {
  const write = vi.fn() as WriteFn & ReturnType<typeof vi.fn>;
  (globalThis as { window?: unknown }).window = { finevibe: { log: { write } } };
  return { write };
}

beforeEach(() => {
  _resetBudgetForTesting();
  bridge();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe('rlog (row 31)', () => {
  it('ships the joined message to main and keeps the console call', () => {
    const { write } = bridge();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rlog('warn', 'pty spawn failed', { code: 2 });
    expect(spy).toHaveBeenCalledWith('pty spawn failed', { code: 2 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]).toEqual(['warn', 'pty spawn failed {"code":2}']);
  });

  it('formats an Error as its message and caps an oversized line', () => {
    const { write } = bridge();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rlog('error', new Error('boom'), 'x'.repeat(3000));
    const [, message] = write.mock.calls[0] as [string, string];
    // The Error is formatted through its stack ("Error: boom\n at ..."), then
    // the whole shipped line is capped at MAX_MESSAGE_CHARS.
    expect(message).toContain('boom');
    expect(message.length).toBe(2000);
  });

  it('drops the tail past the per-minute budget, never the console', () => {
    const { write } = bridge();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (let i = 0; i < 260; i++) rlog('log', `line ${i}`);
    expect(write).toHaveBeenCalledTimes(200);
    expect(console.log).toHaveBeenCalledTimes(260);
  });

  it('never throws without the bridge (plain-browser tests, mid-teardown)', () => {
    delete (globalThis as { window?: unknown }).window;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(() => rlog('info', 'no bridge here')).not.toThrow();
  });

  it('swallows a throwing console patch (the file route is what ships)', () => {
    const { write } = bridge();
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('console patched'); });
    expect(() => rlog('log', 'still ships')).not.toThrow();
    expect(write).toHaveBeenCalledWith('log', 'still ships');
  });
});
