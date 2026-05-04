import { createModalShell, createModalButton } from '../../modal-shell.js';
import { createCustomSelect } from '../../custom-select.js';
import type { OverviewWidget } from '../../../../shared/types.js';
import { GITHUB_MAX_PER_PAGE } from '../../../../shared/constants.js';
import type { GithubConfig } from './github-types.js';

const STATE_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

const REFRESH_OPTIONS = [
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: '900', label: '15 minutes' },
  { value: '1800', label: '30 minutes' },
];

export function showGithubSettings(
  widget: OverviewWidget,
  onSave: (patch: Partial<GithubConfig>) => void,
): void {
  const isPRs = widget.type === 'github-prs';
  const title = isPRs ? 'Recent PRs Settings' : 'Recent Issues Settings';
  const shell = createModalShell({ id: 'github-settings-modal', title });
  shell.body.innerHTML = '';
  shell.actions.innerHTML = '';

  const cfg = (widget.config ?? {}) as Partial<GithubConfig>;
  const current: GithubConfig = {
    repo: cfg.repo ?? '',
    state: cfg.state ?? 'open',
    max: typeof cfg.max === 'number' ? cfg.max : 10,
    refreshSeconds: typeof cfg.refreshSeconds === 'number' ? cfg.refreshSeconds : 300,
  };

  const form = document.createElement('div');
  form.className = 'widget-settings-form';

  // Repo override
  const repoField = document.createElement('div');
  repoField.className = 'widget-settings-field';
  const repoLabel = document.createElement('label');
  repoLabel.textContent = 'Repository (owner/name)';
  repoLabel.htmlFor = 'github-settings-repo';
  repoField.appendChild(repoLabel);

  const repoInput = document.createElement('input');
  repoInput.type = 'text';
  repoInput.id = 'github-settings-repo';
  repoInput.placeholder = 'auto-detect from git remote';
  repoInput.value = current.repo ?? '';
  repoField.appendChild(repoInput);

  const repoHelp = document.createElement('div');
  repoHelp.className = 'widget-settings-help';
  repoHelp.textContent = 'Leave blank to use the project’s git origin.';
  repoField.appendChild(repoHelp);

  form.appendChild(repoField);

  // State
  const stateField = document.createElement('div');
  stateField.className = 'widget-settings-field';
  const stateLabel = document.createElement('label');
  stateLabel.textContent = 'State';
  stateField.appendChild(stateLabel);
  const stateSelect = createCustomSelect(
    `github-settings-state-${widget.id}`,
    STATE_OPTIONS,
    current.state,
  );
  stateField.appendChild(stateSelect.element);
  form.appendChild(stateField);

  // Max
  const maxField = document.createElement('div');
  maxField.className = 'widget-settings-field';
  const maxLabel = document.createElement('label');
  maxLabel.textContent = `Max ${isPRs ? 'PRs' : 'issues'}`;
  maxLabel.htmlFor = 'github-settings-max';
  maxField.appendChild(maxLabel);
  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.id = 'github-settings-max';
  maxInput.min = '1';
  maxInput.max = String(GITHUB_MAX_PER_PAGE);
  maxInput.value = String(current.max);
  maxField.appendChild(maxInput);
  form.appendChild(maxField);

  // Refresh interval
  const refreshField = document.createElement('div');
  refreshField.className = 'widget-settings-field';
  const refreshLabel = document.createElement('label');
  refreshLabel.textContent = 'Auto refresh';
  refreshField.appendChild(refreshLabel);
  const refreshSelect = createCustomSelect(
    `github-settings-refresh-${widget.id}`,
    REFRESH_OPTIONS,
    String(current.refreshSeconds),
  );
  refreshField.appendChild(refreshSelect.element);
  form.appendChild(refreshField);

  shell.body.appendChild(form);

  const cancel = createModalButton('Cancel', false);
  cancel.addEventListener('click', close);
  shell.actions.appendChild(cancel);

  const save = createModalButton('Save', true);
  save.addEventListener('click', () => {
    const repoRaw = repoInput.value.trim();
    const maxRaw = parseInt(maxInput.value, 10);
    const refreshRaw = parseInt(refreshSelect.getValue(), 10);
    const stateRaw = stateSelect.getValue() as GithubConfig['state'];

    const patch: Partial<GithubConfig> = {
      repo: repoRaw || undefined,
      state: stateRaw,
      max: Math.max(1, Math.min(GITHUB_MAX_PER_PAGE, isNaN(maxRaw) ? 10 : maxRaw)),
      refreshSeconds: isNaN(refreshRaw) ? 300 : refreshRaw,
    };
    onSave(patch);
    close();
  });
  shell.actions.appendChild(save);

  shell.overlay.style.display = 'flex';
  document.addEventListener('keydown', onKeydown);
  shell.overlay.addEventListener('click', onOverlayClick);

  function close(): void {
    shell.overlay.style.display = 'none';
    document.removeEventListener('keydown', onKeydown);
    shell.overlay.removeEventListener('click', onOverlayClick);
    stateSelect.destroy();
    refreshSelect.destroy();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function onOverlayClick(e: MouseEvent): void {
    if (e.target === shell.overlay) close();
  }
}
