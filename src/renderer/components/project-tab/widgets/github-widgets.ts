import { appState } from '../../../state.js';
import { openExternal } from '../../../open-external.js';
import { esc } from '../../../dom-utils.js';
import { ingestItems, isUnread, makeItemId, markRead, markAllReadInProject } from '../../../github-unread.js';
import { t } from '../../../i18n.js';
import { GITHUB_MAX_PER_PAGE } from '../../../../shared/constants.js';
import type { GithubItem, ProviderId } from '../../../../shared/types.js';
import type { WidgetFactory, WidgetHost, WidgetInstance } from './widget-host.js';
import { DEFAULT_GITHUB_CONFIG, type GithubConfig } from './github-types.js';
import { setPendingPrompt } from '../../terminal-pane.js';
import { showTaskModal } from '../../board/board-task-modal.js';
import { getAvailableProviderMetas } from '../../../provider-availability.js';
import { showContextMenu } from '../../board/board-context-menu.js';

type ListKind = 'prs' | 'issues';

// C4G-02: a window-show younger than this is covered by the interval poll.
const VISIBILITY_REFRESH_MIN_MS = 30_000;
// C4G-04 (C2M-05 shape): gh failures that mean "stop hammering" — rate limits
// and auth. Matches what `gh api` writes to stderr (`gh: ... (HTTP 403)`,
// `rate limit`, `not logged in`, `gh auth login`), not transient listing noise.
const GH_BACKOFF_RE = /rate limit|403|auth|gh: |not logged in/i;
const MAX_POLL_BACKOFF_MS = 30 * 60_000;

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

function makeGithubWidget(kind: ListKind, host: WidgetHost): WidgetInstance {
  const root = document.createElement('div');
  root.className = `widget-github widget-github-${kind}`;

  const toolbar = document.createElement('div');
  toolbar.className = 'widget-github-toolbar';
  root.appendChild(toolbar);

  const repoLabel = document.createElement('span');
  repoLabel.className = 'widget-github-repo';
  toolbar.appendChild(repoLabel);

  const markAllBtn = document.createElement('button');
  markAllBtn.className = 'widget-github-mark-all';
  // C4G-03: `markAllReadInProject` clears the shared per-project set, so this
  // button also marks the sibling widget's list read — the old 'visible items'
  // label promised less than it did.
  markAllBtn.textContent = t('projectTab.github.markAllRead');
  markAllBtn.title = t('projectTab.github.markAllReadTooltip');
  markAllBtn.addEventListener('click', () => {
    markAllReadInProject(host.projectId);
    render();
  });
  toolbar.appendChild(markAllBtn);

  const body = document.createElement('div');
  body.className = 'widget-github-body';
  root.appendChild(body);

  let resolvedRepo: string | null = null;
  let lastConfigRepo: string | undefined = undefined;
  // C3RP-15: negative cache. Without it, a project with no git remote re-spawns
  // github.detectRepo on every poll tick: `resolvedRepo` stays null, so the
  // positive cache above never hits. Cleared alongside the config-repo state.
  let detectAttempted = false;
  let items: GithubItem[] = [];
  let loading = false;
  let lastError: string | null = null;
  let pollHandle: number | null = null;
  let destroyed = false;
  let refreshGeneration = 0;
  // C4G-02: per-widget throttle for the visibilitychange refresh — every widget
  // in every window used to spawn a `gh` run on every window-show.
  let lastRefreshAt = 0;
  // C4G-04: the widget's own poll cadence and the backoff window armed by a
  // gh failure. `nextPollAt` gates the interval tick; success clears it.
  let pollIntervalMs = Math.max(60_000, getConfig().refreshSeconds * 1000);
  let backoffMs = 0;
  let nextPollAt = 0;

  const projectId = host.projectId;

  function getConfig(): GithubConfig {
    return { ...DEFAULT_GITHUB_CONFIG, ...host.getConfig<Partial<GithubConfig>>() };
  }

  async function ensureRepo(): Promise<string | null> {
    const cfg = getConfig();
    const trimmedOverride = cfg.repo?.trim();
    if (trimmedOverride && trimmedOverride.includes('/')) {
      if (resolvedRepo !== trimmedOverride) {
        resolvedRepo = trimmedOverride;
        lastConfigRepo = trimmedOverride;
      }
      return resolvedRepo;
    }
    // Cached auto-detect: only re-detect if the override was cleared since the last detection.
    if (resolvedRepo && lastConfigRepo === undefined) return resolvedRepo;
    if (detectAttempted && lastConfigRepo === undefined) return null;
    const project = appState.projects.find(p => p.id === projectId);
    if (!project) return null;
    const detected = await window.finevibe.github.detectRepo(project.path);
    if (detected) resolvedRepo = `${detected.owner}/${detected.repo}`;
    detectAttempted = true;
    lastConfigRepo = undefined;
    return resolvedRepo;
  }

  function renderRow(item: GithubItem): HTMLElement {
    const repo = resolvedRepo!;
    const id = makeItemId(repo, item.number);
    const unread = isUnread(projectId, id);

    const row = document.createElement('div');
    row.className = 'widget-github-row' + (unread ? ' unread' : '');

    const info = document.createElement('div');
    info.className = 'widget-github-row-info';

    const title = document.createElement('div');
    title.className = 'widget-github-row-title';

    if (unread) {
      const dot = document.createElement('span');
      dot.className = 'widget-github-unread-dot';
      title.appendChild(dot);
    }

    const num = document.createElement('span');
    num.className = 'widget-github-row-num';
    num.textContent = `#${item.number}`;
    title.appendChild(num);

    const link = document.createElement('a');
    link.className = 'widget-github-row-link';
    link.textContent = item.title;
    link.href = item.html_url;
    link.title = item.html_url;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      markRead(projectId, repo, item);
      void openExternal(item.html_url);
      render();
    });
    title.appendChild(link);

    if (kind === 'prs' && item.draft) {
      const draft = document.createElement('span');
      draft.className = 'widget-github-badge widget-github-badge-draft';
      draft.textContent = 'draft';
      title.appendChild(draft);
    }
    if (kind === 'prs' && item.merged_at) {
      const merged = document.createElement('span');
      merged.className = 'widget-github-badge widget-github-badge-merged';
      merged.textContent = 'merged';
      title.appendChild(merged);
    } else if (item.state === 'closed') {
      const closed = document.createElement('span');
      closed.className = 'widget-github-badge widget-github-badge-closed';
      closed.textContent = 'closed';
      title.appendChild(closed);
    }

    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'widget-github-row-meta';
    const author = item.user?.login ?? 'unknown';
    meta.innerHTML = `${esc(author)} · ${esc(timeAgo(item.updated_at))}`;
    info.appendChild(meta);

    row.appendChild(info);

    if (kind === 'issues') {
      row.appendChild(buildIssueActions(projectId, repo, item, render));
    } else if (kind === 'prs') {
      row.appendChild(buildPRActions(projectId, repo, item, render));
    }

    return row;
  }

  function render(): void {
    if (destroyed) return;
    body.innerHTML = '';
    repoLabel.textContent = resolvedRepo ?? 'No repo configured';

    if (lastError) {
      const err = document.createElement('div');
      err.className = 'widget-github-error';
      err.textContent = lastError;
      body.appendChild(err);
      return;
    }

    if (loading && items.length === 0) {
      const l = document.createElement('div');
      l.className = 'widget-github-loading';
      l.textContent = 'Loading…';
      body.appendChild(l);
      return;
    }

    if (!resolvedRepo) {
      const empty = document.createElement('div');
      empty.className = 'widget-github-empty';
      empty.textContent = 'No GitHub remote detected. Open settings to set a repo.';
      body.appendChild(empty);
      return;
    }

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'widget-github-empty';
      empty.textContent = kind === 'prs' ? 'No pull requests.' : 'No issues.';
      body.appendChild(empty);
      return;
    }

    for (const item of items) body.appendChild(renderRow(item));
  }

  // C4G-04: double the widget's cadence per consecutive gh failure, capped, so
  // a rate-limited or logged-out widget stops re-spawning `gh` every tick.
  function armBackoff(errorText: string): void {
    if (!GH_BACKOFF_RE.test(errorText)) return;
    backoffMs = Math.min(backoffMs > 0 ? backoffMs * 2 : pollIntervalMs * 2, MAX_POLL_BACKOFF_MS);
    nextPollAt = Date.now() + backoffMs;
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    lastRefreshAt = Date.now();
    const generation = ++refreshGeneration;
    loading = true;
    lastError = null;
    render();

    const repo = await ensureRepo();
    if (destroyed || generation !== refreshGeneration) return;
    if (!repo) {
      loading = false;
      render();
      return;
    }

    if (!(await window.finevibe.github.isAvailable())) {
      if (destroyed || generation !== refreshGeneration) return;
      lastError = 'gh CLI not installed. Install from cli.github.com and run `gh auth login`.';
      loading = false;
      render();
      return;
    }

    if (destroyed || generation !== refreshGeneration) return;
    const cfg = getConfig();
    const result = kind === 'prs'
      ? await window.finevibe.github.listPRs(repo, cfg.state, cfg.max)
      : await window.finevibe.github.listIssues(repo, cfg.state, cfg.max);
    if (destroyed || generation !== refreshGeneration) return;

    if (!result.ok) {
      lastError = result.error ?? 'Failed to fetch from GitHub.';
      armBackoff(lastError);
      loading = false;
      render();
      return;
    }

    items = result.items ?? [];
    // The listing is the whole truth for this repo when it came back under the
    // cap the CLI asked GitHub for — let the unread store drop stale ids.
    const effectiveMax = Math.min(Math.max(cfg.max, 1), GITHUB_MAX_PER_PAGE);
    ingestItems(projectId, repo, items, items.length < effectiveMax);
    backoffMs = 0;
    nextPollAt = 0;
    loading = false;
    render();
  }

  function startPolling(): void {
    if (destroyed) return;
    stopPolling();
    pollIntervalMs = Math.max(60_000, getConfig().refreshSeconds * 1000);
    pollHandle = window.setInterval(() => {
      if (document.hidden) return;
      // C4G-04: inside an armed window the tick is a no-op, so the effective
      // cadence is the doubled window rounded up to the tick grid.
      if (Date.now() < nextPollAt) return;
      void refresh();
    }, pollIntervalMs);
  }

  function stopPolling(): void {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  const onVisibility = () => {
    if (document.hidden) return;
    // C4G-02: at most one visibility refresh per widget per window.
    if (Date.now() - lastRefreshAt < VISIBILITY_REFRESH_MIN_MS) return;
    void refresh();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const unsubUnread = (() => {
    // Re-render rows when this project's unread set changes (e.g. cross-widget mark-read).
    const off = appState.on('github-unread-changed', (data) => {
      const id = typeof data === 'string' ? data : undefined;
      if (id && id !== projectId) return;
      render();
    });
    return off;
  })();

  // C4G-05: the repo caches lived for the widget's lifetime, so a remote added,
  // changed, or removed after the first detect left the widget on the old repo
  // (or pinned to the C3RP-15 negative cache). `git:changed` is the debounced
  // per-project signal git-status.ts already subscribes to.
  const unwatchGitChanged = window.finevibe.git?.onChanged?.(() => {
    resolvedRepo = null;
    detectAttempted = false;
  });

  void refresh().then(() => startPolling());

  return {
    element: root,
    destroy() {
      destroyed = true;
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
      unsubUnread();
      unwatchGitChanged?.();
    },
    refresh() {
      void refresh();
    },
  };
}

function buildIssueActions(
  projectId: string,
  repo: string,
  item: GithubItem,
  rerender: () => void,
): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'widget-github-row-actions';

  const onAction = (run: () => void) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    markRead(projectId, repo, item);
    run();
    rerender();
  };

  const planProviders = getAvailableProviderMetas().filter(p => p.capabilities.planModeArg);

  const fixGroup = document.createElement('div');
  fixGroup.className = 'widget-github-fix-group';

  const fixBtn = document.createElement('button');
  fixBtn.className = 'btn-primary btn-xs widget-github-fix-main';
  fixBtn.textContent = 'Fix';
  fixBtn.title = `Plan a solution for #${item.number} in a new session`;
  fixBtn.addEventListener('click', onAction(() => startFixSession(projectId, item)));
  fixGroup.appendChild(fixBtn);

  if (planProviders.length > 1) {
    const chevron = document.createElement('button');
    chevron.className = 'btn-primary btn-xs widget-github-fix-dropdown';
    chevron.textContent = '▼';
    chevron.title = 'Plan in another provider';
    chevron.setAttribute('aria-label', 'Plan in another provider');
    chevron.setAttribute('aria-haspopup', 'menu');
    chevron.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = chevron.getBoundingClientRect();
      showContextMenu(
        r.right,
        r.bottom + 4,
        planProviders.map(p => ({
          label: p.displayName,
          action: () => {
            markRead(projectId, repo, item);
            startFixSession(projectId, item, p.id);
            rerender();
          },
        })),
      );
    });
    fixGroup.appendChild(chevron);
  }

  actions.appendChild(fixGroup);

  const kanbanBtn = document.createElement('button');
  kanbanBtn.className = 'btn-primary btn-xs';
  kanbanBtn.textContent = 'Add to Kanban';
  kanbanBtn.title = 'Create a board task from this issue';
  kanbanBtn.addEventListener('click', onAction(() => addIssueToKanban(item)));
  actions.appendChild(kanbanBtn);

  return actions;
}

function startFixSession(projectId: string, item: GithubItem, providerId?: ProviderId): void {
  const session = appState.addPlanSession(projectId, `Issue #${item.number}`, true, providerId);
  if (!session) return;
  setPendingPrompt(session.id, `Plan a solution for this issue #${item.number}: ${item.html_url}`);
}

function buildPRActions(
  projectId: string,
  repo: string,
  item: GithubItem,
  rerender: () => void,
): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'widget-github-row-actions';

  const onAction = (run: () => void) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    markRead(projectId, repo, item);
    run();
    rerender();
  };

  const reviewProviders = getAvailableProviderMetas().filter(p => p.id !== 'gemini');

  const reviewGroup = document.createElement('div');
  reviewGroup.className = 'widget-github-fix-group';

  const reviewBtn = document.createElement('button');
  reviewBtn.className = 'btn-primary btn-xs widget-github-fix-main';
  reviewBtn.textContent = 'Review';
  reviewBtn.title = `Review PR #${item.number} in a new session`;
  reviewBtn.addEventListener('click', onAction(() => startReviewSession(projectId, item)));
  reviewGroup.appendChild(reviewBtn);

  if (reviewProviders.length > 1) {
    const chevron = document.createElement('button');
    chevron.className = 'btn-primary btn-xs widget-github-fix-dropdown';
    chevron.textContent = '▼';
    chevron.title = 'Review in another provider';
    chevron.setAttribute('aria-label', 'Review in another provider');
    chevron.setAttribute('aria-haspopup', 'menu');
    chevron.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = chevron.getBoundingClientRect();
      showContextMenu(
        r.right,
        r.bottom + 4,
        reviewProviders.map(p => ({
          label: p.displayName,
          action: () => {
            markRead(projectId, repo, item);
            startReviewSession(projectId, item, p.id);
            rerender();
          },
        })),
      );
    });
    reviewGroup.appendChild(chevron);
  }

  actions.appendChild(reviewGroup);

  const kanbanBtn = document.createElement('button');
  kanbanBtn.className = 'btn-primary btn-xs';
  kanbanBtn.textContent = 'Add to Kanban';
  kanbanBtn.title = 'Create a board task from this PR';
  kanbanBtn.addEventListener('click', onAction(() => addPRToKanban(item)));
  actions.appendChild(kanbanBtn);

  return actions;
}

function startReviewSession(projectId: string, item: GithubItem, providerId?: ProviderId): void {
  const session = appState.addSession(projectId, `Review #${item.number}`, undefined, providerId);
  if (!session) return;
  setPendingPrompt(session.id, `/review pr #${item.number} ${item.html_url}`);
}

function addIssueToKanban(item: GithubItem): void {
  showTaskModal('create', undefined, undefined, {
    title: item.title,
    prompt: `Plan a solution for this issue #${item.number}: ${item.html_url}`,
    tags: ['github-issues'],
  });
}

function addPRToKanban(item: GithubItem): void {
  showTaskModal('create', undefined, undefined, {
    title: `[Review] ${item.title}`,
    prompt: `/review pr #${item.number} ${item.html_url}`,
    tags: ['github-prs'],
  });
}

export const createGithubPRsWidget: WidgetFactory = (host) => makeGithubWidget('prs', host);
export const createGithubIssuesWidget: WidgetFactory = (host) => makeGithubWidget('issues', host);
