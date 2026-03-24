import {
  initSession,
  setHookStatus,
  notifyPtyData,
  notifyInterrupt,
  setIdle,
  removeSession,
  getStatus,
  onChange,
  _resetForTesting,
} from './session-activity';

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('initSession', () => {
  it('sets status to waiting', () => {
    initSession('s1');
    expect(getStatus('s1')).toBe('waiting');
  });

  it('notifies listeners', () => {
    const cb = vi.fn();
    onChange(cb);
    initSession('s1');
    expect(cb).toHaveBeenCalledWith('s1', 'waiting');
  });
});

describe('setHookStatus', () => {
  it('sets working status', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    expect(getStatus('s1')).toBe('working');
  });

  it('auto-inits session if not present', () => {
    setHookStatus('s1', 'working');
    expect(getStatus('s1')).toBe('working');
  });

  it('transitions to waiting after staleness timeout', () => {
    initSession('s1');
    setHookStatus('s1', 'working');

    vi.advanceTimersByTime(119_999);
    expect(getStatus('s1')).toBe('working');

    vi.advanceTimersByTime(1);
    expect(getStatus('s1')).toBe('waiting');
  });

  it('clears staleness timer on new status', () => {
    initSession('s1');
    setHookStatus('s1', 'working');

    vi.advanceTimersByTime(60_000);
    setHookStatus('s1', 'waiting');

    vi.advanceTimersByTime(120_000);
    expect(getStatus('s1')).toBe('waiting');
  });

  it('sets completed status', () => {
    initSession('s1');
    setHookStatus('s1', 'completed');
    expect(getStatus('s1')).toBe('completed');
  });

  it('sets permission status', () => {
    initSession('s1');
    setHookStatus('s1', 'permission');
    expect(getStatus('s1')).toBe('permission');
  });

  it('does not overwrite completed with waiting', () => {
    initSession('s1');
    setHookStatus('s1', 'completed');
    setHookStatus('s1', 'waiting');
    expect(getStatus('s1')).toBe('completed');
  });

  it('allows working to overwrite completed (new prompt)', () => {
    initSession('s1');
    setHookStatus('s1', 'completed');
    setHookStatus('s1', 'working');
    expect(getStatus('s1')).toBe('working');
  });

  it('does not notify if status unchanged', () => {
    initSession('s1');
    setHookStatus('s1', 'waiting');
    const cb = vi.fn();
    onChange(cb);
    setHookStatus('s1', 'waiting');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('notifyPtyData', () => {
  it('resets staleness timer when working', () => {
    initSession('s1');
    setHookStatus('s1', 'working');

    vi.advanceTimersByTime(100_000);
    notifyPtyData('s1');

    // Should reset the 120s timer
    vi.advanceTimersByTime(100_000);
    expect(getStatus('s1')).toBe('working');

    vi.advanceTimersByTime(20_000);
    expect(getStatus('s1')).toBe('waiting');
  });

  it('does nothing when not working', () => {
    initSession('s1');
    // Status is 'waiting', notifyPtyData should be a no-op
    notifyPtyData('s1');
    expect(getStatus('s1')).toBe('waiting');
  });

  it('does nothing for unknown session', () => {
    notifyPtyData('unknown');
    expect(getStatus('unknown')).toBe('idle');
  });
});

describe('notifyInterrupt', () => {
  it('transitions from working to waiting', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    notifyInterrupt('s1');
    expect(getStatus('s1')).toBe('waiting');
  });

  it('clears staleness timer', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    notifyInterrupt('s1');

    // Timer should be cleared — no spurious transition after 120s
    vi.advanceTimersByTime(120_000);
    expect(getStatus('s1')).toBe('waiting');
  });

  it('does nothing when not in working state', () => {
    initSession('s1');
    notifyInterrupt('s1');
    expect(getStatus('s1')).toBe('waiting');

    setHookStatus('s1', 'completed');
    notifyInterrupt('s1');
    expect(getStatus('s1')).toBe('completed');
  });

  it('does nothing for unknown session', () => {
    notifyInterrupt('unknown'); // should not throw
    expect(getStatus('unknown')).toBe('idle');
  });

  it('ignores stale working hooks after interrupt', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    notifyInterrupt('s1');
    expect(getStatus('s1')).toBe('waiting');

    // A stale PostToolUse 'working' hook arrives after the interrupt
    setHookStatus('s1', 'working');
    expect(getStatus('s1')).toBe('waiting');
  });

  it('clears interrupted flag on non-working hook status', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    notifyInterrupt('s1');

    // CLI fires a definitive 'completed' — clears the interrupted flag
    setHookStatus('s1', 'completed');
    expect(getStatus('s1')).toBe('completed');

    // Now a new 'working' prompt should be accepted again
    setHookStatus('s1', 'working');
    expect(getStatus('s1')).toBe('working');
  });
});

describe('setIdle', () => {
  it('overrides to idle and clears timer', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    setIdle('s1');
    expect(getStatus('s1')).toBe('idle');

    // Timer should be cleared — no transition after 120s
    vi.advanceTimersByTime(120_000);
    expect(getStatus('s1')).toBe('idle');
  });

  it('does nothing for unknown session', () => {
    setIdle('unknown'); // should not throw
  });
});

describe('getStatus', () => {
  it('returns idle for unknown session', () => {
    expect(getStatus('unknown')).toBe('idle');
  });
});

describe('removeSession', () => {
  it('removes session and clears timer', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    removeSession('s1');
    expect(getStatus('s1')).toBe('idle'); // defaults to idle when not found

    // Timer should be cleared
    vi.advanceTimersByTime(120_000);
    expect(getStatus('s1')).toBe('idle');
  });

  it('does nothing for unknown session', () => {
    removeSession('unknown'); // should not throw
  });
});
