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
