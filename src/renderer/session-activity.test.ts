import {
  initSession,
  setHookStatus,
  notifyInterrupt,
  setIdle,
  removeSession,
  getStatus,
  noteInspectorEvents,
  onChange,
  _resetForTesting,
} from './session-activity';

beforeEach(() => {
  _resetForTesting();
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

  it('ignores hook events for unknown sessions', () => {
    setHookStatus('s1', 'working');
    expect(getStatus('s1')).toBe('idle');
  });

  it('sets completed status', () => {
    initSession('s1');
    setHookStatus('s1', 'completed');
    expect(getStatus('s1')).toBe('completed');
  });

  it('sets input status', () => {
    initSession('s1');
    setHookStatus('s1', 'input');
    expect(getStatus('s1')).toBe('input');
  });

  it('does not overwrite completed with waiting', () => {
    initSession('s1');
    setHookStatus('s1', 'completed');
    setHookStatus('s1', 'waiting');
    expect(getStatus('s1')).toBe('completed');
  });

  it('lets polled (Transcript) waiting overwrite completed', () => {
    initSession('s1');
    setHookStatus('s1', 'completed');
    // A polled tail that moved to error arrives as waiting/'Transcript' — it
    // must NOT be masked by the hook sticky-completed guard.
    setHookStatus('s1', 'waiting', 'Transcript');
    expect(getStatus('s1')).toBe('waiting');
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

describe('notifyInterrupt', () => {
  it('transitions from working to waiting', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    notifyInterrupt('s1');
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
    setHookStatus('s1', 'working', 'PostToolUse');
    expect(getStatus('s1')).toBe('waiting');
  });

  it('allows UserPromptSubmit to override interrupted state', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    notifyInterrupt('s1');
    expect(getStatus('s1')).toBe('waiting');

    // User submits a new prompt — should clear interrupted and transition to working
    setHookStatus('s1', 'working', 'UserPromptSubmit');
    expect(getStatus('s1')).toBe('working');
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
  it('sets idle status', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    setIdle('s1');
    expect(getStatus('s1')).toBe('idle');
  });

  it('does nothing for unknown session', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    const cb = vi.fn();
    onChange(cb);
    setIdle('unknown'); // must not throw
    // No entry is created for the unknown id: it keeps resolving to the
    // default idle status.
    expect(getStatus('unknown')).toBe('idle');
    // Surviving state untouched: a stray setIdle must not sweep live rows.
    expect(getStatus('s1')).toBe('working');
    // No spurious change event for a session that does not exist.
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('getStatus', () => {
  it('returns idle for unknown session', () => {
    expect(getStatus('unknown')).toBe('idle');
  });
});

describe('removeSession', () => {
  it('removes session', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    removeSession('s1');
    expect(getStatus('s1')).toBe('idle'); // defaults to idle when not found
  });

  it('does nothing for unknown session', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    const cb = vi.fn();
    onChange(cb);
    removeSession('unknown'); // must not throw
    // Removal is scoped to the named id — a typo'd id must not drop the
    // tracked session, and no change event may fire.
    expect(getStatus('s1')).toBe('working');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('onChange unsubscribe', () => {
  it('stops receiving callbacks after unsubscribe', () => {
    initSession('s1');
    const cb = vi.fn();
    const unsub = onChange(cb);

    setHookStatus('s1', 'working');
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    setHookStatus('s1', 'waiting');
    expect(cb).toHaveBeenCalledTimes(1); // no new calls after unsub
  });

  it('only removes the specific subscriber', () => {
    initSession('s1');
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = onChange(cb1);
    onChange(cb2);

    unsub1();
    setHookStatus('s1', 'working');

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});

// The subagent-aware Stop hook writes `Stop:working` (not `completed`) while it
// believes subagents are in flight. If that signal is wrong the session must
// still eventually complete — these cover the renderer backstop that guarantees it.
describe('Stop-resolved-working fallback', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('completes a session left in working by a Stop, after silence', () => {
    initSession('s1');
    setHookStatus('s1', 'working', 'UserPromptSubmit');
    // A Stop that resolved to working (subagents believed in flight).
    setHookStatus('s1', 'working', 'Stop');
    expect(getStatus('s1')).toBe('working');

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(getStatus('s1')).toBe('completed');
  });

  it('does not fire the fallback when a real completion arrives first', () => {
    initSession('s1');
    setHookStatus('s1', 'working', 'Stop');
    setHookStatus('s1', 'completed', 'Stop');
    expect(getStatus('s1')).toBe('completed');

    // The completion cancelled the fallback; it must not re-fire later.
    const cb = vi.fn();
    onChange(cb);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(cb).not.toHaveBeenCalled();
    expect(getStatus('s1')).toBe('completed');
  });

  it('is cancelled by ongoing subagent activity (a later working hook)', () => {
    initSession('s1');
    setHookStatus('s1', 'working', 'Stop');
    // A subagent tool finishes: PostToolUse working — activity, resets the timer.
    vi.advanceTimersByTime(9 * 60 * 1000);
    setHookStatus('s1', 'working', 'PostToolUse');
    // Original 10-min mark passes without a fire because it was reset.
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(getStatus('s1')).toBe('working');
  });

  it('only arms for Stop, not for a plain working hook', () => {
    initSession('s1');
    setHookStatus('s1', 'working', 'PostToolUse');
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(getStatus('s1')).toBe('working');
  });

  it('is cleared when the session goes idle before firing', () => {
    initSession('s1');
    setHookStatus('s1', 'working', 'Stop');
    setIdle('s1');
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(getStatus('s1')).toBe('idle');
  });
});

// The tick (✓) is a lie while the session is still waiting on children: the
// glyph must stay '…' until the last subagent stops, on every surface, because
// every surface reads this module's status.
describe('in-flight subagents suppress completed', () => {
  const ev = (type: string, agent_id?: string) =>
    ({ type, timestamp: 0, hookEvent: '', agent_id } as never);

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('holds completed while a subagent runs and releases it on stop', () => {
    initSession('s1');
    setHookStatus('s1', 'working', 'UserPromptSubmit');
    noteInspectorEvents('s1', [ev('subagent_start', 'A')]);
    setHookStatus('s1', 'completed', 'Transcript');
    expect(getStatus('s1')).toBe('working');

    noteInspectorEvents('s1', [ev('subagent_stop', 'A')]);
    expect(getStatus('s1')).toBe('completed');
  });

  it('waits for every child in a parallel batch', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    noteInspectorEvents('s1', [ev('subagent_start', 'A'), ev('subagent_start', 'B')]);
    setHookStatus('s1', 'completed');
    noteInspectorEvents('s1', [ev('subagent_stop', 'A')]);
    expect(getStatus('s1')).toBe('working');
    noteInspectorEvents('s1', [ev('subagent_stop', 'B')]);
    expect(getStatus('s1')).toBe('completed');
  });

  it('a lost SubagentStop cannot wedge the session: the backstop completes it', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    noteInspectorEvents('s1', [ev('subagent_start', 'A')]);
    setHookStatus('s1', 'completed');
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(getStatus('s1')).toBe('completed');
  });

  it('a parent stop event clears a stale child set', () => {
    initSession('s1');
    setHookStatus('s1', 'working');
    noteInspectorEvents('s1', [ev('subagent_start', 'A')]);
    noteInspectorEvents('s1', [ev('stop')]);
    setHookStatus('s1', 'completed');
    expect(getStatus('s1')).toBe('completed');
  });

  it('is scoped per session and cleared on init/idle/remove', () => {
    initSession('s1');
    initSession('s2');
    setHookStatus('s1', 'working');
    setHookStatus('s2', 'working');
    noteInspectorEvents('s1', [ev('subagent_start', 'A')]);

    setHookStatus('s2', 'completed');
    expect(getStatus('s2')).toBe('completed');

    setIdle('s1');
    setHookStatus('s1', 'working');
    setHookStatus('s1', 'completed');
    expect(getStatus('s1')).toBe('completed');
  });
});
