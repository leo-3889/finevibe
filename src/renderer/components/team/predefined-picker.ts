import type { TeamMember } from '../../../shared/types.js';
import { TEAM_DOMAINS, TEAM_DOMAIN_LABELS, type TeamDomain } from '../../../shared/team-config.js';
import { appState } from '../../state.js';
import { renderMarkdownContent } from '../file-reader.js';
import { fetchPredefinedMembers, isCacheFresh } from './github-fetcher.js';

interface DialogState {
  overlay: HTMLDivElement;
  list: HTMLDivElement;
  status: HTMLDivElement;
}

export async function showPredefinedPicker(): Promise<void> {
  const state = buildDialog();
  document.body.appendChild(state.overlay);

  const cache = appState.team.predefinedCache;
  if (cache && isCacheFresh(cache)) {
    renderSuggestions(state, cache.suggestions);
  } else {
    await load(state);
  }
}

function buildDialog(): DialogState {
  const overlay = document.createElement('div');
  overlay.className = 'team-picker-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'team-picker-dialog';

  const header = document.createElement('div');
  header.className = 'team-picker-header';
  const title = document.createElement('div');
  title.className = 'team-picker-title';
  title.textContent = 'Browse predefined team members';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'team-picker-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');

  header.appendChild(title);
  header.appendChild(closeBtn);

  const status = document.createElement('div');
  status.className = 'team-picker-status';

  const list = document.createElement('div');
  list.className = 'team-picker-list';

  dialog.appendChild(header);
  dialog.appendChild(status);
  dialog.appendChild(list);
  overlay.appendChild(dialog);

  const escListener = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.team-picker-detail-overlay')) return;
    dispose();
  };
  const dispose = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', escListener);
  };
  closeBtn.addEventListener('click', dispose);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dispose(); });
  document.addEventListener('keydown', escListener);

  return { overlay, list, status };
}

async function load(state: DialogState): Promise<void> {
  state.status.textContent = 'Loading suggestions from GitHub…';
  state.list.innerHTML = '';
  try {
    const suggestions = await fetchPredefinedMembers();
    appState.setTeamPredefinedCache(suggestions);
    renderSuggestions(state, suggestions);
  } catch (err) {
    state.status.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderSuggestions(state: DialogState, suggestions: TeamMember[]): void {
  state.list.innerHTML = '';
  if (suggestions.length === 0) {
    state.status.textContent = 'No predefined members found.';
    return;
  }
  state.status.textContent = '';

  const installed = new Set(appState.getTeamMembers().map((m) => m.id));

  const buckets = new Map<TeamDomain, TeamMember[]>();
  for (const suggestion of suggestions) {
    const key = suggestion.domain ?? 'other';
    const bucket = buckets.get(key) ?? [];
    bucket.push(suggestion);
    buckets.set(key, bucket);
  }

  for (const domain of TEAM_DOMAINS) {
    const members = buckets.get(domain);
    if (!members || members.length === 0) continue;

    const section = document.createElement('div');
    section.className = 'team-picker-section';

    const heading = document.createElement('div');
    heading.className = 'team-picker-section-title';
    heading.textContent = TEAM_DOMAIN_LABELS[domain];
    section.appendChild(heading);

    const cards = document.createElement('div');
    cards.className = 'team-picker-section-cards';
    for (const member of members) {
      cards.appendChild(buildCard(member, installed.has(member.id)));
    }
    section.appendChild(cards);

    state.list.appendChild(section);
  }
}

function buildCard(member: TeamMember, isInstalled: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = 'team-picker-card';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');

  const header = document.createElement('div');
  header.className = 'team-card-header';

  const avatar = document.createElement('div');
  avatar.className = 'team-card-avatar';
  avatar.textContent = initials(member.name);

  header.appendChild(avatar);
  header.appendChild(buildNameRole(member));
  card.appendChild(header);

  if (member.description) {
    const desc = document.createElement('div');
    desc.className = 'team-card-description';
    desc.textContent = member.description;
    card.appendChild(desc);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'team-picker-card-add';
  applyAddState(addBtn, isInstalled, 'Add', 'Added');
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addMember(member);
    applyAddState(addBtn, true, 'Add', 'Added');
  });
  card.appendChild(addBtn);

  const open = (): void => {
    showMemberDetail(member, () => {
      addMember(member);
      applyAddState(addBtn, true, 'Add', 'Added');
    }, addBtn.disabled);
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  return card;
}

function showMemberDetail(member: TeamMember, onAdd: () => void, isInstalled: boolean): void {
  const overlay = document.createElement('div');
  overlay.className = 'team-picker-detail-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'team-picker-detail-dialog';

  const header = document.createElement('div');
  header.className = 'team-picker-detail-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'team-picker-detail-back';
  backBtn.textContent = '‹';
  backBtn.setAttribute('aria-label', 'Back');

  const titleWrap = buildNameRole(member);
  titleWrap.classList.add('team-picker-detail-title');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'team-picker-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');

  header.appendChild(backBtn);
  header.appendChild(titleWrap);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'team-picker-detail-body';

  body.appendChild(renderMarkdownContent(member.systemPrompt ?? ''));

  const footer = document.createElement('div');
  footer.className = 'team-picker-detail-footer';

  const addBtn = document.createElement('button');
  addBtn.className = 'team-picker-card-add';
  applyAddState(addBtn, isInstalled, 'Add to team', 'Already added');
  addBtn.addEventListener('click', () => {
    onAdd();
    applyAddState(addBtn, true, 'Add to team', 'Already added');
  });
  footer.appendChild(addBtn);

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const escListener = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') dispose();
  };
  const dispose = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', escListener);
  };
  backBtn.addEventListener('click', dispose);
  closeBtn.addEventListener('click', dispose);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dispose(); });
  document.addEventListener('keydown', escListener);
}

function buildNameRole(member: TeamMember): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'team-card-heading';

  const nameEl = document.createElement('div');
  nameEl.className = 'team-card-name';
  nameEl.textContent = member.name;

  const roleEl = document.createElement('div');
  roleEl.className = 'team-card-role';
  roleEl.textContent = member.role;

  wrap.appendChild(nameEl);
  wrap.appendChild(roleEl);
  return wrap;
}

function addMember(member: TeamMember): void {
  appState.addTeamMember({
    id: member.id,
    name: member.name,
    role: member.role,
    description: member.description,
    systemPrompt: member.systemPrompt,
    source: 'predefined',
    sourceUrl: member.sourceUrl,
  });
}

function applyAddState(btn: HTMLButtonElement, isInstalled: boolean, addLabel: string, addedLabel: string): void {
  btn.disabled = isInstalled;
  btn.textContent = isInstalled ? addedLabel : addLabel;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}
