import type { ArchivedSession } from '../../../../shared/types.js';
import { appState } from '../../../state.js';
import { getProviderDisplayName } from '../../../provider-availability.js';
import { formatRelativeDate } from '../../../../shared/text-utils.js';

/**
 * Row 28 (code-cleanup audit): the row skeleton the sessions and
 * favorite-sessions widgets both built line-for-line — name / provider /
 * relative date / cost meta, the resume click, and the disabled state for
 * rows without a CLI session id. The widgets keep their own leading marker
 * (the favorites star) and trailing buttons (bookmark toggle, remove), which
 * is where their semantics genuinely differ.
 */
export function buildSessionRow(
  archived: ArchivedSession,
  projectId: string,
  opts: { leading?: HTMLElement; trailing?: HTMLElement[] },
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'widget-sessions-row widget-sessions-row-recent';
  row.title = archived.cliSessionId ? 'Click to resume' : 'No CLI session id — cannot resume';

  if (opts.leading) row.appendChild(opts.leading);

  const main = document.createElement('div');
  main.className = 'widget-sessions-row-main';

  const name = document.createElement('div');
  name.className = 'widget-sessions-row-name';
  name.textContent = archived.name;
  main.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'widget-sessions-row-meta';

  const provider = document.createElement('span');
  provider.className = 'widget-sessions-provider';
  provider.textContent = getProviderDisplayName(archived.providerId);
  meta.appendChild(provider);

  const when = archived.closedAt ?? archived.createdAt;
  const date = document.createElement('span');
  date.className = 'widget-sessions-date';
  date.textContent = formatRelativeDate(when);
  date.title = new Date(when).toLocaleString();
  meta.appendChild(date);

  if (archived.cost && archived.cost.totalCostUsd > 0) {
    const cost = document.createElement('span');
    cost.className = 'widget-sessions-cost';
    cost.textContent = `$${archived.cost.totalCostUsd.toFixed(2)}`;
    meta.appendChild(cost);
  }

  main.appendChild(meta);
  row.appendChild(main);

  for (const extra of opts.trailing ?? []) row.appendChild(extra);

  if (archived.cliSessionId) {
    row.addEventListener('click', () => {
      void appState.resumeFromHistorySafe(projectId, archived.id);
    });
  } else {
    row.classList.add('disabled');
  }

  return row;
}
