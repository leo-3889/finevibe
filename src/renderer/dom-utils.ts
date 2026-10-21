/**
 * Escape a string for safe insertion into innerHTML — text nodes and quoted
 * attribute values alike. The DOM text serializer handles `&<>` but never
 * `"`, and attribute sites interpolate this inside `"…"` (git-panel `title`,
 * active-sessions-panel `data-project-id`/`data-session-id`/`title`,
 * project-terminal `data-shell-id`), so a filename containing `"` closed the
 * attribute and injected markup (P2-102). Serialize quotes explicitly; in a
 * text node `&quot;` still renders as `"`, so no call site changes.
 */
export function esc(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML.replace(/"/g, '&quot;');
}

const AREA_LABELS: Record<string, string> = { staged: 'Staged', working: 'Changes', untracked: 'Untracked', conflicted: 'Conflicted' };

/** Return a user-friendly label for a git area value. */
export function areaLabel(area: string): string {
  return AREA_LABELS[area] || area;
}

/** Return a CSS color for a 0-100 readiness score. */
export function scoreColor(score: number): string {
  if (score >= 70) return '#34a853';
  if (score >= 40) return '#f4b400';
  return '#e94560';
}

/** Create a labeled checkbox row using the `inspect-attach-dims-row` class. */
export function createPlanModeRow(labelText: string = 'Plan mode', checked = true): { row: HTMLLabelElement; checkbox: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = 'inspect-attach-dims-row';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;
  const text = document.createElement('span');
  text.textContent = labelText;
  row.appendChild(checkbox);
  row.appendChild(text);
  return { row, checkbox };
}
