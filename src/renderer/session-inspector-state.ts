import type { InspectorEvent, ToolUsageStats, ContextDataPoint } from '../shared/types';
import { inspectorState } from './components/session-inspector-state-ui.js';

type ChangeCallback = (sessionId: string) => void;

const MAX_EVENTS = 2000;
const MAX_EVENT_CHARS = 64 * 1024;
const MAX_SESSION_CHARS = 2 * 1024 * 1024;
const eventSizes = new Map<string, number[]>();
const sessionEvents = new Map<string, InspectorEvent[]>();
const listeners: ChangeCallback[] = [];

// Cached cost deltas, invalidated when events change
const costDeltaCache = new Map<string, { length: number; deltas: { index: number; delta: number }[] }>();

// C2R-02: monotonic ingestion id. addEvents() rotates the retention array in
// place at MAX_EVENTS, so an event's array index is not a stable identity —
// the timeline's rotation guard and its expandable-row keys need one that
// survives the shift.
let seqCounter = 0;

/**
 * C2R-04: exact sizing used to run `JSON.stringify(event).length` on every
 * ingested event for the app's whole lifetime, allocating a full
 * serialization the closed inspector never shows. The caps are byte BOUNDS,
 * so while the inspector is closed the size comes from a stringify-free
 * length walk over the same fields (conservative: every string pays quotes
 * plus a key name, every object pays braces); the open inspector keeps the
 * exact serialization its displayed numbers are derived from.
 */
function estimateEventSize(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length + 16;
  if (value === null || value === undefined) return 8;
  if (typeof value === 'number' || typeof value === 'boolean') return 20;
  if (depth >= 3) return 16;
  let size = 8;
  if (Array.isArray(value)) {
    for (const item of value) size += estimateEventSize(item, depth + 1);
  } else {
    for (const [key, item] of Object.entries(value)) size += key.length + estimateEventSize(item, depth + 1);
  }
  return size;
}

export function addEvents(sessionId: string, events: InspectorEvent[]): void {
  const existing = sessionEvents.get(sessionId) ?? [];
  const sizes = eventSizes.get(sessionId) ?? [];
  let total = sizes.reduce((sum, size) => sum + size, 0);
  // C2R-04: exact byte count only for the session the inspector is showing.
  // C3R-01: the gate was global — opening the inspector on one session made
  // every background session pay the full serialization.
  const exact = inspectorState.inspectedSessionId === sessionId;
  for (const event of events) {
    // C2R-02: stamp the rotation-proof identity before the array stores it.
    event.seq ??= ++seqCounter;
    const size = exact ? JSON.stringify(event).length : estimateEventSize(event);
    if (size > MAX_EVENT_CHARS) continue;
    while (existing.length && (existing.length >= MAX_EVENTS || total + size > MAX_SESSION_CHARS)) {
      existing.shift(); total -= sizes.shift()!;
    }
    existing.push(event); sizes.push(size); total += size;
  }
  eventSizes.set(sessionId, sizes);
  sessionEvents.set(sessionId, existing);
  // Invalidate cache when events change
  costDeltaCache.delete(sessionId);
  for (const cb of listeners) cb(sessionId);
}

export function getEvents(sessionId: string): InspectorEvent[] {
  return sessionEvents.get(sessionId) ?? [];
}

export function getToolStats(sessionId: string): ToolUsageStats[] {
  const events = sessionEvents.get(sessionId) ?? [];
  const statsMap = new Map<string, ToolUsageStats>();

  // Cost snapshots live on synthetic status_update events, not on tool events.
  let lastToolStats: ToolUsageStats | null = null;
  let prevCost: number | null = null;

  for (const ev of events) {
    if (ev.type === 'tool_use' || ev.type === 'tool_failure') {
      const name = ev.tool_name ?? 'unknown';
      let stats = statsMap.get(name);
      if (!stats) {
        stats = { tool_name: name, calls: 0, failures: 0, totalCost: 0 };
        statsMap.set(name, stats);
      }
      stats.calls++;
      if (ev.type === 'tool_failure') stats.failures++;
      lastToolStats = stats;
    }

    const snapshot = ev.cost_snapshot;
    if (snapshot && lastToolStats) {
      const delta = prevCost !== null ? snapshot.total_cost_usd - prevCost : snapshot.total_cost_usd;
      lastToolStats.totalCost += delta;
    }
    if (snapshot) prevCost = snapshot.total_cost_usd;
  }

  return Array.from(statsMap.values()).sort((a, b) => b.calls - a.calls);
}

export function getContextHistory(sessionId: string): ContextDataPoint[] {
  const events = sessionEvents.get(sessionId) ?? [];
  const points: ContextDataPoint[] = [];
  for (const ev of events) {
    if (ev.context_snapshot) {
      points.push({
        timestamp: ev.timestamp,
        usedPercentage: ev.context_snapshot.used_percentage,
        totalTokens: ev.context_snapshot.total_tokens,
      });
    }
  }
  return points;
}

/**
 * Compute cost deltas in a single forward pass (O(n)).
 * Results are cached per session and invalidated when new events arrive.
 */
export function getCostDeltas(sessionId: string): { index: number; delta: number }[] {
  const events = sessionEvents.get(sessionId) ?? [];

  // Return cached result if events haven't changed
  const cached = costDeltaCache.get(sessionId);
  if (cached && cached.length === events.length) {
    return cached.deltas;
  }

  const deltas: { index: number; delta: number }[] = [];
  let prevCost: number | null = null;

  for (let i = 0; i < events.length; i++) {
    const snapshot = events[i].cost_snapshot;
    if (snapshot) {
      const delta = prevCost !== null
        ? snapshot.total_cost_usd - prevCost
        : snapshot.total_cost_usd;
      deltas.push({ index: i, delta });
      prevCost = snapshot.total_cost_usd;
    }
  }

  costDeltaCache.set(sessionId, { length: events.length, deltas });
  return deltas;
}

export function onChange(callback: ChangeCallback): void {
  listeners.push(callback);
}

export function clearSession(sessionId: string): void {
  sessionEvents.delete(sessionId);
  eventSizes.delete(sessionId);
  costDeltaCache.delete(sessionId);
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  sessionEvents.clear();
  eventSizes.clear();
  costDeltaCache.clear();
  listeners.length = 0;
  seqCounter = 0;
}
