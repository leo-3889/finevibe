// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../provider-availability.js', () => ({
  loadProviderMetas: vi.fn(async () => {}),
  loadProviderAvailability: vi.fn(async () => {}),
  hasMultipleAvailableProviders: vi.fn(() => false),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getCachedProviderMetas: vi.fn(() => []),
  getAvailableProviderMetas: vi.fn(() => []),
  getTeamChatProviderMetas: vi.fn(() => []),
  getTeamCapableProviderIds: vi.fn(() => new Set()),
  getProviderCapabilities: vi.fn(() => ({ profiles: false })),
  getProviderDisplayName: vi.fn((id: string) => id),
}));

vi.mock('./preferences-modal.js', () => ({ showPreferencesModal: vi.fn() }));
vi.mock('./modal.js', () => ({ showModal: vi.fn(), setModalError: vi.fn(), closeModal: vi.fn(), showConfirmDialog: vi.fn() }));
vi.mock('./file-tree.js', () => ({ renderFileTree: vi.fn(), clearProjectState: vi.fn(), closeFileTree: vi.fn(), FILE_MANAGER: 'Files' }));
vi.mock('./session-history.js', () => ({ renderSessionHistory: vi.fn(), closeSessionHistory: vi.fn(), clearProjectState: vi.fn() }));
vi.mock('./hover-card.js', () => ({ attachHoverCard: vi.fn() }));
vi.mock('./git-panel.js', () => ({ mountGitPanel: vi.fn(), closeGitPanel: vi.fn() }));
vi.mock('./project-settings.js', () => ({ promptProjectSettings: vi.fn() }));
vi.mock('../session-unread.js', () => ({ hasUnreadInProject: vi.fn(() => false), onChange: vi.fn() }));
vi.mock('../session-activity.js', () => ({ onChange: vi.fn(), STATUS_GLYPH: {} }));
vi.mock('../git-status.js', () => ({ gitChangeCount: vi.fn(() => null), onChange: vi.fn() }));
vi.mock('../discussions-badge.js', () => ({
  init: vi.fn(),
  getNewCount: vi.fn(() => 0),
  markSeen: vi.fn(),
  onChange: vi.fn(),
  DISCUSSIONS_URL: 'https://example.com/discussions',
}));

const IDS = ['project-list', 'btn-add-project', 'btn-preferences', 'sidebar', 'sidebar-resize-handle', 'sidebar-discussions', 'btn-toggle-sidebar', 'sidebar-active-sessions'];

interface FineVibeStub {
  app: { openExternal: Mock };
  store: { load: Mock; save: Mock };
}

function testWindow(): { finevibe: FineVibeStub } {
  // Preload injects the full FinevibeApi; these tests replace it with vi.fn
  // stubs implementing only the members they touch — the real shape is
  // unrepresentable for a stub, hence the unchecked cast.
  return window as unknown as { finevibe: FineVibeStub };
}

function persistedState(discussionsVisible: boolean) {
  return {
    version: 1,
    projects: [],
    activeProjectId: null,
    preferences: { sidebarViews: { gitPanel: true, sessionHistory: true, discussions: discussionsVisible, fileTree: true, activeSessions: true } },
  };
}

function stubDom() {
  for (const id of IDS) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
  testWindow().finevibe = {
    app: { openExternal: vi.fn() },
    store: { load: vi.fn(), save: vi.fn(async () => {}) },
  };
}

describe('discussions visibility across load', () => {
  beforeEach(() => {
    // Module-loading boundary test: sidebar.ts grabs DOM nodes at module load,
    // so each case must re-import after stubbing the DOM (static import cannot work).
    vi.resetModules();
    stubDom();
  });

  it('hides the discussions link after state-loaded when the preference is off', async () => {
    testWindow().finevibe!.store.load.mockResolvedValue(persistedState(false));
    const { initSidebar } = await import('./sidebar.js');
    const { appState } = await import('../state.js');

    initSidebar();
    const el = document.getElementById('sidebar-discussions')!;
    // Before load: default preferences → visible (mirrors real bootstrap order).
    expect(el.classList.contains('hidden')).toBe(false);

    await appState.load();
    // After load: persisted sidebarViews.discussions === false must hide it.
    expect(el.classList.contains('hidden')).toBe(true);
  });

  it('keeps the discussions link visible when the preference is on', async () => {
    testWindow().finevibe!.store.load.mockResolvedValue(persistedState(true));
    const { initSidebar } = await import('./sidebar.js');
    const { appState } = await import('../state.js');

    initSidebar();
    await appState.load();
    expect(document.getElementById('sidebar-discussions')!.classList.contains('hidden')).toBe(false);
  });
});

describe('discussions locale re-translation', () => {
  beforeEach(() => {
    // Module-loading boundary test: sidebar.ts grabs DOM nodes at module load,
    // so each case must re-import after stubbing the DOM (static import cannot work).
    vi.resetModules();
    stubDom();
  });

  it('re-translates the discussions card when the locale is applied after bootstrap', async () => {
    testWindow().finevibe!.store.load.mockResolvedValue(persistedState(true));
    const { setLocale } = await import('../i18n.js');
    const { initSidebar } = await import('./sidebar.js');

    initSidebar();
    const el = document.getElementById('sidebar-discussions')!;
    // Bootstrap renders with the i18n default locale.
    expect(el.innerHTML).toContain('FineVibe Discussions');

    // initI18n() applies the persisted locale after components have rendered;
    // the card must re-translate even though the badge count never changed.
    setLocale('zh-CN');
    expect(el.innerHTML).toContain('讨论');
    expect(el.innerHTML).not.toContain('FineVibe Discussions');
  });
});
