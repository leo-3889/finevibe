import { stripAnsi } from './ansi';
import type { CostData, CostInfo } from '../shared/types';

export type { CostInfo } from '../shared/types';

type CostChangeCallback = (sessionId: string, cost: CostInfo) => void;

const costs = new Map<string, CostInfo>();
const listeners: CostChangeCallback[] = [];

// Search for dollar cost patterns (fallback)
const COST_RE = /\$(\d+\.\d{2,})/g;

export function setCostData(sessionId: string, rawData: CostData): void {
  const { cost, context_window: ctx, model } = rawData;

  const existing = costs.get(sessionId);
  const info: CostInfo = {
    totalCostUsd: cost.total_cost_usd ?? 0,
    totalInputTokens: ctx.total_input_tokens ?? 0,
    totalOutputTokens: ctx.total_output_tokens ?? 0,
    cacheReadTokens: ctx.current_usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: ctx.current_usage?.cache_creation_input_tokens ?? 0,
    totalDurationMs: cost.total_duration_ms ?? 0,
    totalApiDurationMs: cost.total_api_duration_ms ?? 0,
    model: model ?? existing?.model,
  };

  if (existing && existing.totalCostUsd === info.totalCostUsd
    && existing.totalInputTokens === info.totalInputTokens
    && existing.totalOutputTokens === info.totalOutputTokens
    && existing.totalDurationMs === info.totalDurationMs
    && existing.model === info.model) return;

  costs.set(sessionId, info);
  for (const cb of listeners) cb(sessionId, info);
}

// P5 (R4): the fallback scan used to run a stripAnsi regex over EVERY PTY
// chunk — CPU paid on every paste-echo frame. The structured
// `session:costData` channel is the primary source, so the fallback
// throttles itself: the leading edge scans immediately, then one trailing
// scan of the newest chunk per window, so the final cost of a burst
// still lands while bursts cost ~1 scan instead of one per chunk.
const COST_SCAN_INTERVAL_MS = 1000;
type ScanWindow = { last: number; timer: ReturnType<typeof setTimeout> | null; pending: string | null };
const scanWindows = new Map<string, ScanWindow>();
/** Fallback: parse $X.XX from raw terminal output (older CLI without statusline) */
export function parseCost(sessionId: string, rawData: string): void {
  // Don't overwrite structured data with regex fallback
  if (costs.has(sessionId) && costs.get(sessionId)!.totalInputTokens > 0) return;

  let window = scanWindows.get(sessionId);
  if (!window) {
    window = { last: Number.NEGATIVE_INFINITY, timer: null, pending: null };
    scanWindows.set(sessionId, window);
  }
  const now = Date.now();
  if (now - window.last >= COST_SCAN_INTERVAL_MS) {
    window.last = now;
    scanForCost(sessionId, rawData);
    return;
  }
  window.pending = rawData;
  if (window.timer === null) {
    const w = window;
    w.timer = setTimeout(() => {
      w.timer = null;
      w.last = Date.now();
      const pending = w.pending;
      w.pending = null;
      if (pending !== null) scanForCost(sessionId, pending);
    }, COST_SCAN_INTERVAL_MS - (now - w.last));
  }
}

function scanForCost(sessionId: string, rawData: string): void {
  const clean = stripAnsi(rawData);
  let match: RegExpExecArray | null;
  let lastCost: string | null = null;

  while ((match = COST_RE.exec(clean)) !== null) {
    lastCost = match[0];
  }

  if (lastCost) {
    const usd = parseFloat(lastCost.replace('$', ''));
    const existing = costs.get(sessionId);
    if (!existing || existing.totalCostUsd !== usd) {
      const info: CostInfo = {
        totalCostUsd: usd,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalDurationMs: 0,
        totalApiDurationMs: 0,
      };
      costs.set(sessionId, info);
      for (const cb of listeners) cb(sessionId, info);
    }
  }
}

export function getCost(sessionId: string): CostInfo | null {
  return costs.get(sessionId) ?? null;
}

export function getAggregateCost(): CostInfo {
  const aggregate: CostInfo = {
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalDurationMs: 0,
    totalApiDurationMs: 0,
  };
  for (const info of costs.values()) {
    aggregate.totalCostUsd += info.totalCostUsd;
    aggregate.totalInputTokens += info.totalInputTokens;
    aggregate.totalOutputTokens += info.totalOutputTokens;
    aggregate.cacheReadTokens += info.cacheReadTokens;
    aggregate.cacheCreationTokens += info.cacheCreationTokens;
    aggregate.totalDurationMs += info.totalDurationMs;
    aggregate.totalApiDurationMs += info.totalApiDurationMs;
  }
  return aggregate;
}

export function onChange(callback: CostChangeCallback): () => void {
  listeners.push(callback);
  return () => {
    const idx = listeners.indexOf(callback);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

/** Restore cost from persisted session data (used on startup, silent — no listeners notified) */
export function restoreCost(sessionId: string, cost: CostInfo): void {
  costs.set(sessionId, cost);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'm';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function removeSession(sessionId: string): void {
  costs.delete(sessionId);
  const window = scanWindows.get(sessionId);
  if (window) {
    if (window.timer !== null) clearTimeout(window.timer);
    scanWindows.delete(sessionId);
  }
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  costs.clear();
  listeners.length = 0;
  for (const window of scanWindows.values()) {
    if (window.timer !== null) clearTimeout(window.timer);
  }
  scanWindows.clear();
}
