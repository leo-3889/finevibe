// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OverviewLayout, ProjectRecord } from '../../../shared/types.js';

// Harness mocks: pane.ts pulls the whole widget/modal graph through grid.ts;
// the pane only orchestrates the layout, so stub the grid and the modals.
vi.mock('../../state.js', () => ({ appState: { projects: [], setProjectOverviewLayout: vi.fn() } }));
vi.mock('../../i18n.js', () => ({ t: (k: string) => k }));
vi.mock('./widgets/widget-picker-modal.js', () => ({ showWidgetPicker: vi.fn() }));
vi.mock('./widgets/github-settings-modal.js', () => ({ showGithubSettings: vi.fn() }));
vi.mock('./widgets/sessions-settings-modal.js', () => ({ showSessionsSettings: vi.fn() }));
vi.mock('./widgets/top-files-settings-modal.js', () => ({ showTopFilesSettings: vi.fn() }));

const gridCalls: { opts: { initialLayout: OverviewLayout; onChange(l: OverviewLayout): void } }[] = [];
vi.mock('./grid.js', () => ({
  createProjectTabGrid: vi.fn((opts: { initialLayout: OverviewLayout; onChange(l: OverviewLayout): void }) => {
    gridCalls.push({ opts });
    return {
      setEditMode: vi.fn(), isEditMode: () => false, addWidget: vi.fn(), removeWidget: vi.fn(),
      updateWidgetConfig: vi.fn(), destroy: vi.fn(),
    };
  }),
}));

import { appState } from '../../state.js';
import { createProjectTabPane, destroyProjectTabPane } from './pane.js';

const state = appState as unknown as {
  projects: ProjectRecord[];
  setProjectOverviewLayout: ReturnType<typeof vi.fn>;
};

function seedProject(id: string, layout?: OverviewLayout): ProjectRecord {
  const project = { id, name: `p-${id}`, overviewLayout: layout } as ProjectRecord;
  state.projects.push(project);
  return project;
}

beforeEach(() => {
  state.projects = [];
  state.setProjectOverviewLayout.mockReset();
  // Mirror the real state.ts: mutate the project record in place.
  state.setProjectOverviewLayout.mockImplementation((id: string, layout: OverviewLayout) => {
    const p = state.projects.find((x) => x.id === id);
    if (p) p.overviewLayout = layout;
  });
  gridCalls.length = 0;
});

describe('project-tab pane layout seeding (SA-P2-12)', () => {
  it('reseeds defaults only for an absent layout (fresh install)', () => {
    seedProject('p1');
    createProjectTabPane('s1', 'p1');
    expect(state.setProjectOverviewLayout).toHaveBeenCalledTimes(1);
    expect(gridCalls[0].opts.initialLayout.widgets).toHaveLength(4);
    destroyProjectTabPane('s1');
  });

  it('renders a saved empty layout without reseeding', () => {
    seedProject('p2', { gridVersion: 1, widgets: [] });
    createProjectTabPane('s2', 'p2');
    expect(state.setProjectOverviewLayout).not.toHaveBeenCalled();
    expect(gridCalls[0].opts.initialLayout.widgets).toEqual([]);
    destroyProjectTabPane('s2');
  });

  it('removing the last widget persists [] and re-open renders empty, not defaults', () => {
    const project = seedProject('p3', {
      gridVersion: 1,
      widgets: [{ id: 'w1', type: 'readiness', x: 0, y: 0, w: 8, h: 8 }],
    });
    createProjectTabPane('s3', 'p3');
    // Real grid: removeWidget() → flushChange() → onChange(serialize()) with [].
    gridCalls[0].opts.onChange({ gridVersion: 1, widgets: [] });
    expect(state.setProjectOverviewLayout).toHaveBeenCalledWith('p3', { gridVersion: 1, widgets: [] });
    expect(project.overviewLayout).toEqual({ gridVersion: 1, widgets: [] });

    destroyProjectTabPane('s3');
    state.setProjectOverviewLayout.mockClear();
    createProjectTabPane('s4', 'p3');
    expect(state.setProjectOverviewLayout).not.toHaveBeenCalled();
    expect(gridCalls[1].opts.initialLayout.widgets).toEqual([]);
    destroyProjectTabPane('s4');
  });
});
