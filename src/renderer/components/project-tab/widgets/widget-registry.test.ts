import { vi } from 'vitest';

// The factories pull a lot of DOM/state context. The registry test only verifies
// metadata shape, so stub each factory module to a no-op.
vi.mock('./readiness-widget.js', () => ({
  createReadinessWidget: () => ({ element: document.createElement('div'), destroy() {} }),
}));
vi.mock('./provider-tools-widget.js', () => ({
  createProviderToolsWidget: () => ({ element: document.createElement('div'), destroy() {} }),
}));
vi.mock('./github-widgets.js', () => ({
  createGithubPRsWidget: () => ({ element: document.createElement('div'), destroy() {} }),
  createGithubIssuesWidget: () => ({ element: document.createElement('div'), destroy() {} }),
}));
vi.mock('./team-widget.js', () => ({
  createTeamWidget: () => ({ element: document.createElement('div'), destroy() {} }),
}));
vi.mock('./kanban-widget.js', () => ({
  createKanbanWidget: () => ({ element: document.createElement('div'), destroy() {} }),
}));
vi.mock('./sessions-widget.js', () => ({
  createSessionsWidget: () => ({ element: document.createElement('div'), destroy() {} }),
}));

import { listWidgetTypes, getWidgetMeta } from './widget-registry';
import type { OverviewWidgetType } from '../../../../shared/types';

const ALL_TYPES: OverviewWidgetType[] = ['readiness', 'provider-tools', 'github-prs', 'github-issues', 'team', 'kanban', 'sessions'];

describe('widget registry', () => {
  it('exposes every documented widget type', () => {
    const types = listWidgetTypes().map((m) => m.type);
    for (const t of ALL_TYPES) expect(types).toContain(t);
  });

  it('every widget meta has a non-empty displayName, factory, defaultConfig', () => {
    for (const meta of listWidgetTypes()) {
      expect(meta.displayName.length).toBeGreaterThan(0);
      expect(typeof meta.factory).toBe('function');
      expect(meta.defaultConfig).toBeDefined();
      expect(meta.defaultSize.w).toBeGreaterThan(0);
      expect(meta.defaultSize.h).toBeGreaterThan(0);
    }
  });

  it('non-github widgets forbid duplicates; github widgets allow them', () => {
    const expectedMulti = new Set<OverviewWidgetType>(['github-prs', 'github-issues']);
    for (const meta of listWidgetTypes()) {
      expect(meta.allowMultiple).toBe(expectedMulti.has(meta.type));
    }
  });

  it('github widgets expose hasSettings = true', () => {
    expect(getWidgetMeta('github-prs')?.hasSettings).toBe(true);
    expect(getWidgetMeta('github-issues')?.hasSettings).toBe(true);
  });

  it('github widgets share the same default config shape', () => {
    const prs = getWidgetMeta('github-prs')!.defaultConfig;
    const iss = getWidgetMeta('github-issues')!.defaultConfig;
    expect(prs).toEqual(iss);
    expect(prs.state).toBe('open');
    expect(prs.max).toBe(10);
    expect(prs.refreshSeconds).toBe(300);
  });

  it('returns undefined for unknown types', () => {
    expect(getWidgetMeta('unknown' as OverviewWidgetType)).toBeUndefined();
  });
});
