import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable stand-in for the i18n engine: the group auto-name template is
// real inside this file without depending on the `tab.group.defaultName`
// locale handoff (the key lands in en.json/zh-CN.json separately).
vi.mock('../i18n.js', () => ({
  t: (key: string, vars?: Record<string, string | number>) =>
    key === 'tab.group.defaultName' ? `Group ${vars?.num ?? ''}` : key,
  allTranslations: (key: string) => (key === 'tab.group.defaultName' ? ['Group {num}'] : [key]),
}));

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++uuidCounter}`,
});

import {
  TAB_GROUP_COLOR_COUNT,
  TAB_GROUP_MAX_MEMBERS,
  findGroupForSession,
  groupTabsInProject,
  isGroupableTab,
  normalizeTabGroups,
  pruneSessionFromTabGroups,
  renameTabGroupInProject,
  ungroupInProject,
} from './tab-group-state.js';
import type { ProjectRecord, SessionRecord, TabGroupRecord } from '../../shared/types.js';

function cli(id: string): SessionRecord {
  return { id, name: `Session ${id}`, cliSessionId: null, createdAt: '0' };
}
function special(id: string, type: NonNullable<SessionRecord['type']>): SessionRecord {
  return { ...cli(id), type };
}
function makeProject(...ids: string[]): ProjectRecord {
  return {
    id: 'p1',
    name: 'P',
    path: '/p',
    sessions: ids.map(cli),
    activeSessionId: null,
    layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
  };
}
function group(id: string, name: string, sessionIds: string[], colorIndex = 0): TabGroupRecord {
  return { id, name, sessionIds, colorIndex };
}

beforeEach(() => {
  uuidCounter = 0;
});

describe('isGroupableTab', () => {
  it('accepts CLI and tool tabs', () => {
    expect(isGroupableTab(cli('s1'))).toBe(true);
    expect(isGroupableTab(special('s2', 'file-reader'))).toBe(true);
    expect(isGroupableTab(special('s3', 'diff-viewer'))).toBe(true);
    expect(isGroupableTab(special('s4', 'browser-tab'))).toBe(true);
  });

  it('rejects the pinned project tools (mirrors the rename guard)', () => {
    expect(isGroupableTab(special('s1', 'project-tab'))).toBe(false);
    expect(isGroupableTab(special('s2', 'kanban'))).toBe(false);
    expect(isGroupableTab(special('s3', 'team'))).toBe(false);
  });
});

describe('findGroupForSession', () => {
  it('returns the containing group', () => {
    const p = makeProject('a', 'b', 'c');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b'])];
    expect(findGroupForSession(p, 'b')?.id).toBe('g1');
  });

  it('returns null for an ungrouped tab and for a project without groups', () => {
    const p = makeProject('a', 'b', 'c');
    expect(findGroupForSession(p, 'a')).toBeNull();
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b'])];
    expect(findGroupForSession(p, 'c')).toBeNull();
  });
});

describe('groupTabsInProject', () => {
  it('creates a pair from two ungrouped tabs, land-adjacent and ordered by sessions index', () => {
    const p = makeProject('a', 'b', 'c', 'd');
    const id = groupTabsInProject(p, 'd', 'a');
    expect(id).not.toBeNull();
    const g = findGroupForSession(p, 'a')!;
    expect(g.sessionIds).toEqual(['d', 'a']);
    // d was dragged from the far right onto a: it lands beside the target…
    expect(p.sessions.map((s) => s.id)).toEqual(['d', 'a', 'b', 'c']);
    // …so the pair is contiguous (invariant 4) with the auto name + first color.
    expect(g.name).toBe('Group 1');
    expect(g.colorIndex).toBe(0);
  });

  it('orders pair members by project.sessions, not by drag direction', () => {
    const p = makeProject('a', 'b', 'c');
    groupTabsInProject(p, 'a', 'c');
    const g = findGroupForSession(p, 'c')!;
    expect(p.sessions.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(g.sessionIds).toEqual(['a', 'c']);
  });

  it('relocates the dragged tab with its whole group adjacent to the target and absorbs it', () => {
    const p = makeProject('a', 'b', 'c', 'd');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b'])];
    const id = groupTabsInProject(p, 'b', 'd');
    expect(id).toBe('g1');
    expect(findGroupForSession(p, 'c')).toBeNull();
    // The whole [a,b] run follows the drop: it ends up beside d…
    expect(p.sessions.map((s) => s.id)).toEqual(['c', 'a', 'b', 'd']);
    // …and absorbs it as the third member.
    expect(findGroupForSession(p, 'd')!.sessionIds).toEqual(['a', 'b', 'd']);
    expect(p.tabGroups!.length).toBe(1);
    expect(findGroupForSession(p, 'd')!.name).toBe('Group 1');
  });

  it('joins an ungrouped tab at the group boundary nearest the drag (left side)', () => {
    const p = makeProject('a', 'b', 'c', 'd');
    p.tabGroups = [group('g1', 'Group 1', ['b', 'c'])];
    const id = groupTabsInProject(p, 'a', 'b');
    expect(id).toBe('g1');
    expect(findGroupForSession(p, 'a')!.sessionIds).toEqual(['a', 'b', 'c']);
    expect(p.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('joins an ungrouped tab at the group boundary nearest the drag (right side)', () => {
    const p = makeProject('a', 'b', 'c', 'd');
    p.tabGroups = [group('g1', 'Group 1', ['b', 'c'])];
    const id = groupTabsInProject(p, 'd', 'c');
    expect(id).toBe('g1');
    expect(findGroupForSession(p, 'd')!.sessionIds).toEqual(['b', 'c', 'd']);
    expect(p.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('merges two groups into the target group and dissolves the dragged one', () => {
    const p = makeProject('a', 'b', 'c', 'd');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b'], 0), group('g2', 'Group 2', ['c', 'd'], 1)];
    const id = groupTabsInProject(p, 'b', 'c');
    expect(id).toBe('g2');
    expect(p.tabGroups!.length).toBe(1);
    expect(p.tabGroups![0].id).toBe('g2');
    expect(p.tabGroups![0].sessionIds).toEqual(['a', 'b', 'c', 'd']);
    expect(p.tabGroups![0].name).toBe('Group 2');
  });

  it('relocates the merged block contiguously when the groups are not adjacent', () => {
    const p = makeProject('a', 'b', 'c', 'd', 'e');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b'], 0), group('g2', 'Group 2', ['d', 'e'], 1)];
    groupTabsInProject(p, 'a', 'e');
    expect(p.sessions.map((s) => s.id)).toEqual(['c', 'd', 'e', 'a', 'b']);
    expect(p.tabGroups![0].sessionIds).toEqual(['d', 'e', 'a', 'b']);
  });

  it('no-ops on same group, equal ids and unknown ids', () => {
    const p = makeProject('a', 'b', 'c');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b'])];
    const before = JSON.stringify(p);
    expect(groupTabsInProject(p, 'a', 'b')).toBeNull();
    expect(groupTabsInProject(p, 'a', 'a')).toBeNull();
    expect(groupTabsInProject(p, 'a', 'ghost')).toBeNull();
    expect(groupTabsInProject(p, 'ghost', 'a')).toBeNull();
    expect(JSON.stringify(p)).toBe(before);
  });

  it('rejects non-groupable tabs on either side', () => {
    for (const type of ['project-tab', 'kanban', 'team'] as const) {
      const p = makeProject('a', 'b');
      p.sessions[1] = special('b', type);
      expect(groupTabsInProject(p, 'a', 'b')).toBeNull();
      expect(p.tabGroups).toBeUndefined();
      const p2 = makeProject('a', 'b');
      p2.sessions[0] = special('a', type);
      expect(groupTabsInProject(p2, 'a', 'b')).toBeNull();
      expect(p2.tabGroups).toBeUndefined();
    }
  });

  it('refuses to push a group past TAB_GROUP_MAX_MEMBERS', () => {
    const ids = Array.from({ length: TAB_GROUP_MAX_MEMBERS + 1 }, (_, i) => `s${i + 1}`);
    const p = makeProject(...ids);
    p.tabGroups = [group('g1', 'Group 1', ids.slice(0, TAB_GROUP_MAX_MEMBERS))];
    const before = JSON.stringify(p);
    expect(groupTabsInProject(p, ids[TAB_GROUP_MAX_MEMBERS], 's1')).toBeNull();
    expect(groupTabsInProject(p, 's1', ids[TAB_GROUP_MAX_MEMBERS])).toBeNull();
    expect(JSON.stringify(p)).toBe(before);
  });

  it('assigns the lowest free color index', () => {
    const p = makeProject('a', 'b', 'c', 'd');
    expect(groupTabsInProject(p, 'a', 'b')).not.toBeNull();
    expect(groupTabsInProject(p, 'c', 'd')).not.toBeNull();
    expect(p.tabGroups!.map((g) => g.colorIndex).sort()).toEqual([0, 1]);
    ungroupInProject(p, p.tabGroups![0].id);
    const p2 = makeProject('e', 'f');
    p2.tabGroups = p.tabGroups;
    expect(groupTabsInProject(p2, 'e', 'f')).not.toBeNull();
    expect(p2.tabGroups!.find((g) => g.sessionIds.includes('e'))!.colorIndex).toBe(0);
  });

  it('auto-names new groups past the highest existing group number', () => {
    const p = makeProject('a', 'b', 'c', 'd', 'e');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b'])];
    groupTabsInProject(p, 'c', 'd');
    expect(p.tabGroups!.find((g) => g.sessionIds.includes('c'))!.name).toBe('Group 2');
    // A rename to a non-numbered name resets the counter, like sessions.
    renameTabGroupInProject(p, 'g1', 'Frontend');
    groupTabsInProject(p, 'e', 'd');
    expect(p.tabGroups!.find((g) => g.sessionIds.includes('e'))!.name).toBe('Group 2');
  });
});

describe('normalizeTabGroups', () => {
  it('drops member ids absent from project.sessions and dissolves groups below 2', () => {
    const p = makeProject('a', 'b');
    p.tabGroups = [
      group('g1', 'Group 1', ['a', 'b', 'ghost']),
      group('g2', 'Group 2', ['a', 'ghost']),
    ];
    normalizeTabGroups(p);
    expect(p.tabGroups).toEqual([group('g1', 'Group 1', ['a', 'b'], 0)]);
  });

  it('drops ids duplicated across groups — the first group keeps the member', () => {
    const p = makeProject('a', 'b', 'c');
    p.tabGroups = [
      group('g1', 'Group 1', ['a', 'b']),
      group('g2', 'Group 2', ['b', 'c']),
    ];
    normalizeTabGroups(p);
    expect(p.tabGroups!.length).toBe(1);
    expect(p.tabGroups![0].id).toBe('g1');
    expect(p.tabGroups![0].sessionIds).toEqual(['a', 'b']);
  });

  it('splits a non-contiguous group into runs; the extra run gets a fresh auto name + lowest free color', () => {
    const p = makeProject('a', 'b', 'c', 'd', 'e');
    p.tabGroups = [group('g1', 'Frontend', ['a', 'b', 'd', 'e'], 2)];
    normalizeTabGroups(p);
    expect(p.tabGroups!.length).toBe(2);
    expect(p.tabGroups![0]).toEqual(group('g1', 'Frontend', ['a', 'b'], 2));
    expect(p.tabGroups![1].id).not.toBe('g1');
    expect(p.tabGroups![1].sessionIds).toEqual(['d', 'e']);
    expect(p.tabGroups![1].name).toBe('Group 1');
    expect(p.tabGroups![1].colorIndex).toBe(0);
  });

  it('dissolves size-1 runs left by a middle-tab drag-out', () => {
    const p = makeProject('a', 'b', 'c');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'c'])];
    normalizeTabGroups(p);
    expect(p.tabGroups).toBeUndefined();
  });

  it('clamps out-of-range colors and dedupes collisions to the lowest free index', () => {
    const p = makeProject('a', 'b', 'c', 'd');
    p.tabGroups = [
      group('g1', 'Group 1', ['a', 'b'], 3),
      group('g2', 'Group 2', ['c', 'd'], 3 + TAB_GROUP_COLOR_COUNT),
    ];
    normalizeTabGroups(p);
    expect(p.tabGroups!.map((g) => g.colorIndex)).toEqual([3, 0]);
    const hostile = makeProject('a', 'b', 'c', 'd');
    hostile.tabGroups = [
      group('g1', 'Group 1', ['a', 'b'], -3),
      group('g2', 'Group 2', ['c', 'd'], 1.5),
    ];
    normalizeTabGroups(hostile);
    for (const g of hostile.tabGroups!) {
      expect(Number.isInteger(g.colorIndex)).toBe(true);
      expect(g.colorIndex).toBeGreaterThanOrEqual(0);
      expect(g.colorIndex).toBeLessThan(TAB_GROUP_COLOR_COUNT);
    }
  });

  it('is idempotent and removes an emptied tabGroups array', () => {
    const p = makeProject('a', 'b', 'c', 'd', 'e');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b', 'e'], 7)];
    normalizeTabGroups(p);
    const once = JSON.stringify(p.tabGroups);
    normalizeTabGroups(p);
    expect(JSON.stringify(p.tabGroups)).toBe(once);
    p.tabGroups = [group('g2', 'Group 2', ['c'])];
    normalizeTabGroups(p);
    expect(p.tabGroups).toBeUndefined();
    normalizeTabGroups(p); // no group array at all: no-op
    expect(p.tabGroups).toBeUndefined();
  });
});

describe('pruneSessionFromTabGroups', () => {
  it('removes the member and dissolves a group that falls below 2', () => {
    const p = makeProject('a', 'b', 'c');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b', 'c'])];
    pruneSessionFromTabGroups(p, 'c');
    expect(p.tabGroups![0].sessionIds).toEqual(['a', 'b']);
    pruneSessionFromTabGroups(p, 'b');
    expect(p.tabGroups).toBeUndefined();
  });

  it('is a no-op for ungrouped ids and group-less projects', () => {
    const p = makeProject('a', 'b');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b'])];
    const before = JSON.stringify(p);
    pruneSessionFromTabGroups(p, 'ghost');
    expect(JSON.stringify(p)).toBe(before);
    delete p.tabGroups;
    expect(() => pruneSessionFromTabGroups(p, 'a')).not.toThrow();
  });
});

describe('renameTabGroupInProject / ungroupInProject', () => {
  it('renames the addressed group only', () => {
    const p = makeProject('a', 'b', 'c', 'd');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b']), group('g2', 'Group 2', ['c', 'd'])];
    expect(renameTabGroupInProject(p, 'g2', 'Backend')).toBe(true);
    expect(p.tabGroups![1].name).toBe('Backend');
    expect(p.tabGroups![0].name).toBe('Group 1');
    expect(renameTabGroupInProject(p, 'ghost', 'x')).toBe(false);
  });

  it('ungroups by id and clears an emptied tabGroups', () => {
    const p = makeProject('a', 'b', 'c', 'd');
    p.tabGroups = [group('g1', 'Group 1', ['a', 'b']), group('g2', 'Group 2', ['c', 'd'])];
    expect(ungroupInProject(p, 'g1')).toBe(true);
    expect(p.tabGroups!.map((g) => g.id)).toEqual(['g2']);
    expect(ungroupInProject(p, 'g1')).toBe(false);
    expect(ungroupInProject(p, 'g2')).toBe(true);
    expect(p.tabGroups).toBeUndefined();
  });
});

describe('auto-name lifecycle across closes', () => {
  it('numbering survives a close + re-group: the surviving name keeps its slot', () => {
    const p = makeProject('a', 'b', 'c', 'd', 'e');
    groupTabsInProject(p, 'a', 'b');
    groupTabsInProject(p, 'c', 'd');
    expect(p.tabGroups!.map((g) => g.name).sort()).toEqual(['Group 1', 'Group 2']);
    // Close a member of the 3-tab future group: prune keeps the 2-tab group.
    pruneSessionFromTabGroups(p, 'd');
    expect(p.tabGroups!.length).toBe(1);
    expect(p.tabGroups![0].name).toBe('Group 1');
    // A fresh pair of ungrouped tabs does not reuse the dissolved group's number.
    groupTabsInProject(p, 'd', 'e');
    expect(p.tabGroups!.find((g) => g.sessionIds.includes('d'))!.name).toBe('Group 2');
  });
});
