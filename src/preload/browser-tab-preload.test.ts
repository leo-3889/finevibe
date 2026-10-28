// @vitest-environment jsdom
/**
 * Row 22 (code-cleanup audit): browser-tab-preload.ts was the last production
 * file at 0% coverage. It is the in-guest half of the browser tab's
 * inspect / flow / draw bridge: main (the pane) sends mode commands over
 * `ipcRenderer.on`, the guest answers with `ipcRenderer.sendToHost`.
 *
 * The test drives the real module: it captures the command handlers the module
 * registers at import, then fires real DOM events and asserts the exact
 * `sendToHost` payloads — the contract the pane (components/browser-tab/pane.ts)
 * consumes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const on = vi.fn();
const sendToHost = vi.fn();
const handlers = new Map<string, (...args: unknown[]) => void>();

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, fn: (...args: unknown[]) => void) => {
      on(channel, fn);
      handlers.set(channel, fn);
    },
    sendToHost: (...args: unknown[]) => sendToHost(...args),
  },
}));

function fire(channel: string, ...args: unknown[]): void {
  const fn = handlers.get(channel);
  expect(fn, `no handler registered for '${channel}'`).toBeTypeOf('function');
  fn!(null, ...args);
}

function fireAll(): void {
  on.mockClear();
  sendToHost.mockClear();
}

afterEach(() => {
  // The module attaches capture listeners to the shared jsdom `document`, and
  // re-importing does not detach the previous instance's: exit every mode
  // before the next case, or an old inspect handler answers the next click.
  for (const channel of ['exit-inspect-mode', 'exit-flow-mode', 'exit-draw-mode']) {
    handlers.get(channel)?.(null);
  }
  handlers.clear();
});

beforeEach(() => {
  handlers.clear();
  on.mockClear();
  sendToHost.mockClear();
  document.body.innerHTML = '';
  document.body.style.cursor = '';
  // Fresh module registry per case: the preload keeps module-level mode state
  // (inspectMode/drawMode/strokes), and re-importing resets it.
  vi.resetModules();
  return import('./browser-tab-preload.js');
});

describe('browser-tab-preload command surface (row 22)', () => {
  it('registers exactly the ten pane commands, each once', () => {
    expect(on.mock.calls.map((c) => c[0]).sort()).toEqual([
      'draw-clear',
      'draw-export-strokes',
      'draw-load-strokes',
      'enter-draw-mode',
      'enter-flow-mode',
      'enter-inspect-mode',
      'exit-draw-mode',
      'exit-flow-mode',
      'exit-inspect-mode',
      'flow-do-click',
    ]);
  });

  it('inspect mode highlights on hover and answers element-selected on click', () => {
    fireAll();
    const button = document.createElement('button');
    button.id = 'go';
    button.textContent = 'Go';
    document.body.append(button);

    fire('enter-inspect-mode');
    expect(document.body.style.cursor).toBe('crosshair');

    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const overlay = document.documentElement.querySelector('div');
    expect(overlay).not.toBeNull();
    expect((overlay as HTMLElement).style.display).toBe('block');

    fire('exit-inspect-mode');
    expect(document.body.style.cursor).toBe('');
    fire('enter-inspect-mode');

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 12, clientY: 34 }));
    expect(sendToHost).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendToHost.mock.calls[0] as [string, {
      metadata: { tagName: string; id: string; textContent: string; selectors: Array<{ type: string; value: string }> };
      x: number;
      y: number;
    }];
    expect(channel).toBe('element-selected');
    expect(payload.x).toBe(12);
    expect(payload.y).toBe(34);
    expect(payload.metadata.tagName).toBe('button');
    expect(payload.metadata.id).toBe('go');
    expect(payload.metadata.textContent).toBe('Go');
    // The id selector is offered, and the css path anchors on the id.
    expect(payload.metadata.selectors.map((s) => s.type)).toContain('id');
    expect(payload.metadata.selectors.find((s) => s.type === 'id')?.value).toBe('#go');
  });

  it('inspect mode builds qa/attr/id/css selectors and prefers nth-of-type', () => {
    fireAll();
    const wrap = document.createElement('section');
    wrap.innerHTML = '<div data-testid="t1" data-role="box"></div><div data-testid="t2"></div>';
    document.body.append(wrap);
    fire('enter-inspect-mode');
    const target = wrap.children[0] as HTMLElement;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const { metadata } = sendToHost.mock.calls[0][1] as {
      metadata: { selectors: Array<{ type: string; label: string; value: string }> };
    };
    expect(metadata.selectors).toEqual([
      { type: 'qa', label: 'data-testid', value: '[data-testid="t1"]' },
      { type: 'attr', label: 'data-role', value: '[data-role="box"]' },
      { type: 'css', label: 'css', value: 'section > div:nth-of-type(1)' },
    ]);
  });

  it('truncates long text content at 150 chars with an ellipsis', () => {
    fireAll();
    const p = document.createElement('p');
    p.textContent = 'x'.repeat(200);
    document.body.append(p);
    fire('enter-inspect-mode');
    p.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const { metadata } = sendToHost.mock.calls[0][1] as { metadata: { textContent: string } };
    expect(metadata.textContent).toBe(`${'x'.repeat(150)}…`);
  });

  it('flow mode answers flow-element-picked and suppresses the synthetic flow-do-click', () => {
    fireAll();
    const link = document.createElement('a');
    link.id = 'target';
    let clicks = 0;
    link.addEventListener('click', () => { clicks += 1; });
    document.body.append(link);

    fire('enter-flow-mode');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 2 }));
    expect(sendToHost.mock.calls[0][0]).toBe('flow-element-picked');

    // flow-do-click performs the click itself and swallows the resulting
    // event, so the pane sees one pick for a user click and none for the
    // scripted one.
    fireAll();
    fire('flow-do-click', '#target');
    expect(clicks).toBe(1);
    expect(sendToHost).not.toHaveBeenCalled();

    fireAll();
    fire('flow-do-click', '#missing');
    expect(clicks).toBe(1);
    fire('exit-flow-mode');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sendToHost).not.toHaveBeenCalled();
  });

  it('draw mode records a stroke and ends it with draw-stroke-end', () => {
    fireAll();
    const stub = stubCanvas();
    fire('enter-draw-mode');
    const canvas = stub.canvas();
    expect(canvas).not.toBeNull();

        canvas!.dispatchEvent(pointer('pointerdown', 0, 0));
    canvas!.dispatchEvent(pointer('pointermove', 5, 5));
    canvas!.dispatchEvent(pointer('pointerup', 9, 8));
    expect(sendToHost.mock.calls.map((c) => c[0])).toEqual(['draw-stroke-end']);
    expect(sendToHost.mock.calls[0][1]).toEqual({ x: 9, y: 8 });
    expect(stub.ctx.stroke).toHaveBeenCalled();

    fireAll();
    fire('draw-export-strokes');
    expect(sendToHost.mock.calls[0][0]).toBe('draw-strokes');
    const strokes = sendToHost.mock.calls[0][1] as { x: number; y: number }[][];
    expect(strokes).toEqual([[{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 8 }]]);

    fire('exit-draw-mode');
  });

  it('draw-load-strokes replays valid strokes and drops malformed ones', () => {
    fireAll();
    const stub = stubCanvas();
    fire('enter-draw-mode');
    const canvas = stub.canvas();
    expect(canvas).not.toBeNull();
    fireAll();
    fire('draw-load-strokes', [
      [{ x: 1, y: 2 }, { x: 3, y: 4 }],
      'not-a-stroke',
      [{ x: NaN, y: 1 }, { x: 2, y: 2 }],
      [{ x: 7, y: 7 }],
      [{ x: 5, y: 5 }, { x: 6, y: 6 }],
    ]);
    fireAll();
    fire('draw-export-strokes');
    expect(sendToHost.mock.calls[0][1]).toEqual(
      [[{ x: 1, y: 2 }, { x: 3, y: 4 }],
      [{ x: 5, y: 5 }, { x: 6, y: 6 }],
    ]);
    // A loaded picture is not a completed single stroke: the next pointerdown
    // must add, not clear.
    fireAll();
    canvas!.dispatchEvent(pointer('pointerdown', 1, 1));
    fireAll();
    fire('draw-export-strokes');
    expect((sendToHost.mock.calls[0][1] as unknown[][]).length).toBe(3);
    fire('draw-clear');
    fireAll();
    fire('draw-export-strokes');
    expect(sendToHost.mock.calls[0][1]).toEqual([]);
    fire('exit-draw-mode');
  });

  it('a window resize keeps the drawing (snapshot, resize, blit)', () => {
    fireAll();
    const stub = stubCanvas();
    fire('enter-draw-mode');
    const canvas = stub.canvas();
    expect(canvas).not.toBeNull();
    canvas!.dispatchEvent(pointer('pointerdown', 2, 2));
    fireAll();

    Object.defineProperty(window, 'innerWidth', { value: 1234, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 777, configurable: true });
    window.dispatchEvent(new Event('resize'));

    expect(stub.ctx.drawImage).toHaveBeenCalledTimes(2); // tmp snapshot + blit back
    expect(canvas!.width).toBe(1234);
    expect(canvas!.height).toBe(777);
    fire('exit-draw-mode');
  });

  it('mouseout hides the highlight, and clicking the highlight itself is ignored', () => {
    fireAll();
    const box = document.createElement('div');
    document.body.append(box);
    fire('enter-inspect-mode');

    box.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    // The overlay is appended to <html> after <body>, so it is the last element.
    const overlay = document.documentElement.lastElementChild as HTMLElement;
    // Identified by its own signature (the module styles it via cssText): a
    // fixed, pointer-events:none, top-most overlay - not the box in <body>.
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.pointerEvents).toBe('none');
    box.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(overlay.style.display).toBe('none');

    // The overlay sits under the cursor: a click that lands on it must not be
    // reported as an element selection.
    fireAll();
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sendToHost).not.toHaveBeenCalled();
    fire('exit-inspect-mode');
  });

  it('enter-draw-mode survives a canvas with no 2D context', () => {
    fireAll();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => fire('enter-draw-mode')).not.toThrow();
    // Pointer commands are no-ops without a context (the drawCtx guard).
    const canvas = document.documentElement.lastElementChild as HTMLElement;
    canvas.dispatchEvent(pointer('pointerdown', 1, 1));
    canvas.dispatchEvent(pointer('pointermove', 2, 2));
    canvas.dispatchEvent(pointer('pointerup', 3, 3));
    expect(sendToHost).not.toHaveBeenCalled();
    fire('exit-draw-mode');
  });

  it('draw commands are inert before enter-draw-mode', () => {
    fireAll();
    fire('draw-load-strokes', [[{ x: 1, y: 1 }, { x: 2, y: 2 }]]);
    fire('draw-clear');
    fire('draw-export-strokes');
    expect(sendToHost).toHaveBeenCalledWith('draw-strokes', []);
  });
});

/** jsdom has no 2D canvas backend: give every canvas a recording context. */
function stubCanvas(): { ctx: Record<string, ReturnType<typeof vi.fn>>; canvas: () => HTMLCanvasElement | null } {
  const ctx: Record<string, ReturnType<typeof vi.fn>> = {
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    clearRect: vi.fn(), drawImage: vi.fn(),
  };
  const created: HTMLCanvasElement[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    created.push(this);
    return ctx as unknown as CanvasRenderingContext2D;
  });
  return { ctx, canvas: () => created.find((c) => c.parentNode !== null) ?? null };
}

/** Pointer events as plain MouseEvents: jsdom's PointerEvent is unreliable. */
function pointer(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
}
