// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub every collaborator the pane wires into listeners so pane creation
// touches only DOM + the stubbed surface; the assertions below are about the
// <webview> element's security-relevant attributes and listeners.
vi.mock('../../state.js', () => ({
  appState: {
    findSessionWithProject: vi.fn(() => undefined),
    setSessionBrowserIsolated: vi.fn(),
    updateSessionBrowserTabUrl: vi.fn(),
  },
}));
vi.mock('../../shortcuts.js', () => ({
  shortcutManager: { getKeys: vi.fn(() => []), matchEvent: vi.fn() },
  displayKeys: vi.fn(() => ''),
}));
vi.mock('../chrome-import-modal.js', () => ({ showChromeImportModal: vi.fn() }));
vi.mock('../submit-disabled.js', () => ({ wireSubmitDisabled: vi.fn() }));
vi.mock('./viewport.js', () => ({
  applyViewport: vi.fn(),
  openViewportDropdown: vi.fn(),
  closeViewportDropdown: vi.fn(),
}));
vi.mock('./inspect-mode.js', () => ({
  toggleInspectMode: vi.fn(),
  showElementInfo: vi.fn(),
  dismissInspect: vi.fn(),
}));
vi.mock('./draw-mode.js', () => ({
  toggleDrawMode: vi.fn(),
  clearDrawing: vi.fn(),
  dismissDraw: vi.fn(),
  sendDrawToNewSession: vi.fn(async () => {}),
  sendDrawToCustomSession: vi.fn(async () => {}),
  positionDrawPopover: vi.fn(),
}));
vi.mock('./flow-recording.js', () => ({
  addFlowStep: vi.fn(),
  clearFlow: vi.fn(),
  renderFlowSteps: vi.fn(),
  toggleFlowMode: vi.fn(),
}));
vi.mock('./flow-picker.js', () => ({
  showFlowPicker: vi.fn(),
  dismissFlowPicker: vi.fn(),
}));
vi.mock('./session-integration.js', () => ({
  deliverDraw: vi.fn(),
  deliverFlow: vi.fn(),
  deliverInspect: vi.fn(),
  sendFlowToCustomSession: vi.fn(),
  sendFlowToNewSession: vi.fn(),
  sendToCustomSession: vi.fn(),
  sendToNewSession: vi.fn(),
}));
vi.mock('./send-menu.js', () => ({
  showSendMenu: vi.fn(),
  dismissSendMenu: vi.fn(),
}));

import { createBrowserTabPane, destroyBrowserTabPane } from './pane.js';
import { instances } from './instance.js';
import { appState } from '../../state.js';
import { renderFlowSteps } from './flow-recording.js';
import { showElementInfo } from './inspect-mode.js';

describe('createBrowserTabPane guest popup containment', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as unknown as { vibeyard: unknown }).vibeyard = {
      app: {
        getBrowserPreloadPath: vi.fn(async () => 'C:/app/browser-tab-preload.js'),
        openExternal: vi.fn(async () => {}),
      },
    };
  });

  afterEach(() => {
    destroyBrowserTabPane('sess-1');
    instances.clear();
  });

  it('creates the webview without allowpopups and without a new-window listener', () => {
    // allowpopups lets a guest window.open() attach a nested webview in the
    // tab's own partition (cookie jar). The renderer `new-window` event that
    // the old listener relied on no longer exists in Electron (v41 typings
    // have only macOS new-window-for-tab), so the only containment is to
    // leave popups without an attach target.
    const spy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    createBrowserTabPane('sess-1');
    const instance = instances.get('sess-1');
    expect(instance).toBeDefined();
    const webview = instance!.webview as unknown as HTMLElement;
    expect(webview.tagName).toBe('WEBVIEW');
    expect(webview.hasAttribute('allowpopups')).toBe(false);

    const webviewEvents = spy.mock.calls
      .map((call, i) => (spy.mock.contexts[i] === webview ? String(call[0]) : null))
      .filter((t): t is string => t !== null);
    // Sanity: the spy saw the webview's real wiring, so a missing
    // 'new-window' below is a real absence, not a blind spy.
    expect(webviewEvents).toContain('did-navigate');
    expect(webviewEvents).not.toContain('new-window');
    spy.mockRestore();
  });

  it('pins the shared partition attribute used by the main-process attach guard', () => {
    createBrowserTabPane('sess-1');
    const webview = instances.get('sess-1')!.webview as unknown as HTMLElement;
    expect(webview.getAttribute('partition')).toBe('persist:vibeyard-browser');
  });
});

// P2-100 + P2-106: the isolation toggle rebuilt the pane on the SAME
// sessionId — identical partition name (the isolated jar survived every
// toggle) and the destroy+create dropped flow steps, draw strokes and the
// inspect selection.
describe('isolation toggle rebuild', () => {
  let clearIsolatedStorage: ReturnType<typeof vi.fn>;
  let sessionState: { browserIsolated: boolean };

  beforeEach(() => {
    document.body.innerHTML = '';
    clearIsolatedStorage = vi.fn();
    (window as unknown as { vibeyard: unknown }).vibeyard = {
      app: {
        getBrowserPreloadPath: vi.fn(async () => 'C:/app/browser-tab-preload.js'),
        openExternal: vi.fn(async () => {}),
      },
      browser: {
        saveScreenshot: vi.fn(async () => ''),
        clearIsolatedStorage,
      },
    };
    // The rebuild reads browserIsolated back through findSessionWithProject,
    // so the setter must mutate the same session object the reader sees.
    sessionState = { browserIsolated: false };
    vi.mocked(appState.findSessionWithProject).mockReturnValue(
      { session: sessionState } as never,
    );
    vi.mocked(appState.setSessionBrowserIsolated).mockImplementation(
      ((_id: string, value: boolean) => { sessionState!.browserIsolated = value; }) as never,
    );
  });

  afterEach(() => {
    destroyBrowserTabPane('sess-1');
    instances.clear();
    vi.mocked(appState.findSessionWithProject).mockReturnValue(undefined as never);
  });

  function clickIsolation(): void {
    const btn = instances
      .get('sess-1')!
      .element.querySelector('.browser-isolation-btn') as HTMLElement;
    btn.click();
  }

  function partition(): string | null {
    return instances.get('sess-1')!.webview.getAttribute('partition');
  }

  it('clears the isolated jar on every toggle, both directions', async () => {
    createBrowserTabPane('sess-1');
    expect(partition()).toBe('persist:vibeyard-browser');

    clickIsolation();
    await vi.waitFor(() => expect(clearIsolatedStorage).toHaveBeenCalledWith('sess-1'));
    expect(appState.setSessionBrowserIsolated).toHaveBeenCalledWith('sess-1', true);
    expect(partition()).toBe('persist:vibeyard-browser-iso-sess-1');

    // Leaving isolation clears the jar too: an isolated login must not
    // survive in it for the app's life.
    clickIsolation();
    await vi.waitFor(() => expect(clearIsolatedStorage).toHaveBeenCalledTimes(2));
    expect(appState.setSessionBrowserIsolated).toHaveBeenCalledWith('sess-1', false);
    expect(partition()).toBe('persist:vibeyard-browser');
  });

  it('carries recorded flow steps and the recording mode over the rebuild', async () => {
    createBrowserTabPane('sess-1');
    const instance = instances.get('sess-1')!;
    instance.flowMode = true;
    instance.flowSteps = [{ type: 'navigate', url: 'https://a.test/' }];

    clickIsolation();
    await vi.waitFor(() => expect(clearIsolatedStorage).toHaveBeenCalled());

    const fresh = instances.get('sess-1')!;
    expect(fresh).not.toBe(instance);
    expect(fresh.flowSteps).toEqual([{ type: 'navigate', url: 'https://a.test/' }]);
    expect(fresh.flowMode).toBe(true);
    expect(renderFlowSteps).toHaveBeenCalledWith(fresh);
    expect(fresh.recordBtn.textContent).toBe('\u25A0 Stop');
    expect(fresh.drawBtn.disabled).toBe(true);
  });

  it('carries the inspect selection over the rebuild', async () => {
    createBrowserTabPane('sess-1');
    const info = {
      tagName: 'button',
      id: '',
      classes: [],
      textContent: 'OK',
      selectors: [{ type: 'css' as const, label: 'button', value: 'button' }],
      activeSelector: { type: 'css' as const, label: 'button', value: 'button' },
      pageUrl: 'https://a.test/',
    };
    const instance = instances.get('sess-1')!;
    instance.inspectMode = true;
    instance.selectedElement = info;

    clickIsolation();
    await vi.waitFor(() => expect(clearIsolatedStorage).toHaveBeenCalled());

    const fresh = instances.get('sess-1')!;
    expect(fresh.inspectMode).toBe(true);
    expect(showElementInfo).toHaveBeenCalledWith(fresh, info, 24, 24);
  });

  it('exports strokes from the dying guest and replays them into the fresh one', async () => {
    createBrowserTabPane('sess-1');
    const instance = instances.get('sess-1')!;
    instance.drawMode = true;
    const strokes = [[{ x: 1, y: 2 }, { x: 3, y: 4 }]];
    // The guest answers 'draw-export-strokes' with a draw-strokes message.
    instance.webview.send = vi.fn((channel: string) => {
      if (channel === 'draw-export-strokes') {
        instance.webview.dispatchEvent(
          Object.assign(new CustomEvent('ipc-message'), {
            channel: 'draw-strokes',
            args: [strokes],
          }),
        );
      }
    });

    clickIsolation();
    await vi.waitFor(() => expect(clearIsolatedStorage).toHaveBeenCalled());

    const fresh = instances.get('sess-1')!;
    expect(fresh.drawMode).toBe(true);
    const newSend = vi.fn();
    fresh.webview.send = newSend;
    fresh.webview.dispatchEvent(new Event('did-stop-loading'));
    expect(newSend).toHaveBeenCalledWith('enter-draw-mode');
    expect(newSend).toHaveBeenCalledWith('draw-load-strokes', strokes);
  });
});
