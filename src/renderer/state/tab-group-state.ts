import type { ProjectRecord, SessionRecord, TabGroupRecord } from '../../shared/types.js';
import { defaultGroupName } from './session-naming.js';

/** Size of the auto-assigned group color palette (`--tab-group-1..6`). */
export const TAB_GROUP_COLOR_COUNT = 6;
/** Hard cap on members per tab group. */
export const TAB_GROUP_MAX_MEMBERS = 12;
/** Dwell time over a tab's center zone before the group drop target lights up. */
export const TAB_GROUP_DWELL_MS = 450;

/**
 * True for tabs a group may contain. Mirrors the `renameSession` guard
 * (`state.ts`) and the menu's `renamable` flag (`tab-list.ts`): the pinned
 * project tools (overview / Kanban / team) are never groupable.
 */
export function isGroupableTab(session: Pick<SessionRecord, 'type'>): boolean {
  return session.type !== 'project-tab' && session.type !== 'kanban' && session.type !== 'team';
}

/** The group containing `sessionId`, or null when the tab is ungrouped. */
export function findGroupForSession(project: ProjectRecord, sessionId: string): TabGroupRecord | null {
  return project.tabGroups?.find((g) => g.sessionIds.includes(sessionId)) ?? null;
}

function indexOfSession(project: ProjectRecord, sessionId: string): number {
  return project.sessions.findIndex((s) => s.id === sessionId);
}

/** Comparator keeping member ids in `project.sessions` order (invariant 9). */
function bySessionOrder(project: ProjectRecord) {
  return (a: string, b: string) => indexOfSession(project, a) - indexOfSession(project, b);
}

/** Lowest palette index not in `used`; recycles 0 once the palette is full. */
function lowestFreeColorIn(used: ReadonlySet<number>): number {
  for (let i = 0; i < TAB_GROUP_COLOR_COUNT; i++) {
    if (!used.has(i)) return i;
  }
  // Palette exhausted: >6 groups is cosmetic-only, recycle from the start.
  return 0;
}

function lowestFreeColorIndex(project: ProjectRecord): number {
  return lowestFreeColorIn(new Set((project.tabGroups ?? []).map((g) => g.colorIndex)));
}

/** Lift `movingIds` out of `project.sessions` and splice them back at `anchorId`. */
function relocateBlock(project: ProjectRecord, movingIds: string[], anchorId: string, beforeAnchor: boolean): void {
  const moving = new Set(movingIds);
  const block = project.sessions.filter((s) => moving.has(s.id));
  const rest = project.sessions.filter((s) => !moving.has(s.id));
  const anchorIdx = rest.findIndex((s) => s.id === anchorId);
  rest.splice(beforeAnchor ? anchorIdx : anchorIdx + 1, 0, ...block);
  project.sessions = rest;
}

/** Members of `group` ordered by their position in `project.sessions`. */
function orderedMembers(project: ProjectRecord, group: TabGroupRecord): string[] {
  return [...group.sessionIds].sort(bySessionOrder(project));
}

function sortAllMembers(project: ProjectRecord): void {
  for (const group of project.tabGroups ?? []) {
    group.sessionIds.sort(bySessionOrder(project));
  }
}

/**
 * Commit a center-zone drop: group the dragged tab (and, when it already has
 * a group, its whole group) with the target tab. Mutates `project` in place —
 * both `tabGroups` and, where the invariants demand it, `sessions` order —
 * and returns the id of the new/absorbing group.
 *
 * Returns null for every rejected drop: equal ids, unknown ids, a
 * non-groupable tab on either side, same group, or a target group that would
 * blow past `TAB_GROUP_MAX_MEMBERS`. A null return touches nothing.
 */
export function groupTabsInProject(
  project: ProjectRecord,
  draggedSessionId: string,
  targetSessionId: string,
): string | null {
  if (draggedSessionId === targetSessionId) return null;
  const draggedIndex = indexOfSession(project, draggedSessionId);
  const targetIndex = indexOfSession(project, targetSessionId);
  if (draggedIndex === -1 || targetIndex === -1) return null;
  if (!isGroupableTab(project.sessions[draggedIndex]) || !isGroupableTab(project.sessions[targetIndex])) return null;

  const draggedGroup = findGroupForSession(project, draggedSessionId);
  const targetGroup = findGroupForSession(project, targetSessionId);
  if (draggedGroup && draggedGroup === targetGroup) return null;

  if (!draggedGroup && !targetGroup) {
    // Both ungrouped: the dragged tab lands in the target's slot (the drop
    // was on the target's center), and the pair — contiguous by
    // construction, ordered by sessions index — opens a new group.
    relocateBlock(project, [draggedSessionId], targetSessionId, true);
    const group: TabGroupRecord = {
      id: crypto.randomUUID(),
      name: defaultGroupName(project),
      sessionIds: [draggedSessionId, targetSessionId].sort(bySessionOrder(project)),
      colorIndex: lowestFreeColorIndex(project),
    };
    if (!project.tabGroups) project.tabGroups = [];
    project.tabGroups.push(group);
    return group.id;
  }

  if (draggedGroup && !targetGroup) {
    // Whole group relocates into the target's slot and absorbs it.
    if (draggedGroup.sessionIds.length + 1 > TAB_GROUP_MAX_MEMBERS) return null;
    relocateBlock(project, draggedGroup.sessionIds, targetSessionId, true);
    draggedGroup.sessionIds.push(targetSessionId);
    sortAllMembers(project);
    return draggedGroup.id;
  }

  if (!draggedGroup && targetGroup) {
    // Joins the boundary nearest the drag: a tab left of the run prepends,
    // one right of it appends (the run is contiguous by invariant 4).
    if (targetGroup.sessionIds.length + 1 > TAB_GROUP_MAX_MEMBERS) return null;
    const members = orderedMembers(project, targetGroup);
    const joinsFront = draggedIndex < indexOfSession(project, members[0]);
    relocateBlock(project, [draggedSessionId], members[joinsFront ? 0 : members.length - 1], joinsFront);
    if (joinsFront) targetGroup.sessionIds.unshift(draggedSessionId);
    else targetGroup.sessionIds.push(draggedSessionId);
    sortAllMembers(project);
    return targetGroup.id;
  }

  // Both grouped, different groups: the dragged group merges into the
  // target's, which keeps its id, name and color. The block crosses to the
  // far side of the target run so the merged group stays contiguous.
  const source = draggedGroup!;
  const dest = targetGroup!;
  if (source.sessionIds.length + dest.sessionIds.length > TAB_GROUP_MAX_MEMBERS) return null;
  const destMembers = orderedMembers(project, dest);
  const destStart = indexOfSession(project, destMembers[0]);
  const destEnd = indexOfSession(project, destMembers[destMembers.length - 1]);
  const sourceStart = Math.min(...source.sessionIds.map((id) => indexOfSession(project, id)));
  const sourceEnd = Math.max(...source.sessionIds.map((id) => indexOfSession(project, id)));
  // Touching runs merge in place; a gap makes the block cross to the far
  // side of the target run so the merged group stays contiguous.
  let placeBefore: boolean;
  if (sourceEnd + 1 === destStart) placeBefore = true;
  else if (sourceStart === destEnd + 1) placeBefore = false;
  else placeBefore = sourceStart > destStart;
  relocateBlock(project, source.sessionIds, destMembers[placeBefore ? 0 : destMembers.length - 1], placeBefore);
  dest.sessionIds.push(...source.sessionIds);
  sortAllMembers(project);
  project.tabGroups = project.tabGroups!.filter((g) => g !== source);
  return dest.id;
}

/** Dissolve the group; its tabs stay in place. @returns false when unknown. */
export function ungroupInProject(project: ProjectRecord, groupId: string): boolean {
  const groups = project.tabGroups;
  if (!groups) return false;
  const idx = groups.findIndex((g) => g.id === groupId);
  if (idx === -1) return false;
  groups.splice(idx, 1);
  if (groups.length === 0) delete project.tabGroups;
  return true;
}

/** Apply a manual rename (the mutator truncates; nothing rewrites it later). */
export function renameTabGroupInProject(project: ProjectRecord, groupId: string, name: string): boolean {
  const group = project.tabGroups?.find((g) => g.id === groupId);
  if (!group) return false;
  group.name = name;
  return true;
}

/**
 * Drop `sessionId` from every group (the close funnel calls this beside the
 * splitPanes filter); a group left with fewer than two members dissolves.
 */
export function pruneSessionFromTabGroups(project: ProjectRecord, sessionId: string): void {
  const groups = project.tabGroups;
  if (!groups) return;
  for (const group of groups) {
    group.sessionIds = group.sessionIds.filter((id) => id !== sessionId);
  }
  const survivors = groups.filter((g) => g.sessionIds.length >= 2);
  if (survivors.length > 0) project.tabGroups = survivors;
  else delete project.tabGroups;
}

/**
 * Repair every group invariant after a load/reorder may have broken them
 * (idempotent): drop dead and cross-group-duplicate member ids (the first
 * group claims a duplicated id), split each group into maximal contiguous
 * runs of `project.sessions` — the first run keeps the group's identity,
 * extra runs of ≥2 become fresh auto-named groups, runs of 1 dissolve —
 * dissolve groups below 2 members, and clamp/deduplicate `colorIndex`.
 * Dragging a tab out of a group's middle therefore detaches it and splits
 * the rest, which is the behaviour the drop zones make visible.
 */
export function normalizeTabGroups(project: ProjectRecord): void {
  const groups = project.tabGroups;
  if (!groups || groups.length === 0) {
    delete project.tabGroups;
    return;
  }
  const liveIds = new Set(project.sessions.map((s) => s.id));
  const claimed = new Set<string>();
  const survivors: TabGroupRecord[] = [];
  const extraRuns: string[][] = [];

  for (const group of groups) {
    const members: string[] = [];
    for (const id of group.sessionIds) {
      if (!liveIds.has(id) || claimed.has(id)) continue;
      claimed.add(id);
      members.push(id);
    }
    members.sort(bySessionOrder(project));

    // Split into maximal contiguous runs of project.sessions.
    const runs: string[][] = [];
    let run: string[] = [];
    let prevIndex = -2;
    for (const id of members) {
      const index = indexOfSession(project, id);
      if (run.length > 0 && index !== prevIndex + 1) {
        runs.push(run);
        run = [];
      }
      run.push(id);
      prevIndex = index;
    }
    if (run.length > 0) runs.push(run);

    const bigRuns = runs.filter((r) => r.length >= 2);
    if (bigRuns.length === 0) continue; // group dissolves
    const [first, ...rest] = bigRuns;
    // C4TM-05: a persisted group over TAB_GROUP_MAX_MEMBERS (hand-edit, an
    // older build) made every groupTabsInProject merge fail its +1 cap
    // check. Trim runs to the cap; the tail tabs fall back to ungrouped.
    survivors.push({ ...group, sessionIds: first.slice(0, TAB_GROUP_MAX_MEMBERS) });
    extraRuns.push(...rest.map((run) => run.slice(0, TAB_GROUP_MAX_MEMBERS)));
  }

  if (survivors.length > 0) project.tabGroups = survivors;
  else delete project.tabGroups;
  if (extraRuns.length > 0 && !project.tabGroups) project.tabGroups = [];
  for (const run of extraRuns) {
    project.tabGroups!.push({
      id: crypto.randomUUID(),
      name: defaultGroupName(project),
      sessionIds: run,
      colorIndex: lowestFreeColorIndex(project),
    });
  }
  if (!project.tabGroups) return;

  const usedColors = new Set<number>();
  for (const group of project.tabGroups) {
    const raw = Number.isFinite(group.colorIndex) ? Math.trunc(group.colorIndex) : 0;
    let color = ((raw % TAB_GROUP_COLOR_COUNT) + TAB_GROUP_COLOR_COUNT) % TAB_GROUP_COLOR_COUNT;
    if (usedColors.has(color)) color = lowestFreeColorIn(usedColors);
    usedColors.add(color);
    group.colorIndex = color;
  }
}
