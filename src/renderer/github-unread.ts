import { appState } from './state.js';
import type { GithubItem } from '../shared/types.js';

type ChangeCallback = () => void;

/** Map<projectId, Set<itemId>> of items currently unread for that project. */
const unreadByProject = new Map<string, Set<string>>();
const listeners: ChangeCallback[] = [];

function notify(): void {
  for (const cb of listeners) cb();
}

export function makeItemId(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/**
 * Compare a fetched GitHub item against the project's lastSeen timestamps and
 * mark it unread if it has been updated since (or never seen). Pass a list of
 * items belonging to a single repo. Returns true if the unread set changed.
 */
export function ingestItems(projectId: string, repo: string, items: GithubItem[]): boolean {
  const set = unreadByProject.get(projectId) ?? new Set<string>();
  const before = set.size;
  let added = 0;

  for (const item of items) {
    const id = makeItemId(repo, item.number);
    const seenAt = appState.getGithubLastSeen(projectId, id);
    const updatedAt = item.updated_at;
    if (!seenAt || seenAt < updatedAt) {
      if (!set.has(id)) {
        set.add(id);
        added++;
      }
    }
  }

  if (added > 0 || set.size !== before) {
    unreadByProject.set(projectId, set);
    notify();
    return true;
  }
  return false;
}

export function isUnread(projectId: string, itemId: string): boolean {
  return unreadByProject.get(projectId)?.has(itemId) ?? false;
}

export function hasUnreadInProject(projectId: string): boolean {
  const set = unreadByProject.get(projectId);
  return !!set && set.size > 0;
}

export function unreadCountInProject(projectId: string): number {
  return unreadByProject.get(projectId)?.size ?? 0;
}

export function markRead(projectId: string, repo: string, item: GithubItem): void {
  const id = makeItemId(repo, item.number);
  appState.setGithubItemSeen(projectId, id, item.updated_at);
  const set = unreadByProject.get(projectId);
  if (set?.delete(id)) {
    notify();
  }
}

export function markAllReadInProject(projectId: string): void {
  const set = unreadByProject.get(projectId);
  if (!set || set.size === 0) return;
  // We don't have item.updated_at handy here, so write `now` — anything older
  // than the next refresh's updated_at will not re-flag.
  const now = new Date().toISOString();
  const entries: Record<string, string> = {};
  for (const id of set) entries[id] = now;
  appState.setGithubItemsSeenBulk(projectId, entries);
  set.clear();
  notify();
}

export function onChange(cb: ChangeCallback): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i !== -1) listeners.splice(i, 1);
  };
}

export function init(): void {
  appState.on('project-removed', (data) => {
    const projectId = typeof data === 'string' ? data : undefined;
    if (projectId && unreadByProject.delete(projectId)) notify();
  });
}

/** @internal Test-only */
export function _resetForTesting(): void {
  unreadByProject.clear();
  listeners.length = 0;
}
