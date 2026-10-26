// Pure host-scope rendering helpers (per-host providers plan §5 / parent §11,
// Phase 2 T4). DOM-free and side-effect-free so the filter and the chip
// builder are unit-testable without a component harness.

import type { ProjectRecord } from '../shared/types.js';
import { LOCAL_HOST_ID } from '../shared/types.js';
import { isValidHostColor } from '../shared/host-colors.js';
import { esc } from './dom-utils.js';

/**
 * Project-list host filter (parent §11 selection semantics): show only
 * projects recorded for `activeHostId`. Absent/'local' matches the
 * load-normalized local projects, so a local-only state renders identically
 * to pre-Phase-2.
 */
export function projectsForHost(
  projects: readonly ProjectRecord[],
  activeHostId: string | undefined,
): ProjectRecord[] {
  const host = activeHostId ?? LOCAL_HOST_ID;
  return projects.filter((p) => (p.hostId ?? LOCAL_HOST_ID) === host);
}

/**
 * Identity chip (6px square, plan §5): the host color in a style attribute.
 * The color passes the shared `#rrggbb` gate first (plan §7 — the renderer
 * never injects a raw string); hosts without a validated color (Local, drafts
 * predating the palette) render no chip.
 */
export function hostChipHtml(color: string | undefined, title: string): string {
  if (!isValidHostColor(color)) return '';
  return `<span class="host-chip" style="background:${color}" title="${esc(title)}"></span>`;
}
