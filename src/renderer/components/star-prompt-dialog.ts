import { appState } from '../state.js';
import { createModalShell } from './modal-shell.js';
import { pushModal } from './modal-manager.js';
import { ModalCloser } from './modal-close.js';
import { openExternal } from '../open-external.js';

const STAR_THRESHOLD = 10;
// C4S-10: the fork's public repo is leo-3889/finevibe (git remote `fork`),
// same target as the About section's GITHUB_URL.
const REPO_URL = 'https://github.com/leo-3889/finevibe';

const closer = new ModalCloser();

function showStarPromptDialog(): void {
  closer.reset();

  const { overlay, body, actions } = createModalShell({
    id: 'star-prompt-overlay',
    title: 'Enjoying FineVibe?',
  });
  body.innerHTML = '';
  actions.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'star-prompt-container';

  const icon = document.createElement('div');
  icon.className = 'star-prompt-icon';
  icon.textContent = '⭐';
  container.appendChild(icon);

  const message = document.createElement('div');
  message.className = 'star-prompt-message';
  message.textContent =
    "If FineVibe has been useful to you, consider giving it a star on GitHub. It helps others discover the project!";
  container.appendChild(message);

  const innerActions = document.createElement('div');
  innerActions.className = 'star-prompt-actions';

  const starBtn = document.createElement('button');
  starBtn.className = 'btn-primary';
  starBtn.textContent = 'Star on GitHub';
  innerActions.appendChild(starBtn);

  const laterBtn = document.createElement('button');
  laterBtn.className = 'btn-secondary';
  laterBtn.textContent = 'Maybe Later';
  innerActions.appendChild(laterBtn);

  container.appendChild(innerActions);

  const dontAsk = document.createElement('button');
  dontAsk.className = 'star-prompt-dont-ask';
  dontAsk.textContent = "Don't ask again";
  container.appendChild(dontAsk);

  body.appendChild(container);

  overlay.style.display = '';

  const close = () => closer.close(overlay);

  const handleStar = () => {
    void openExternal(REPO_URL);
    appState.dismissStarPrompt();
    close();
  };

  const handleDontAsk = () => {
    appState.dismissStarPrompt();
    close();
  };

  const unregisterEsc = pushModal({ onEscape: close });
  starBtn.addEventListener('click', handleStar);
  laterBtn.addEventListener('click', close);
  dontAsk.addEventListener('click', handleDontAsk);

  closer.setCleanup(() => {
    unregisterEsc();
    starBtn.removeEventListener('click', handleStar);
    laterBtn.removeEventListener('click', close);
    dontAsk.removeEventListener('click', handleDontAsk);
  });
}

export function checkStarPrompt(): void {
  if (appState.starPromptDismissed) return;
  if (appState.appLaunchCount < STAR_THRESHOLD) return;
  showStarPromptDialog();
}
