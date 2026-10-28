import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appState } from './state';
import { onChange } from './session-activity';
import { initNotificationSound, _resetForTesting } from './notification-sound';

vi.mock('./state', () => ({
  appState: {
    on: vi.fn(),
    activeProject: { activeSessionId: 'other-session' },
    preferences: { soundOnSessionWaiting: true },
  },
}));
vi.mock('./session-activity', () => ({ onChange: vi.fn() }));

type Handler = (sessionId: string, status: string) => void;

function fire(handlerIndex = 0): Handler {
  return vi.mocked(onChange).mock.calls[handlerIndex][0] as Handler;
}

let audioCtor: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTesting();
  vi.mocked(onChange).mockReset();
  vi.mocked(appState.on).mockReset();
  audioCtor = vi.fn(() => ({
    currentTime: 0,
    createOscillator: () => ({
      connect: vi.fn(), start: vi.fn(), stop: vi.fn(), frequency: { value: 0 },
    }),
    createGain: () => ({
      connect: vi.fn(),
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    }),
    destination: {},
  }));
  (globalThis as { AudioContext?: unknown }).AudioContext = audioCtor;
  (appState as { activeProject: unknown }).activeProject = { activeSessionId: 'other-session' };
  (appState as { preferences: { soundOnSessionWaiting: boolean } }).preferences.soundOnSessionWaiting = true;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
});

describe('notification-sound gate (J-matrix #13)', () => {
  it('chimes on a working->waiting edge', () => {
    initNotificationSound();
    const h = fire();
    h('s1', 'working');
    expect(audioCtor).not.toHaveBeenCalled();
    h('s1', 'waiting');
    expect(audioCtor).toHaveBeenCalledTimes(1);
  });

  it('respects the soundOnSessionWaiting preference', () => {
    (appState as { preferences: { soundOnSessionWaiting: boolean } }).preferences.soundOnSessionWaiting = false;
    initNotificationSound();
    const h = fire();
    h('s1', 'working');
    h('s1', 'waiting');
    expect(audioCtor).not.toHaveBeenCalled();
  });

  it('stays silent for the session the user is looking at', () => {
    (appState as { activeProject: unknown }).activeProject = { activeSessionId: 's1' };
    initNotificationSound();
    const h = fire();
    h('s1', 'working');
    h('s1', 'waiting');
    expect(audioCtor).not.toHaveBeenCalled();
  });

  it('only the working->edge fires (waiting->working is silent, repeat waiting does not re-chime)', () => {
    initNotificationSound();
    const h = fire();
    h('s1', 'working');
    h('s1', 'waiting'); // chime 1
    h('s1', 'working'); // no chime (not a waiting edge)
    expect(audioCtor).toHaveBeenCalledTimes(1);
    h('s1', 'waiting'); // within 30 s -> suppressed
    expect(audioCtor).toHaveBeenCalledTimes(1);
  });

  it('re-chimes once the 30 s spacing elapses', () => {
    initNotificationSound();
    const h = fire();
    h('s1', 'working');
    h('s1', 'waiting'); // chime 1
    vi.advanceTimersByTime(30_001);
    h('s1', 'working');
    h('s1', 'waiting'); // chime 2
    expect(audioCtor).toHaveBeenCalledTimes(2);
  });

  it('session-removed drops the state maps (a re-added session chimes despite the spacing)', () => {
    initNotificationSound();
    const h = fire();
    h('s1', 'working');
    h('s1', 'waiting'); // chime 1
    const removedHandler = vi.mocked(appState.on).mock.calls.find(([e]) => e === 'session-removed')![1];
    removedHandler({ sessionId: 's1' });
    h('s1', 'working');
    h('s1', 'waiting'); // spacing cleared -> chime 2 immediately
    expect(audioCtor).toHaveBeenCalledTimes(2);
  });
});
