import { appState } from '../../../state.js';
import { openExternal } from '../../../open-external.js';
import { ingestItems, isUnread, makeItemId, markRead, markAllReadInProject, onChange as onUnreadChange } from '../../../github-unread.js';
import { t } from '../../../i18n.js';
import { GITHUB_MAX_PER_PAGE } from '../../../../shared/constants.js';
import type { CliProviderMeta, GithubItem, ProviderId } from '../../../../shared/types.js';
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

// Row 28 decomposition: the widget's DOM shell. `onMarkAllRead` is a late-bound
// closure — the click handler needs the widget's render(), which does not exist
// yet at shell-construction time.
function createGithubShell(kind: ListKind, onMarkAllRead: () => void): {
  root: HTMLDivElement;
  repoLabel: HTMLSpanElement;
  body: HTMLDivElement;
} {
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
  markAllBtn.addEventListener('click', onMarkAllRead);
  toolbar.appendChild(markAllBtn);

  const body = document.createElement('div');
  body.className = 'widget-github-body';
  root.appendChild(body);

  return { root, repoLabel, body };
}

function makeGithubMessage(className: string, text: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  node.textContent = text;
  return node;
}

// Row 28 decomposition: the repo cache (override, positive cache, C3RP-15
// negative cache) is self-contained state — nothing else reads the intermediates.
function createRepoResolver(projectId: string, getConfig: () => GithubConfig): {
  current(): string | null;
  ensure(): Promise<string | null>;
  reset(): void;
} {
  let resolvedRepo: string | null = null;
  let lastConfigRepo: string | undefined = undefined;
  // C3RP-15: negative cache. Without it, a project with no git remote re-spawns
  // github.detectRepo on every poll tick: `resolvedRepo` stays null, so the
  // positive cache above never hits. Cleared alongside the config-repo state.
  let detectAttempted = false;

  return {
    current: () => resolvedRepo,

    async ensure(): Promise<string | null> {
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
    },

    reset(): void {
      resolvedRepo = null;
      detectAttempted = false;
    },
  };
}

// Row 28 decomposition: the widget's poll cadence — interval handle, the C4G-02
// visibility throttle clock and the C4G-04 gh-failure backoff.
// `getIntervalMs()` is read at construction AND on every start(), exactly as the
// inlined version read `getConfig().refreshSeconds` at both points: the first
// refresh runs before the first start(), so a first-tick gh failure must arm the
// backoff off a cadence that is already initialised.
function createPollCadence(getIntervalMs: () => number): {
  markRefresh(): void;
  recentlyRefreshed(): boolean;
  armBackoff(errorText: string): void;
  clearBackoff(): void;
  start(onTick: () => void): void;
  stop(): void;
} {
  let pollHandle: number | null = null;
  // C4G-02: per-widget throttle for the visibilitychange refresh — every widget
  // in every window used to spawn a `gh` run on every window-show.
  let lastRefreshAt = 0;
  // C4G-04: the widget's own poll cadence and the backoff window armed by a
  // gh failure. `nextPollAt` gates the interval tick; success clears it.
  let pollIntervalMs = getIntervalMs();
  let backoffMs = 0;
  let nextPollAt = 0;

  function stop(): void {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  return {
    markRefresh(): void {
      lastRefreshAt = Date.now();
    },

    recentlyRefreshed(): boolean {
      // C4G-02: at most one visibility refresh per widget per window.
      return Date.now() - lastRefreshAt < VISIBILITY_REFRESH_MIN_MS;
    },

    // C4G-04: double the widget's cadence per consecutive gh failure, capped, so
    // a rate-limited or logged-out widget stops re-spawning `gh` every tick.
    armBackoff(errorText: string): void {
      if (!GH_BACKOFF_RE.test(errorText)) return;
      backoffMs = Math.min(backoffMs > 0 ? backoffMs * 2 : pollIntervalMs * 2, MAX_POLL_BACKOFF_MS);
      nextPollAt = Date.now() + backoffMs;
    },

    clearBackoff(): void {
      backoffMs = 0;
      nextPollAt = 0;
    },

    start(onTick: () => void): void {
      stop();
      pollIntervalMs = getIntervalMs();
      pollHandle = window.setInterval(() => {
        if (document.hidden) return;
        // C4G-04: inside an armed window the tick is a no-op, so the effective
        // cadence is the doubled window rounded up to the tick grid.
        if (Date.now() < nextPollAt) return;
        onTick();
      }, pollIntervalMs);
    },

    stop,
  };
}

// Row 28t: the widget's paint state, hoisted out of makeGithubWidget's closure
// so the paint and the fetch lane can be plain functions. `generation` retires a
// stale response, `destroyed` is the latch every async lane checks before it
// touches the DOM.
type GithubView = {
  items: GithubItem[];
  // Review 24db32b8 #3: the ids THIS listing kind renders. Issues and PRs share
  // the `${repo}#${number}` id space, so the exhaustive prune is scoped to the
  // caller's own ids — otherwise each widget's poll deletes the sibling's.
  ingestedIds: Set<string>;
  loading: boolean;
  lastError: string | null;
  destroyed: boolean;
  generation: number;
};

// The widget's collaborators, read at call time exactly where the inlined
// closures read them (nothing is sampled at construction).
type GithubListDeps = {
  kind: ListKind;
  projectId: string;
  getConfig: () => GithubConfig;
  repo: ReturnType<typeof createRepoResolver>;
  cadence: ReturnType<typeof createPollCadence>;
  paint: () => void;
};

function createGithubViewState(): GithubView {
  return {
    items: [],
    ingestedIds: new Set<string>(),
    loading: false,
    lastError: null,
    destroyed: false,
    generation: 0,
  };
}

// Row 28t: the widget's single paint — a pure function of the view state, the
// repo cache and the shell. Owns the display-priority order: error > first-load
// spinner > no-repo > empty list > rows, and paints nothing once destroyed.
function renderGithubList(
  view: GithubView,
  deps: GithubListDeps,
  body: HTMLDivElement,
  repoLabel: HTMLSpanElement,
): void {
  if (view.destroyed) return;
  body.innerHTML = '';
  repoLabel.textContent = deps.repo.current() ?? 'No repo configured';

  if (view.lastError) {
    body.appendChild(makeGithubMessage('widget-github-error', view.lastError));
    return;
  }

  if (view.loading && view.items.length === 0) {
    body.appendChild(makeGithubMessage('widget-github-loading', 'Loading…'));
    return;
  }

  if (!deps.repo.current()) {
    body.appendChild(makeGithubMessage('widget-github-empty', 'No GitHub remote detected. Open settings to set a repo.'));
    return;
  }

  if (view.items.length === 0) {
    const text = deps.kind === 'prs' ? 'No pull requests.' : 'No issues.';
    body.appendChild(makeGithubMessage('widget-github-empty', text));
    return;
  }

  for (const item of view.items) {
    body.appendChild(buildGithubRow(deps.kind, deps.projectId, deps.repo.current()!, item, deps.paint));
  }
}

// Row 28t: the fetch lane. Owns the generation guard: a response is applied only
// while the widget is alive AND this is the newest request, so an older error can
// never paint over a newer success; every early exit clears `loading` first.
async function refreshGithubList(view: GithubView, deps: GithubListDeps): Promise<void> {
  if (view.destroyed) return;
  deps.cadence.markRefresh();
  const generation = ++view.generation;
  view.loading = true;
  view.lastError = null;
  deps.paint();

  const listedRepo = await deps.repo.ensure();
  if (view.destroyed || generation !== view.generation) return;
  if (!listedRepo) {
    view.loading = false;
    deps.paint();
    return;
  }

  if (!(await window.finevibe.github.isAvailable())) {
    if (view.destroyed || generation !== view.generation) return;
    view.lastError = 'gh CLI not installed. Install from cli.github.com and run `gh auth login`.';
    view.loading = false;
    deps.paint();
    return;
  }

  if (view.destroyed || generation !== view.generation) return;
  const cfg = deps.getConfig();
  const result = deps.kind === 'prs'
    ? await window.finevibe.github.listPRs(listedRepo, cfg.state, cfg.max)
    : await window.finevibe.github.listIssues(listedRepo, cfg.state, cfg.max);
  if (view.destroyed || generation !== view.generation) return;

  if (!result.ok) {
    view.lastError = result.error ?? 'Failed to fetch from GitHub.';
    deps.cadence.armBackoff(view.lastError);
    view.loading = false;
    deps.paint();
    return;
  }

  view.items = result.items ?? [];
  // The listing is the whole truth for this repo when it came back under the
  // cap the CLI asked GitHub for — let the unread store drop stale ids.
  const effectiveMax = Math.min(Math.max(cfg.max, 1), GITHUB_MAX_PER_PAGE);
  const scope = view.ingestedIds;
  view.ingestedIds = new Set(view.items.map((item) => makeItemId(listedRepo, item.number)));
  ingestItems(deps.projectId, listedRepo, view.items, view.items.length < effectiveMax, scope);
  deps.cadence.clearBackoff();
  view.loading = false;
  deps.paint();
}

// Row 28t: the widget's outside world — the throttled visibility refresh, the
// unread-store notify filtered to this project, the git:changed repo-cache
// invalidation, and the first refresh that arms the poll on a LIVE widget.
// Returns the teardown `destroy()` runs.
function attachGithubTriggers(view: GithubView, deps: GithubListDeps): () => void {
  const onVisibility = () => {
    if (document.hidden) return;
    if (deps.cadence.recentlyRefreshed()) return;
    void refreshGithubList(view, deps);
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Todo #44: the dots are the notification count, and this widget used to
  // re-render off appState's 'github-unread-changed' — a persistence side
  // channel that (a) only fires from the two `setGithubItem*Seen` mutators, and
  // (b) fires BEFORE the store clears the set, so a mark-all-read pressed in
  // the sibling widget re-rendered these rows from the not-yet-cleared set and
  // the dots stayed lit. The store is the single source: every mutator
  // (ingest/prune, markRead, markAllRead, project-removed) notifies after the
  // set is settled.
  // store notify carries the project: a sibling project's widget polling is
  // not this widget's business (review 24db32b8 #2). `undefined` = paint.
  const unsubUnread = onUnreadChange((pid) => {
    if (pid && pid !== deps.projectId) return;
    deps.paint();
  });

  // C4G-05: the repo caches lived for the widget's lifetime, so a remote added,
  // changed, or removed after the first detect left the widget on the old repo
  // (or pinned to the C3RP-15 negative cache). `git:changed` is the debounced
  // per-project signal git-status.ts already subscribes to.
  const unwatchGitChanged = window.finevibe.git?.onChanged?.(() => deps.repo.reset());

  void refreshGithubList(view, deps).then(() => {
    if (!view.destroyed) deps.cadence.start(() => void refreshGithubList(view, deps));
  });

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    unsubUnread();
    unwatchGitChanged?.();
  };
}

function makeGithubWidget(kind: ListKind, host: WidgetHost): WidgetInstance {
  const projectId = host.projectId;

  function getConfig(): GithubConfig {
    return { ...DEFAULT_GITHUB_CONFIG, ...host.getConfig<Partial<GithubConfig>>() };
  }

  const view = createGithubViewState();
  const { root, repoLabel, body } = createGithubShell(kind, () => {
    markAllReadInProject(projectId);
    paint();
  });
  const repo = createRepoResolver(projectId, getConfig);
  const cadence = createPollCadence(() => Math.max(60_000, getConfig().refreshSeconds * 1000));

  // Late-bound: the shell's Mark-all-read handler and every row's rerender call
  // this, and both exist before `deps` is wired below.
  function paint(): void {
    renderGithubList(view, deps, body, repoLabel);
  }

  const deps: GithubListDeps = { kind, projectId, getConfig, repo, cadence, paint };
  const detach = attachGithubTriggers(view, deps);

  return {
    element: root,
    destroy() {
      view.destroyed = true;
      cadence.stop();
      detach();
    },
    refresh() {
      void refreshGithubList(view, deps);
    },
  };
}

function buildGithubRow(
  kind: ListKind,
  projectId: string,
  repo: string,
  item: GithubItem,
  rerender: () => void,
): HTMLElement {
  const id = makeItemId(repo, item.number);
  const unread = isUnread(projectId, id);

  const row = document.createElement('div');
  row.className = `widget-github-row${unread ? ' unread' : ''}`;

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
    rerender();
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
  // Todo #44 audit: was `innerHTML` with pre-escaped parts; the row is plain
  // text, so textContent removes the XSS surface entirely.
  meta.textContent = `${author} · ${timeAgo(item.updated_at)}`;
  info.appendChild(meta);

  row.appendChild(info);

  if (kind === 'issues') {
    row.appendChild(buildIssueActions(projectId, repo, item, rerender));
  } else if (kind === 'prs') {
    row.appendChild(buildPRActions(projectId, repo, item, rerender));
  }

  return row;
}

// Row 28 decomposition: the issue and PR action groups are the same shape —
// a primary button plus a provider picker shown only when a second plan/review
// provider exists. The two callers differ by labels, provider filter and action.
function buildActionGroup(opts: {
  label: string;
  title: string;
  menuTitle: string;
  providers: CliProviderMeta[];
  onAction: (run: () => void) => (e: MouseEvent) => void;
  onMain: () => void;
  onProvider: (providerId: ProviderId) => void;
}): HTMLElement {
  const group = document.createElement('div');
  group.className = 'widget-github-fix-group';

  const main = document.createElement('button');
  main.className = 'btn-primary btn-xs widget-github-fix-main';
  main.textContent = opts.label;
  main.title = opts.title;
  main.addEventListener('click', opts.onAction(opts.onMain));
  group.appendChild(main);

  if (opts.providers.length > 1) {
    const chevron = document.createElement('button');
    chevron.className = 'btn-primary btn-xs widget-github-fix-dropdown';
    chevron.textContent = '▼';
    chevron.title = opts.menuTitle;
    chevron.setAttribute('aria-label', opts.menuTitle);
    chevron.setAttribute('aria-haspopup', 'menu');
    chevron.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = chevron.getBoundingClientRect();
      showContextMenu(
        r.right,
        r.bottom + 4,
        opts.providers.map(p => ({ label: p.displayName, action: () => opts.onProvider(p.id) })),
      );
    });
    group.appendChild(chevron);
  }

  return group;
}

function makeMarkReadAction(projectId: string, repo: string, item: GithubItem, rerender: () => void) {
  return (run: () => void) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    markRead(projectId, repo, item);
    run();
    rerender();
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
  const onAction = makeMarkReadAction(projectId, repo, item, rerender);
  const planProviders = getAvailableProviderMetas().filter(p => p.capabilities.planModeArg);

  const fix = (providerId?: ProviderId) => {
    markRead(projectId, repo, item);
    startFixSession(projectId, item, providerId);
    rerender();
  };

  actions.appendChild(buildActionGroup({
    label: 'Fix',
    title: `Plan a solution for #${item.number} in a new session`,
    menuTitle: 'Plan in another provider',
    providers: planProviders,
    onAction,
    onMain: () => startFixSession(projectId, item),
    onProvider: (providerId) => fix(providerId),
  }));

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
  const onAction = makeMarkReadAction(projectId, repo, item, rerender);
  const reviewProviders = getAvailableProviderMetas().filter(p => p.id !== 'gemini');

  const review = (providerId: ProviderId) => {
    markRead(projectId, repo, item);
    startReviewSession(projectId, item, providerId);
    rerender();
  };

  actions.appendChild(buildActionGroup({
    label: 'Review',
    title: `Review PR #${item.number} in a new session`,
    menuTitle: 'Review in another provider',
    providers: reviewProviders,
    onAction,
    onMain: () => startReviewSession(projectId, item),
    onProvider: review,
  }));

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
