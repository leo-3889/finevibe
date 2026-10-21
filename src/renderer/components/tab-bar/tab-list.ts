import { appState, MAX_SESSION_NAME_LENGTH, type ProjectRecord, type SessionRecord } from '../../state.js';
import type { ProviderId, TabGroupRecord } from '../../../shared/types.js';
import { findGroupForSession, isGroupableTab, TAB_GROUP_DWELL_MS } from '../../state/tab-group-state.js';
import { getStatus, STATUS_GLYPH, type SessionStatus } from '../../session-activity.js';
import { isUnread } from '../../session-unread.js';
import { hasUnreadInProject as hasGithubUnread } from '../../github-unread.js';
import { ICON_KANBAN, ICON_TEAM, ICON_OVERVIEW } from '../../icons.js';
import { showShareDialog } from '../share-dialog.js';
import { isSharing } from '../../sharing/peer-host.js';
import { endShare } from '../../sharing/share-manager.js';
import { openInspector, isInspectorOpen, getInspectedSessionId, closeInspector } from '../session-inspector.js';
import { hasMultipleAvailableProviders, getProviderCapabilities, getCachedProviderMetas } from '../../provider-availability.js';
import { buildResumeWithProviderItems } from '../resume-with-provider-menu.js';
import { isCliSession } from '../../session-utils.js';
import { esc } from '../../dom-utils.js';
import {
  closeSessionWithConfirm,
  closeAllSessionsWithConfirm,
  closeOtherSessionsWithConfirm,
  closeSessionsFromRightWithConfirm,
  closeSessionsFromLeftWithConfirm,
} from '../../session-close.js';
import { hideTabContextMenu, setActiveContextMenu, positionMenu } from './menu.js';
import { tabListEl } from './dom.js';
import { scrollDelta, bankScroll, planScroll, commitScroll } from './tab-scroll.js';
import { syncTabArrows } from './tab-arrows.js';
import { t } from '../../i18n.js';

// Center-zone group-drop affordance state (clear+set dwell idiom from
// hover-card.ts): the timer lights the drop target, the drop commits.
let groupDwellTimer: ReturnType<typeof setTimeout> | null = null;
let draggingSessionId: string | null = null;

function clearGroupDwell(): void {
  if (groupDwellTimer !== null) {
    clearTimeout(groupDwellTimer);
    groupDwellTimer = null;
  }
}

// Tab rename and group rename both make the strip mid-edit.
function renameInputOpen(): boolean {
  return !!tabListEl.querySelector('.tab-name input, .tab-group-name input');
}

type DropZone = 'left' | 'center' | 'right';

// Outer thirds keep the reorder zones; the center third is the group zone.
function dropZoneOf(clientX: number, rect: DOMRect): DropZone {
  const third = rect.width / 3;
  if (clientX < rect.left + third) return 'left';
  if (clientX > rect.right - third) return 'right';
  return 'center';
}

// The center zone lights up only for a real group drop: both tabs groupable,
// a live drag of a different tab, and no open rename (plan §6).
function canDropToGroup(project: ProjectRecord, target: SessionRecord): boolean {
  if (!draggingSessionId || draggingSessionId === target.id) return false;
  if (renameInputOpen()) return false;
  const dragged = project.sessions.find((s) => s.id === draggingSessionId);
  return !!dragged && isGroupableTab(dragged) && isGroupableTab(target);
}

function highlightGroupDrop(project: ProjectRecord, tab: HTMLElement, target: SessionRecord): void {
  tab.classList.add('drag-over-group');
  const group = findGroupForSession(project, target.id);
  if (!group) return;
  for (const id of group.sessionIds) {
    if (id === target.id) continue;
    tabListEl.querySelector(`.tab-item[data-session-id="${id}"]`)?.classList.add('drag-over-group');
  }
}

function sweepGroupHighlights(): void {
  tabListEl.querySelectorAll('.drag-over-group').forEach((el) => el.classList.remove('drag-over-group'));
}

function buildTooltip(status: SessionStatus, cliSessionId?: string): string {
  const statusLine = t('tab.tooltip.statusPrefix', { status });
  return cliSessionId ? `${statusLine}\n${t('tab.tooltip.sessionPrefix', { cliSessionId })}` : statusLine;
}

function tabDisplayName(project: ProjectRecord, session: SessionRecord): string {
  return session.type === 'project-tab'
    ? t('tab.title.overview', { name: project.name })
    : session.type === 'kanban'
      ? t('tab.title.kanban', { name: project.name })
      : session.type === 'team'
        ? t('tab.title.team', { name: project.name })
        : session.name;
}

function tabNamePrefix(session: SessionRecord): string {
  switch (session.type) {
    case 'diff-viewer': return '<span class="tab-diff-badge">DIFF</span> ';
    case 'mcp-inspector': return '<span class="tab-mcp-badge">MCP</span> ';
    case 'file-reader': return '<span class="tab-file-badge">FILE</span> ';
    case 'remote-terminal': return '<span class="tab-remote-badge">P2P</span> ';
    case 'browser-tab': return '<span class="tab-browser-badge">WEB</span> ';
    case 'project-tab': return `<span class="tab-project-badge">${ICON_OVERVIEW}</span> `;
    case 'kanban': return `<span class="tab-kanban-badge">${ICON_KANBAN}</span> `;
    case 'team': return `<span class="tab-team-badge">${ICON_TEAM}</span> `;
    default: {
      if (!hasMultipleAvailableProviders()) return '';
      // The prefix lands in tab.innerHTML (line ~375 escapes only the name).
      // providerId comes from persisted state.json, which is user-editable,
      // so only registry-known ids may reach the img attributes.
      const rawId = session.providerId || 'claude';
      const providerId = getCachedProviderMetas().some(m => m.id === rawId) ? rawId : 'claude';
      return `<img class="tab-provider-icon" src="assets/providers/${providerId}.png" alt="${providerId}" onerror="this.style.display='none'"> `;
    }
  }
}

function tabTitle(project: ProjectRecord, session: SessionRecord, status: SessionStatus): string {
  switch (session.type) {
    case 'diff-viewer': return t('tab.tooltip.diff', { name: session.diffFilePath || session.name });
    case 'mcp-inspector': return t('tab.tooltip.mcpInspector');
    case 'file-reader': return t('tab.tooltip.file', { name: session.fileReaderPath || session.name });
    case 'remote-terminal': return t('tab.tooltip.remote', { name: session.remoteHostName || session.name });
    case 'browser-tab': return t('tab.tooltip.browser', { url: session.browserTabUrl || t('tab.tooltip.browserNew') });
    case 'project-tab': return t('tab.tooltip.projectTools');
    case 'kanban': return t('tab.tooltip.kanbanBoard');
    case 'team': return t('tab.tooltip.team');
    default: return buildTooltip(status, session.cliSessionId ?? undefined);
  }
}

function startRename(tab: HTMLElement, project: ProjectRecord, session: SessionRecord): void {
  if (session.type === 'kanban' || session.type === 'project-tab' || session.type === 'team') return;
  const nameSpan = tab.querySelector('.tab-name') as HTMLElement;
  if (nameSpan.querySelector('input')) return;

  const input = document.createElement('input');
  input.maxLength = MAX_SESSION_NAME_LENGTH;
  input.value = session.name;
  nameSpan.textContent = '';
  nameSpan.appendChild(input);
  input.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    input.remove();
    if (newName && newName !== session.name) {
      appState.renameSession(project.id, session.id, newName, true);
    } else {
      render();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      input.remove();
      render();
    }
  });

  input.addEventListener('blur', commit);
}

function createGroupEl(project: ProjectRecord, group: TabGroupRecord): HTMLElement {
  const groupEl = document.createElement('div');
  groupEl.className = `tab-group tab-group-color-${group.colorIndex}`;
  groupEl.dataset.groupId = group.id;
  const label = document.createElement('div');
  label.className = 'tab-group-label';
  label.dataset.groupId = group.id;
  label.title = t('tab.group.tooltip', { name: group.name, count: group.sessionIds.length });
  // The label deliberately contains no .tab-name: that selector is the
  // rename-focus guard at split-layout.ts. The name and tooltip are esc()'d,
  // the same contract as the tab innerHTML in render().
  // pi-lens-ignore: xss-innerhtml
  label.innerHTML = `
    <span class="tab-group-dot" title="${esc(t('tab.group.renameTooltip'))}"></span>
    <span class="tab-group-name">${esc(group.name)}</span>
    <span class="tab-group-count">${group.sessionIds.length}</span>
  `;
  label.addEventListener('dblclick', () => startGroupRename(label, project, group));
  label.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showGroupContextMenu(e.clientX, e.clientY, project, group, label);
  });
  groupEl.appendChild(label);
  return groupEl;
}

// Mirrors startRename: Enter commits, Escape reverts, blur commits, an empty
// input keeps the old name. Membership edits never rename the group, so a
// manual rename survives by construction.
function startGroupRename(labelEl: HTMLElement, project: ProjectRecord, group: TabGroupRecord): void {
  const nameSpan = labelEl.querySelector('.tab-group-name') as HTMLElement | null;
  if (!nameSpan || nameSpan.querySelector('input')) return;

  const input = document.createElement('input');
  input.maxLength = MAX_SESSION_NAME_LENGTH;
  input.value = group.name;
  nameSpan.textContent = '';
  nameSpan.appendChild(input);
  input.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    input.remove();
    if (newName && newName !== group.name) {
      appState.renameTabGroup(project.id, group.id, newName);
    } else {
      render();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      input.remove();
      render();
    }
  });

  input.addEventListener('blur', commit);
}

function showGroupContextMenu(x: number, y: number, project: ProjectRecord, group: TabGroupRecord, labelEl: HTMLElement): void {
  hideTabContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const renameGroupItem = document.createElement('div');
  renameGroupItem.className = 'tab-context-menu-item';
  renameGroupItem.textContent = t('contextMenu.tab.renameGroup');
  renameGroupItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    startGroupRename(labelEl, project, group);
  });

  const separator = document.createElement('div');
  separator.className = 'tab-context-menu-separator';

  const ungroupItem = document.createElement('div');
  ungroupItem.className = 'tab-context-menu-item';
  ungroupItem.textContent = t('contextMenu.tab.ungroup');
  ungroupItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    appState.ungroupTabGroup(project.id, group.id);
  });

  menu.appendChild(renameGroupItem);
  menu.appendChild(separator);
  menu.appendChild(ungroupItem);
  document.body.appendChild(menu);
  setActiveContextMenu(menu);
  positionMenu(menu);
}

function showTabContextMenu(x: number, y: number, project: ProjectRecord, session: SessionRecord, tab: HTMLElement): void {
  hideTabContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const renamable = session.type !== 'kanban' && session.type !== 'project-tab' && session.type !== 'team';
  const renameItem = document.createElement('div');
  renameItem.className = 'tab-context-menu-item' + (renamable ? '' : ' disabled');
  renameItem.textContent = t('contextMenu.tab.rename');
  if (renamable) {
    renameItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      startRename(tab, project, session);
    });
  }

  const closeItem = document.createElement('div');
  closeItem.className = 'tab-context-menu-item';
  closeItem.textContent = t('contextMenu.tab.close');
  closeItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    closeSessionWithConfirm(project.id, session.id);
  });

  const sessionIdx = project.sessions.findIndex((s) => s.id === session.id);
  const totalSessions = project.sessions.length;

  const separator = document.createElement('div');
  separator.className = 'tab-context-menu-separator';

  const closeAllItem = document.createElement('div');
  closeAllItem.className = 'tab-context-menu-item';
  closeAllItem.textContent = t('contextMenu.tab.closeAll');
  closeAllItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    closeAllSessionsWithConfirm(project.id);
  });

  const closeOthersItem = document.createElement('div');
  closeOthersItem.className = 'tab-context-menu-item' + (totalSessions <= 1 ? ' disabled' : '');
  closeOthersItem.textContent = t('contextMenu.tab.closeOthers');
  if (totalSessions > 1) {
    closeOthersItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      closeOtherSessionsWithConfirm(project.id, session.id);
    });
  }

  const closeRightItem = document.createElement('div');
  closeRightItem.className = 'tab-context-menu-item' + (sessionIdx >= totalSessions - 1 ? ' disabled' : '');
  closeRightItem.textContent = t('contextMenu.tab.closeRight');
  if (sessionIdx < totalSessions - 1) {
    closeRightItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      closeSessionsFromRightWithConfirm(project.id, session.id);
    });
  }

  const closeLeftItem = document.createElement('div');
  closeLeftItem.className = 'tab-context-menu-item' + (sessionIdx <= 0 ? ' disabled' : '');
  closeLeftItem.textContent = t('contextMenu.tab.closeLeft');
  if (sessionIdx > 0) {
    closeLeftItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      closeSessionsFromLeftWithConfirm(project.id, session.id);
    });
  }

  const moveLeftItem = document.createElement('div');
  moveLeftItem.className = 'tab-context-menu-item' + (sessionIdx <= 0 ? ' disabled' : '');
  moveLeftItem.textContent = t('contextMenu.tab.moveLeft');
  if (sessionIdx > 0) {
    moveLeftItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      appState.reorderSession(project.id, session.id, sessionIdx - 1);
    });
  }

  const moveRightItem = document.createElement('div');
  moveRightItem.className = 'tab-context-menu-item' + (sessionIdx >= totalSessions - 1 ? ' disabled' : '');
  moveRightItem.textContent = t('contextMenu.tab.moveRight');
  if (sessionIdx < totalSessions - 1) {
    moveRightItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      appState.reorderSession(project.id, session.id, sessionIdx + 1);
    });
  }

  // Share menu items — only for CLI sessions (not special types)
  const isCli = isCliSession(session);
  const isRemote = session.type === 'remote-terminal';
  const providerCapabilities = getProviderCapabilities(session.providerId || 'claude');
  const canInspect = isCli && providerCapabilities?.hookStatus !== false;
  const currentlySharing = isSharing(session.id);

  const shareSeparator = document.createElement('div');
  shareSeparator.className = 'tab-context-menu-separator';

  const shareItem = document.createElement('div');
  shareItem.className = 'tab-context-menu-item' + (!isCli || currentlySharing ? ' disabled' : '');
  shareItem.textContent = t('contextMenu.tab.shareSession');
  if (isCli && !currentlySharing) {
    shareItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      showShareDialog(session.id);
    });
  }

  const stopShareItem = document.createElement('div');
  stopShareItem.className = 'tab-context-menu-item' + (!currentlySharing ? ' disabled' : '');
  stopShareItem.textContent = t('contextMenu.tab.stopSharing');
  if (currentlySharing) {
    stopShareItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      endShare(session.id);
    });
  }

  menu.appendChild(renameItem);
  menu.appendChild(moveLeftItem);
  menu.appendChild(moveRightItem);

  const tabGroup = findGroupForSession(project, session.id);
  if (tabGroup) {
    // Rename group / Ungroup from any member tab, behind a separator.
    const groupSeparator = document.createElement('div');
    groupSeparator.className = 'tab-context-menu-separator';

    const renameGroupItem = document.createElement('div');
    renameGroupItem.className = 'tab-context-menu-item';
    renameGroupItem.textContent = t('contextMenu.tab.renameGroup');
    renameGroupItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      const labelEl = tab.closest('.tab-group')?.querySelector('.tab-group-label') as HTMLElement | null;
      if (labelEl) startGroupRename(labelEl, project, tabGroup);
    });

    const ungroupItem = document.createElement('div');
    ungroupItem.className = 'tab-context-menu-item';
    ungroupItem.textContent = t('contextMenu.tab.ungroup');
    ungroupItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      appState.ungroupTabGroup(project.id, tabGroup.id);
    });

    menu.appendChild(groupSeparator);
    menu.appendChild(renameGroupItem);
    menu.appendChild(ungroupItem);
  }

  if (appState.preferences.debugMode) {
    const sessionSeparator = document.createElement('div');
    sessionSeparator.className = 'tab-context-menu-separator';

    const cliSessionId = session.cliSessionId;
    const hasCliSession = !!cliSessionId;

    const copySessionIdItem = document.createElement('div');
    copySessionIdItem.className = 'tab-context-menu-item' + (!hasCliSession ? ' disabled' : '');
    copySessionIdItem.textContent = t('contextMenu.tab.copyCliSessionId');
    if (hasCliSession) {
      copySessionIdItem.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTabContextMenu();
        navigator.clipboard.writeText(cliSessionId);
      });
    }

    const copyInternalIdItem = document.createElement('div');
    copyInternalIdItem.className = 'tab-context-menu-item';
    copyInternalIdItem.textContent = t('contextMenu.tab.copyInternalId');
    copyInternalIdItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      navigator.clipboard.writeText(session.id);
    });

    menu.appendChild(sessionSeparator);
    menu.appendChild(copyInternalIdItem);
    menu.appendChild(copySessionIdItem);
  }

  // Inspect item — only for CLI sessions
  const inspectItem = document.createElement('div');
  const isCurrentlyInspecting = isInspectorOpen() && getInspectedSessionId() === session.id;
  inspectItem.className = 'tab-context-menu-item' + (!canInspect ? ' disabled' : '');
  inspectItem.textContent = isCurrentlyInspecting ? t('contextMenu.tab.closeInspector') : t('contextMenu.tab.inspect');
  if (canInspect) {
    inspectItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      if (isCurrentlyInspecting) {
        closeInspector();
      } else {
        openInspector(session.id);
      }
    });
  }

  const moveSeparator = document.createElement('div');
  moveSeparator.className = 'tab-context-menu-separator';
  menu.appendChild(moveSeparator);
  if (isCli || isRemote) {
    menu.appendChild(shareSeparator);
    if (!currentlySharing) menu.appendChild(shareItem);
    if (currentlySharing) menu.appendChild(stopShareItem);
  }
  if (canInspect) {
    const inspectSeparator = document.createElement('div');
    inspectSeparator.className = 'tab-context-menu-separator';
    menu.appendChild(inspectSeparator);
    menu.appendChild(inspectItem);
  }

  // Resume with <other provider> — only for CLI sessions
  if (isCli) {
    const items = buildResumeWithProviderItems(
      (session.providerId || 'claude') as ProviderId,
      (targetId) => {
        hideTabContextMenu();
        appState.resumeWithProvider(project.id, { sessionId: session.id }, targetId);
      },
    );
    for (const el of items) menu.appendChild(el);
  }

  menu.appendChild(closeItem);
  menu.appendChild(separator);
  menu.appendChild(closeAllItem);
  menu.appendChild(closeOthersItem);
  menu.appendChild(closeRightItem);
  menu.appendChild(closeLeftItem);
  document.body.appendChild(menu);
  setActiveContextMenu(menu);

  positionMenu(menu);
}

export function render(): void {
  // Read before the wipe below clamps it to 0 — this is the only moment a
  // hand-scroll is observable, including the one left behind on the way out
  // of a project. It runs ahead of the rename early-return, per bankScroll's
  // contract in tab-scroll.ts: a scroll made during an open rename is banked
  // by the render that early-returns, not silently dropped.
  bankScroll(tabListEl.scrollLeft);
  if (renameInputOpen()) return;
  tabListEl.innerHTML = '';
  const project = appState.activeProject;
  if (!project) {
    // Empty strip: the arrows have nothing to scroll.
    syncTabArrows();
    return;
  }

  let activeTab: HTMLElement | null = null;
  // A maximal run of sessions sharing one group id renders inside a single
  // .tab-group wrapper; strip order follows project.sessions (invariant 9).
  let currentGroupEl: HTMLElement | null = null;
  let currentGroupId: string | null = null;
  for (const session of project.sessions) {
    const sessionGroup = findGroupForSession(project, session.id);
    const tab = document.createElement('div');
    const isActive = session.id === project.activeSessionId;
    const isMcp = session.type === 'mcp-inspector';
    const isDiff = session.type === 'diff-viewer';
    const isFileReader = session.type === 'file-reader';
    const isRemoteTab = session.type === 'remote-terminal';
    const isBrowserTab = session.type === 'browser-tab';
    const isProjectTab = session.type === 'project-tab';
    const unread = !isActive && (isProjectTab ? hasGithubUnread(project.id) : isUnread(session.id));
    const isKanban = session.type === 'kanban';
    const isTeam = session.type === 'team';
    const isSpecial = isMcp || isDiff || isFileReader || isRemoteTab || isBrowserTab || isProjectTab || isKanban || isTeam;
    const sharing = isSharing(session.id);
    const displayName = tabDisplayName(project, session);
    tab.className = 'tab-item' + (isActive ? ' active' : '') + (unread ? ' unread' : '') + (sharing ? ' tab-sharing' : '') + (isRemoteTab ? ' tab-remote' : '') + (sessionGroup ? ' in-group' : '');
    tab.dataset.sessionId = session.id;
    tab.dataset.tabName = displayName;
    tab.dataset.cliSessionId = session.cliSessionId ?? '';
    tab.draggable = true;
    const status = getStatus(session.id);
    tab.title = tabTitle(project, session, status);
    const namePrefix = tabNamePrefix(session);
    const shareIndicator = sharing ? `<span class="tab-share-indicator" title="${esc(t('tab.shareIndicatorTooltip'))}"></span>` : '';
    const statusDot = isSpecial ? '' : `<span class="tab-status ${status}" aria-hidden="true">${STATUS_GLYPH[status]}</span>`;
    // pi-lens-ignore: xss-innerhtml
    tab.innerHTML = `
      ${statusDot}
      <span class="tab-name">${namePrefix}${esc(displayName)}</span>
      ${shareIndicator}
      <span class="tab-close" title="${esc(t('tab.closeTooltip'))}">&times;</span>
    `;

    // Click to switch
    tab.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('tab-close')) return;
      if (tab.querySelector('.tab-name input')) return;
      if (session.id !== project.activeSessionId) {
        appState.setActiveSession(project.id, session.id);
      }
    });

    // Middle-click to close
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeSessionWithConfirm(project.id, session.id);
      }
    });

    // Double-click to rename. Same `.tab-close` guard as the click handler
    // above: × has its own close listener, and a double-click on it must not
    // also open the rename input.
    tab.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).classList.contains('tab-close')) return;
      startRename(tab, project, session);
    });

    // Right-click context menu
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabContextMenu(e.clientX, e.clientY, project, session, tab);
    });

    // Close button
    tab.querySelector('.tab-close')!.addEventListener('click', () => {
      closeSessionWithConfirm(project.id, session.id);
    });

    tab.addEventListener('dragstart', (e) => {
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', session.id);
      draggingSessionId = session.id;
      tab.classList.add('dragging');
    });

    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      const rect = tab.getBoundingClientRect();
      const zone = dropZoneOf(e.clientX, rect);
      tab.classList.remove('drag-over-left', 'drag-over-right');
      if (zone === 'center' && canDropToGroup(project, session)) {
        // Dwell is feedback only — render() wipes the strip, so grouping
        // commits on drop, never on timer fire.
        if (groupDwellTimer === null && !tab.classList.contains('drag-over-group')) {
          groupDwellTimer = setTimeout(() => {
            groupDwellTimer = null;
            highlightGroupDrop(project, tab, session);
          }, TAB_GROUP_DWELL_MS);
        }
        return;
      }
      clearGroupDwell();
      tab.classList.remove('drag-over-group');
      if (zone === 'left') {
        tab.classList.add('drag-over-left');
      } else if (zone === 'right') {
        tab.classList.add('drag-over-right');
      }
    });

    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drag-over-left', 'drag-over-right', 'drag-over-group');
      clearGroupDwell();
    });

    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      clearGroupDwell();
      tab.classList.remove('drag-over-left', 'drag-over-right');
      sweepGroupHighlights();
      const draggedId = e.dataTransfer!.getData('text/plain');
      if (!draggedId || draggedId === session.id) return;

      const rect = tab.getBoundingClientRect();
      if (dropZoneOf(e.clientX, rect) === 'center') {
        if (canDropToGroup(project, session)) {
          appState.groupSessions(project.id, draggedId, session.id);
        }
        return;
      }

      let targetIndex = project.sessions.findIndex(s => s.id === session.id);
      if (e.clientX >= rect.left + rect.width / 2) targetIndex++;

      // Adjust for the fact that removing the dragged item shifts indices
      const fromIndex = project.sessions.findIndex(s => s.id === draggedId);
      if (fromIndex < targetIndex) targetIndex--;

      appState.reorderSession(project.id, draggedId, targetIndex);
    });

    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      draggingSessionId = null;
      clearGroupDwell();
      // Clean up all drag indicators
      tabListEl.querySelectorAll('.drag-over-left, .drag-over-right, .drag-over-group').forEach(el => {
        el.classList.remove('drag-over-left', 'drag-over-right', 'drag-over-group');
      });
    });

    if (isActive) activeTab = tab;
    const groupId = sessionGroup?.id ?? null;
    if (groupId !== currentGroupId) {
      currentGroupId = groupId;
      // A non-contiguous re-entry opens a second wrapper; normalizeTabGroups
      // makes that state transient, the render stays tolerant.
      currentGroupEl = sessionGroup ? createGroupEl(project, sessionGroup) : null;
      // The wrapper is a strip child; tabs of the run nest inside it.
      if (currentGroupEl) tabListEl.appendChild(currentGroupEl);
    }
    (currentGroupEl ?? tabListEl).appendChild(tab);
  }

  const plan = planScroll(project.id, project.activeSessionId);
  // The rebuild above reset the scroll offset. Put this project's own offset back,
  // so neither a re-render the user didn't ask for nor a trip through another
  // project moves the strip from where they scrolled it.
  tabListEl.scrollLeft = plan.scrollLeft;
  if (activeTab && plan.autoScroll) {
    // Rects, not offsetLeft: #tab-list is position:static, so offsetLeft is measured
    // from <body> and would carry the sidebar's width into the strip's scroll space.
    const view = tabListEl.getBoundingClientRect();
    const tab = activeTab.getBoundingClientRect();
    tabListEl.scrollLeft += scrollDelta(tab.left - view.left, tab.right - view.right);
  }
  commitScroll(project.id, project.activeSessionId, tabListEl.scrollLeft, plan.autoScroll);
  // Every content change — add, close, reorder, project switch — ends here,
  // so this is the one hook the arrows need for "did the strip just grow?".
  // The rename early-return above is deliberately unhooked: the strip's
  // content is untouched there.
  syncTabArrows();
}

// Surgically update a single tab's status dot + tooltip without a full re-render.
export function updateTabStatus(sessionId: string, status: SessionStatus): void {
  const dot = tabListEl.querySelector(`.tab-item[data-session-id="${sessionId}"] .tab-status`) as HTMLElement | null;
  if (dot) {
    dot.className = `tab-status ${status}`;
    dot.textContent = STATUS_GLYPH[status];
  }
  const tab = tabListEl.querySelector(`.tab-item[data-session-id="${sessionId}"]`) as HTMLElement | null;
  if (tab) {
    const session = appState.activeProject?.sessions.find(s => s.id === sessionId);
    // Special tabs (file/diff/browser/remote/…) carry the rich path/URL
    // tooltip render() gave them via tabTitle; a bare status word would bury
    // it. Same reason the dot write above is guarded — render() omits the
    // .tab-status span for those tabs.
    if (!session || isCliSession(session)) {
      tab.title = buildTooltip(status, session?.cliSessionId ?? undefined);
    }
  }
}
