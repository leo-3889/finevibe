import type { TeamMember } from '../../../shared/types.js';
import { TEAM_DOMAINS, TEAM_DOMAIN_LABELS, type TeamDomain } from '../../../shared/team-config.js';
import { appState } from '../../state.js';
import { renderMarkdownContent } from '../file-reader.js';
import { fetchPredefinedMembers, isCacheFresh } from './github-fetcher.js';
import { filterMembers, type DomainFilter } from './predefined-filter.js';
import { bindModalDismiss } from '../modal-manager.js';
import { t } from '../../i18n.js';
import { initials } from './initials.js';

interface DialogState {
  overlay: HTMLDivElement;
  list: HTMLDivElement;
  status: HTMLDivElement;
  searchInput: HTMLInputElement;
  footerCount: HTMLDivElement;
  chips: Map<DomainFilter, HTMLButtonElement>;
  allSuggestions: TeamMember[];
  query: string;
  activeDomain: DomainFilter;
  /** UI2-11: set once the dialog is disposed; late timers/IPC must not write into it. */
  disposed: boolean;
}

/** The mounted picker's dispose fn, or null when no picker is open (UI2-11). */
let activeDispose: (() => void) | null = null;

// CI-11: opens share one in-flight fetch — the dedupe `showPredefinedPicker`'s
// fresh-cache check gives completed fetches, applied to the run itself: a picker
// opened (or re-opened after a dispose) while a GitHub fetch is still running
// used to fire a second round-trip and let both responses race into
// `setTeamPredefinedCache`. Every waiter settles on the same promise.
let loadInFlight: Promise<TeamMember[]> | null = null;

function fetchPredefinedShared(): Promise<TeamMember[]> {
  if (loadInFlight) return loadInFlight;
  const pending = fetchPredefinedMembers().finally(() => {
    if (loadInFlight === pending) loadInFlight = null;
  });
  loadInFlight = pending;
  return pending;
}

export async function showPredefinedPicker(): Promise<void> {
  // The overlay is appended fresh on every open, so a double open used to
  // stack two pickers: the first kept the ESC binding, kept its search timer
  // armed against detached DOM, and stayed invisible behind the second.
  if (activeDispose) return;

  const { state, dispose } = buildDialog();
  document.body.appendChild(state.overlay);
  activeDispose = dispose;

  // CI-18: the hand-rolled overlay never took focus, so every keystroke —
  // Enter above all — fell through to the PTY behind the picker and
  // submitted a prompt. Take it on mount: the overlay box (tabindex -1)
  // first, then the search input as the autofocus target.
  state.overlay.focus();
  state.searchInput.focus();

  const cache = appState.team.predefinedCache;
  if (cache && isCacheFresh(cache)) {
    state.allSuggestions = cache.suggestions;
    rerender(state);
  } else {
    await load(state);
  }
}

function buildDialog(): { state: DialogState; dispose: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'team-picker-overlay';
  overlay.tabIndex = -1;
  // CI-18: remember the opener so dispose can hand focus back to it.
  const active = document.activeElement as HTMLElement | null;
  const opener = active && active.isConnected && !overlay.contains(active) ? active : null;

  const dialog = document.createElement('div');
  dialog.className = 'team-picker-dialog';

  const header = document.createElement('div');
  header.className = 'team-picker-header';
  const title = document.createElement('div');
  title.className = 'team-picker-title';
  title.textContent = t('team.picker.title');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'team-picker-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', t('team.picker.closeAriaLabel'));

  header.appendChild(title);
  header.appendChild(closeBtn);

  const status = document.createElement('div');
  status.className = 'team-picker-status';

  const filterRow = document.createElement('div');
  filterRow.className = 'team-picker-filter';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'team-picker-search-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'team-picker-search-icon';
  searchIcon.innerHTML =
    '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4.25"/><line x1="9.25" y1="9.25" x2="12.5" y2="12.5"/></svg>';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'team-picker-search';
  searchInput.placeholder = t('team.picker.searchPlaceholder');
  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(searchInput);

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'team-picker-domain-chips';

  const chips = new Map<DomainFilter, HTMLButtonElement>();
  const filters: DomainFilter[] = ['all', ...TEAM_DOMAINS];
  for (const filter of filters) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'team-picker-chip';
    chip.textContent = filter === 'all' ? t('team.picker.allChip') : TEAM_DOMAIN_LABELS[filter];
    if (filter === 'all') chip.classList.add('active');
    chips.set(filter, chip);
    chipsWrap.appendChild(chip);
  }

  filterRow.appendChild(searchWrap);
  filterRow.appendChild(chipsWrap);

  const list = document.createElement('div');
  list.className = 'team-picker-list';

  const footer = document.createElement('div');
  footer.className = 'team-picker-footer';
  const footerCount = document.createElement('div');
  footerCount.className = 'team-picker-footer-count';
  const doneBtn = document.createElement('button');
  doneBtn.className = 'btn-primary';
  doneBtn.textContent = t('team.picker.doneButton');
  footer.appendChild(footerCount);
  footer.appendChild(doneBtn);

  dialog.appendChild(header);
  dialog.appendChild(status);
  dialog.appendChild(filterRow);
  dialog.appendChild(list);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);

  const state: DialogState = {
    overlay,
    list,
    status,
    searchInput,
    footerCount,
    chips,
    allSuggestions: [],
    query: '',
    activeDomain: 'all',
    disposed: false,
  };
  updateFooterCount(state);

  for (const [filter, chip] of chips) {
    chip.addEventListener('click', () => selectDomain(state, filter));
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.query = searchInput.value.trim().toLowerCase();
      rerender(state);
    }, 150);
  });

  const dispose = (): void => {
    // UI2-11: the debounce timer outlives the dialog otherwise — it fires 150 ms
    // later against detached DOM and keeps the disposed generation alive.
    if (debounceTimer) clearTimeout(debounceTimer);
    state.disposed = true;
    teardownDismiss();
    overlay.remove();
    if (activeDispose === dispose) activeDispose = null;
    // CI-18: give the opener its focus back, never a node removed while open.
    if (opener && opener.isConnected) opener.focus();
  };
  const teardownDismiss = bindModalDismiss({ overlay, onClose: dispose });
  closeBtn.addEventListener('click', dispose);
  doneBtn.addEventListener('click', dispose);

  return { state, dispose };
}

function selectDomain(state: DialogState, filter: DomainFilter): void {
  if (state.activeDomain === filter) return;
  state.activeDomain = filter;
  for (const [key, el] of state.chips) el.classList.toggle('active', key === filter);
  rerender(state);
}

async function load(state: DialogState): Promise<void> {
  state.status.textContent = t('team.picker.loading');
  state.list.innerHTML = '';
  try {
    const suggestions = await fetchPredefinedShared();
    appState.setTeamPredefinedCache(suggestions);
    // CI-11: the success path writes after a dispose too — the shared-cache
    // write above stays valid for the next open, the dead dialog must not
    // be repopulated.
    if (state.disposed) return;
    state.allSuggestions = suggestions;
    rerender(state);
  } catch (err) {
    // CI-11: the fetch outlives the dialog — a dismiss (or a newer picker)
    // during the load leaves no status line to write the error into.
    if (state.disposed) return;
    state.status.textContent = t('team.picker.loadError', { err: err instanceof Error ? err.message : String(err) });
  }
}

function updateFooterCount(state: DialogState): void {
  const count = appState.getTeamMembers().length;
  const projectName = appState.activeProject?.name;
  const noun = count === 1 ? t('team.picker.memberNounSingular') : t('team.picker.memberNounPlural');
  state.footerCount.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = String(count);
  state.footerCount.appendChild(strong);
  state.footerCount.appendChild(
    document.createTextNode(projectName
      ? t('team.picker.footerCountWithProject', { noun, projectName })
      : t('team.picker.footerCountGeneric', { noun })),
  );
}

function rerender(state: DialogState): void {
  if (state.disposed) return; // UI2-11: a late fetch/timer result must not rebuild a closed picker
  state.list.innerHTML = '';
  if (state.allSuggestions.length === 0) {
    state.status.textContent = t('team.picker.empty');
    return;
  }
  state.status.textContent = '';

  const filtered = filterMembers(state.allSuggestions, state.query, state.activeDomain);

  if (filtered.length === 0) {
    state.list.appendChild(buildEmptyState(state));
    return;
  }

  const installed = new Set(appState.getTeamMembers().map((m) => m.id));

  const buckets = new Map<TeamDomain, TeamMember[]>();
  for (const suggestion of filtered) {
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
      cards.appendChild(buildCard(state, member, installed.has(member.id)));
    }
    section.appendChild(cards);

    state.list.appendChild(section);
  }
}

function buildEmptyState(state: DialogState): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'team-picker-empty';

  const msg = document.createElement('div');
  msg.textContent = t('team.picker.noMatches');
  wrap.appendChild(msg);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'team-picker-empty-clear';
  clear.textContent = t('team.picker.clearFilters');
  clear.addEventListener('click', () => {
    state.query = '';
    state.activeDomain = 'all';
    state.searchInput.value = '';
    for (const [key, el] of state.chips) el.classList.toggle('active', key === 'all');
    rerender(state);
  });
  wrap.appendChild(clear);

  return wrap;
}

function buildCard(state: DialogState, member: TeamMember, isInstalled: boolean): HTMLElement {
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
  addBtn.className = 'btn-primary team-picker-card-add';
  applyAddState(addBtn, isInstalled, t('team.picker.addToTeam'), t('team.picker.added'));
  const onAdd = (): void => {
    // C4TM-06: an oversize suggestion prompt is rejected by the state (spawn
    // E2BIG cap) — only mark the card added when the member really landed.
    if (!addMember(member)) return;
    applyAddState(addBtn, true, t('team.picker.addToTeam'), t('team.picker.added'));
    updateFooterCount(state);
  };
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onAdd();
  });
  card.appendChild(addBtn);

  const open = (): void => {
    showMemberDetail(member, onAdd, addBtn.disabled);
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
  overlay.tabIndex = -1;
  // CI-18: the nested detail overlay takes focus exactly like the picker.
  const active = document.activeElement as HTMLElement | null;
  const opener = active && active.isConnected ? active : null;

  const dialog = document.createElement('div');
  dialog.className = 'team-picker-detail-dialog';

  const header = document.createElement('div');
  header.className = 'team-picker-detail-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'team-picker-detail-back';
  backBtn.textContent = '‹';
  backBtn.setAttribute('aria-label', t('team.picker.backAriaLabel'));

  const titleWrap = buildNameRole(member);
  titleWrap.classList.add('team-picker-detail-title');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'team-picker-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', t('team.picker.closeAriaLabel'));

  header.appendChild(backBtn);
  header.appendChild(titleWrap);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'team-picker-detail-body';

  body.appendChild(renderMarkdownContent(member.systemPrompt ?? ''));

  const footer = document.createElement('div');
  footer.className = 'team-picker-detail-footer';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-primary btn-sm team-picker-card-add';
  applyAddState(addBtn, isInstalled, t('team.picker.addToTeam'), t('team.picker.alreadyAdded'));
  addBtn.addEventListener('click', () => {
    onAdd();
    applyAddState(addBtn, true, t('team.picker.addToTeam'), t('team.picker.alreadyAdded'));
  });
  footer.appendChild(addBtn);

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.focus();

  const dispose = (): void => {
    teardownDismiss();
    overlay.remove();
    // CI-18: focus returns to the card the detail was opened from.
    if (opener && opener.isConnected) opener.focus();
  };
  const teardownDismiss = bindModalDismiss({ overlay, onClose: dispose });
  backBtn.addEventListener('click', dispose);
  closeBtn.addEventListener('click', dispose);
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

function addMember(member: TeamMember): TeamMember | undefined {
  return appState.addTeamMember({
    id: member.id,
    name: member.name,
    role: member.role,
    description: member.description,
    systemPrompt: member.systemPrompt,
    source: 'predefined',
    sourceUrl: member.sourceUrl,
    installAsAgent: true,
  });
}

function applyAddState(btn: HTMLButtonElement, isInstalled: boolean, addLabel: string, addedLabel: string): void {
  btn.disabled = isInstalled;
  btn.textContent = isInstalled
    ? t('team.picker.addedGlyph', { label: addedLabel })
    : t('team.picker.addGlyph', { label: addLabel });
}
