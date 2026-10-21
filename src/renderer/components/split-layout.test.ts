// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// state.ts persists through the preload bridge; stub it before any state import.
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${Math.random().toString(36).slice(2)}`,
});

vi.mock('../session-cost.js', () => ({
  getCost: vi.fn().mockReturnValue(null),
  restoreCost: vi.fn(),
}));

vi.mock('../session-context.js', () => ({
  restoreContext: vi.fn(),
}));

vi.mock('../provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(),
}));

// Every pane module is mocked: split-layout only calls their create/destroy/show
// surface, and the terminal mock's hideAllPanes doubles as the renderLayout probe
// (renderLayout calls it exactly once per render, on every branch).
// vi.mock factories are hoisted above all top-level statements, so the shared
// instance getter they close over must be created with vi.hoisted (a plain
// `const` here is in the TDZ when the factories run → collection fails).
const { undefinedInstance } = vi.hoisted(() => ({
  undefinedInstance: () => undefined,
}));

vi.mock('./terminal-pane.js', () => ({
  createTerminalPane: vi.fn(),
  attachToContainer: vi.fn(),
  showPane: vi.fn(),
  hideAllPanes: vi.fn(),
  fitAllVisible: vi.fn(),
  setFocused: vi.fn(),
  spawnTerminal: vi.fn(),
  setPendingPrompt: vi.fn(),
  setPendingSystemPrompt: vi.fn(),
  destroyTerminal: vi.fn(),
  getTerminalInstance: undefinedInstance,
}));

vi.mock('./mcp-inspector.js', () => ({
  createInspectorPane: vi.fn(),
  destroyInspectorPane: vi.fn(),
  showInspectorPane: vi.fn(),
  hideAllInspectorPanes: vi.fn(),
  attachInspectorToContainer: vi.fn(),
  getInspectorInstance: undefinedInstance,
  disconnectInspector: vi.fn(),
}));

vi.mock('./session-inspector.js', () => ({
  isInspectorOpen: vi.fn(() => false),
}));

vi.mock('./file-viewer.js', () => ({
  createFileViewerPane: vi.fn(),
  destroyFileViewerPane: vi.fn(),
  showFileViewerPane: vi.fn(),
  hideAllFileViewerPanes: vi.fn(),
  attachFileViewerToContainer: vi.fn(),
  getFileViewerInstance: undefinedInstance,
}));

vi.mock('./file-reader.js', () => ({
  createFileReaderPane: vi.fn(),
  destroyFileReaderPane: vi.fn(),
  showFileReaderPane: vi.fn(),
  hideAllFileReaderPanes: vi.fn(),
  attachFileReaderToContainer: vi.fn(),
  getFileReaderInstance: undefinedInstance,
  setFileReaderLine: vi.fn(),
}));

vi.mock('./remote-terminal-pane.js', () => ({
  getRemoteTerminalInstance: undefinedInstance,
  destroyRemoteTerminal: vi.fn(),
  attachRemoteToContainer: vi.fn(),
  showRemotePane: vi.fn(),
  hideAllRemotePanes: vi.fn(),
}));

vi.mock('./browser-tab-pane.js', () => ({
  createBrowserTabPane: vi.fn(),
  destroyBrowserTabPane: vi.fn(),
  showBrowserTabPane: vi.fn(),
  hideAllBrowserTabPanes: vi.fn(),
  attachBrowserTabToContainer: vi.fn(),
  getBrowserTabInstance: undefinedInstance,
}));

vi.mock('./project-tab/pane.js', () => ({
  createProjectTabPane: vi.fn(),
  destroyProjectTabPane: vi.fn(),
  showProjectTabPane: vi.fn(),
  hideAllProjectTabPanes: vi.fn(),
  attachProjectTabToContainer: vi.fn(),
  getProjectTabInstance: undefinedInstance,
}));

vi.mock('./kanban/pane.js', () => ({
  createKanbanPane: vi.fn(),
  destroyKanbanPane: vi.fn(),
  showKanbanPane: vi.fn(),
  hideAllKanbanPanes: vi.fn(),
  attachKanbanToContainer: vi.fn(),
  getKanbanInstance: undefinedInstance,
}));

vi.mock('./team/pane.js', () => ({
  createTeamPane: vi.fn(),
  destroyTeamPane: vi.fn(),
  showTeamPane: vi.fn(),
  hideAllTeamPanes: vi.fn(),
  attachTeamToContainer: vi.fn(),
  getTeamInstance: undefinedInstance,
}));

vi.mock('./tab-bar/session-menu.js', () => ({
  quickNewSession: vi.fn(),
}));

vi.mock('../session-unread.js', () => ({
  isUnread: vi.fn(() => false),
  onChange: vi.fn(() => () => {}),
}));

// Imported first for its side effects: split-layout.ts resolves
// `#terminal-container` at import time, so the DOM + bridge must be created
// before it loads (static imports evaluate in source order).
import './split-layout-test-dom.js';
import { initSplitLayout } from './split-layout';
import { appState, _resetForTesting } from '../state';
import { hideAllPanes, destroyTerminal } from './terminal-pane.js';

const hideAllPanesMock = hideAllPanes as Mock;
const destroyTerminalMock = destroyTerminal as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  initSplitLayout();
});

describe('split-layout render coalescing (P2-28)', () => {
  it('renders once when a project with 5 sessions is removed', () => {
    const project = appState.addProject('Five', '/five');
    const sessions = Array.from({ length: 5 }, (_, i) => appState.addSession(project.id, `S${i}`)!);

    hideAllPanesMock.mockClear();
    appState.removeProject(project.id);

    // Every pane is torn down…
    expect(destroyTerminalMock).toHaveBeenCalledTimes(5);
    // …and the layout renders exactly once (the project-changed after
    // project-removed), not once per session-removed plus one (6 before P2-28).
    expect(hideAllPanesMock).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(5);
  });

  it('still renders per event for a single-session removal', () => {
    const project = appState.addProject('One', '/one');
    const session = appState.addSession(project.id, 'S1')!;

    hideAllPanesMock.mockClear();
    appState.removeSession(project.id, session.id);

    // removeSession keeps the immediate teardown render (plus its own
    // session-changed render); only the project-removal batch defers.
    expect(destroyTerminalMock).toHaveBeenCalledTimes(1);
    expect(hideAllPanesMock).toHaveBeenCalled();
  });
});
