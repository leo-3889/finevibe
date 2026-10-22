import type { ArchivedSession, SessionRecord, TeamMember } from '../../../shared/types.js';
import { appState } from '../../state.js';
import { closeModal, registerModalCleanup } from '../modal.js';
import { pushModal } from '../modal-manager.js';
import { isCliSession } from '../../session-utils.js';
import { getProviderDisplayName } from '../../provider-availability.js';
import { getLocale, t } from '../../i18n.js';

const overlay = document.getElementById('modal-overlay')!;
const titleEl = document.getElementById('modal-title')!;
const bodyEl = document.getElementById('modal-body')!;
const btnCancel = document.getElementById('modal-cancel') as HTMLButtonElement;
const btnConfirm = document.getElementById('modal-confirm') as HTMLButtonElement;

/** CI-18: focus holder for the static overlay, mirroring `modal.ts`'s opener. */
let opener: HTMLElement | null = null;

interface SessionRow {
  name: string;
  meta: string;
  onClick?: () => void;
}

export function showMemberSessionsModal(member: TeamMember, projectId: string): void {
  const project = appState.projects.find((p) => p.id === projectId);
  if (!project) return;

  const active = project.sessions
    .filter((s) => s.teamMemberId === member.id && isCliSession(s))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // The spawn-time history record mirrors the live tab via liveSessionId and
  // has cliSessionId === null until the CLI reports one; keying only on
  // cliSessionId listed a running member session twice.
  const activeCliIds = new Set(active.map((s) => s.cliSessionId).filter(Boolean));
  const activeLiveIds = new Set(active.map((s) => s.id));
  const archived = (project.sessionHistory ?? [])
    .filter((a) => a.teamMemberId === member.id
      && !(a.cliSessionId && activeCliIds.has(a.cliSessionId))
      && !(a.liveSessionId && activeLiveIds.has(a.liveSessionId)))
    .sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt));

  closeModal();

  titleEl.textContent = t('team.sessions.title', { name: member.name });
  bodyEl.innerHTML = '';

  if (active.length === 0 && archived.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'team-sessions-empty';
    empty.textContent = t('team.sessions.empty', { name: member.name });
    bodyEl.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'team-sessions-list';

    for (const session of active) list.appendChild(buildRow(activeRow(session, projectId)));
    for (const entry of archived) list.appendChild(buildRow(archivedRow(entry, projectId)));

    bodyEl.appendChild(list);
  }

  btnConfirm.style.display = 'none';
  btnCancel.textContent = t('team.sessions.closeButton');
  // CI-18: this static overlay sits over a live terminal and never took focus,
  // so every keystroke fell through to the PTY behind it. Mirror modal.ts:
  // capture the opener, then focus a control once the `hidden` flip lands.
  opener = document.activeElement as HTMLElement | null;
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => btnCancel.focus());

  const handleCancel = () => closeModal();

  const unregisterEsc = pushModal({ onEscape: handleCancel });
  btnCancel.addEventListener('click', handleCancel);
  registerModalCleanup(() => {
    unregisterEsc();
    btnCancel.removeEventListener('click', handleCancel);
    // CI-18: focus returns to the opener; `closeModal()` only restores the
    // opener it captured itself, so this path had to keep its own.
    const restore = opener;
    opener = null;
    if (restore && restore !== document.body && restore.isConnected) {
      requestAnimationFrame(() => restore.focus());
    }
  });
}

function activeRow(session: SessionRecord, projectId: string): SessionRow {
  const provider = getProviderDisplayName(session.providerId ?? 'claude');
  return {
    name: session.name,
    meta: t('team.sessions.openMeta', {
      time: formatRelative(Date.parse(session.createdAt)),
      provider,
    }),
    onClick: () => {
      appState.setActiveSession(projectId, session.id);
      closeModal();
    },
  };
}

function archivedRow(entry: ArchivedSession, projectId: string): SessionRow {
  const canResume = !!entry.cliSessionId;
  const provider = getProviderDisplayName(entry.providerId);
  const parts = [
    entry.state === 'active' ? t('team.sessions.running') : t('team.sessions.closed'),
    formatRelative(Date.parse(entry.closedAt ?? entry.createdAt)),
  ];
  if (!canResume) parts.push(t('team.sessions.cannotResume'));
  parts.push(provider);
  return {
    name: entry.name,
    meta: parts.join(' · '),
    onClick: canResume
      ? () => {
          void appState.resumeFromHistorySafe(projectId, entry.id);
          closeModal();
        }
      : undefined,
  };
}

function buildRow({ name, meta, onClick }: SessionRow): HTMLElement {
  const row = document.createElement('div');
  row.className = 'team-sessions-row';

  const nameEl = document.createElement('div');
  nameEl.className = 'team-sessions-row-name';
  nameEl.textContent = name;
  row.appendChild(nameEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'team-sessions-meta';
  metaEl.textContent = meta;
  row.appendChild(metaEl);

  if (onClick) {
    row.addEventListener('click', onClick);
  } else {
    row.classList.add('team-sessions-row-disabled');
  }

  return row;
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
  ['second', 1000],
];

let rtf: Intl.RelativeTimeFormat | null = null;
let rtfLocale = '';

function relativeFormatter(): Intl.RelativeTimeFormat {
  const locale = getLocale();
  if (!rtf || rtfLocale !== locale) {
    rtfLocale = locale;
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  }
  return rtf;
}

function formatRelative(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return t('team.sessions.unknownTime');
  const diffMs = timestamp - Date.now();
  const absMs = Math.abs(diffMs);
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (absMs >= ms || unit === 'second') {
      return relativeFormatter().format(Math.round(diffMs / ms), unit);
    }
  }
  return relativeFormatter().format(0, 'second');
}
