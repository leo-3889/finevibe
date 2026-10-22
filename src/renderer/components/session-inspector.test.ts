// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CI-05: the auto-follow handler is a full-panel consumer of `session-changed`.
// A batch close (Close All) emits one deferred event per session plus one
// payload-less trailing kick; following every event re-rendered the whole
// inspector once per closing tab.
const harness = vi.hoisted(() => {
  const listeners = new Map<string, Array<(data?: unknown) => void>>();
  return {
    listeners,
    project: {
      id: 'p1',
      name: 'p1',
      path: '/proj',
      activeSessionId: 's1',
      sessions: [
        { id: 's1', name: 'S1', providerId: 'claude', type: 'terminal' },
        { id: 's2', name: 'S2', providerId: 'claude', type: 'terminal' },
      ],
    } as {
      id: string;
      name: string;
      path: string;
      activeSessionId: string;
      sessions: Array<{ id: string; name: string; providerId: string; type: string }>;
    },
    on: (event: string, cb: (data?: unknown) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    },
    emit: (event: string, data?: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb(data);
    },
  };
});

vi.mock('../state.js', () => ({
  appState: {
    get activeProject() { return harness.project; },
    on: harness.on,
  },
}));
vi.mock('../session-inspector-state.js', () => ({
  onChange: vi.fn(),
  clearSession: vi.fn(),
}));
vi.mock('./terminal-pane.js', () => ({ fitAllVisible: vi.fn() }));
vi.mock('./session-inspector-views.js', () => ({
  renderCosts: vi.fn(),
  renderTools: vi.fn(),
  renderContext: vi.fn(),
}));
vi.mock('./session-inspector-utils.js', () => ({
  canInspectSession: () => true,
  resetUIState: vi.fn(),
}));
vi.mock('./split-layout.js', () => ({ renderLayout: vi.fn() }));
vi.mock('./session-inspector-timeline.js', () => ({
  renderTimeline: vi.fn(),
  appendTimelineEvents: vi.fn(() => true),
  disposeTimelineRenderState: vi.fn(),
}));

// Static import: this file mocks the module under test's dependencies, so the
// mocks (hoisted above these imports) must be installed first.
const { initSessionInspector, openInspector, closeInspector } = await import('./session-inspector.js');
const { renderTimeline } = await import('./session-inspector-timeline.js');
const { inspectorState } = await import('./session-inspector-state-ui.js');

beforeEach(() => {
  closeInspector();
  harness.listeners.clear();
  harness.project.activeSessionId = 's1';
  document.body.innerHTML = '<div id="terminal-container"></div>';
  initSessionInspector();
  openInspector('s1');
  vi.mocked(renderTimeline).mockClear();
});

afterEach(() => {
  closeInspector();
});

describe('session-inspector auto-follow (CI-05)', () => {
  it('renders for the batch kick only, not for every deferred session event', () => {
    // Close All: the active session moved to s2, then the per-session events.
    harness.project.activeSessionId = 's2';
    harness.emit('session-changed', { sessionId: 's1', kind: 'remove', deferRender: true });
    expect(renderTimeline).not.toHaveBeenCalled();

    // The trailing kick (identical payload without deferRender) follows once.
    harness.emit('session-changed', { sessionId: 's1', kind: 'remove' });
    expect(renderTimeline).toHaveBeenCalledTimes(1);
  });

  it('keeps following a plain activation', () => {
    harness.project.activeSessionId = 's2';
    harness.emit('session-changed', { sessionId: 's2', kind: 'activate' });
    expect(renderTimeline).toHaveBeenCalledTimes(1);
  });

  it('follows the payload-less full path', () => {
    harness.project.activeSessionId = 's2';
    harness.emit('session-changed');
    expect(renderTimeline).toHaveBeenCalledTimes(1);
  });
});

// C3R-03: arm-on-entry. A second pointerdown while a drag is live used to
// arm another pointer-capture/click pair on the handle.
describe('session-inspector resize (C3R-03)', () => {
  const pointerEvent = (type: string, id: number, clientX = 100): PointerEvent => {
    const e = new Event(type) as PointerEvent;
    Object.assign(e, { pointerId: id, clientX });
    return e;
  };

  it('ignores a second pointerdown while a drag is live', () => {
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    const handle = document.querySelector('.inspector-resize-handle') as HTMLElement;

    handle.dispatchEvent(pointerEvent('pointerdown', 1));
    expect(inspectorState.resizing).toBe(true);

    handle.dispatchEvent(pointerEvent('pointerdown', 2)); // mid-drag: ignored
    expect(Element.prototype.setPointerCapture).toHaveBeenCalledTimes(1);

    handle.dispatchEvent(pointerEvent('pointerup', 1));
    expect(inspectorState.resizing).toBe(false);

    handle.dispatchEvent(pointerEvent('pointerdown', 3)); // fresh drag arms
    expect(Element.prototype.setPointerCapture).toHaveBeenCalledTimes(2);
    handle.dispatchEvent(pointerEvent('pointerup', 3));
  });
});
