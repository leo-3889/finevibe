// Join dialog — guest-side UI for joining a shared P2P session.

import { joinRemoteSession } from '../sharing/share-manager.js';
import { appState } from '../state.js';

let activeOverlay: HTMLElement | null = null;

export function showJoinDialog(): void {
  closeJoinDialog();

  const project = appState.activeProject;
  if (!project) return;

  const overlay = document.createElement('div');
  overlay.className = 'share-overlay';
  activeOverlay = overlay;

  const dialog = document.createElement('div');
  dialog.className = 'share-dialog';

  // Title
  const title = document.createElement('h3');
  title.textContent = 'Join Remote Session';
  dialog.appendChild(title);

  // Offer input
  const offerSection = document.createElement('div');
  offerSection.className = 'share-section';

  const offerLabel = document.createElement('div');
  offerLabel.className = 'share-label';
  offerLabel.textContent = 'Paste the host\'s connection code';
  offerSection.appendChild(offerLabel);

  const offerTextarea = document.createElement('textarea');
  offerTextarea.className = 'share-code';
  offerTextarea.rows = 3;
  offerTextarea.placeholder = 'Paste connection code here...';
  offerSection.appendChild(offerTextarea);
  dialog.appendChild(offerSection);

  // Status area
  const statusEl = document.createElement('div');
  statusEl.className = 'share-status';
  dialog.appendChild(statusEl);

  // Answer section (hidden initially)
  const answerSection = document.createElement('div');
  answerSection.className = 'share-section hidden';

  const answerLabel = document.createElement('div');
  answerLabel.className = 'share-label';
  answerLabel.textContent = 'Send this response code back to the host';
  answerSection.appendChild(answerLabel);

  const answerTextarea = document.createElement('textarea');
  answerTextarea.className = 'share-code';
  answerTextarea.readOnly = true;
  answerTextarea.rows = 3;
  answerSection.appendChild(answerTextarea);

  const copyAnswerBtn = document.createElement('button');
  copyAnswerBtn.className = 'share-btn share-btn-secondary';
  copyAnswerBtn.textContent = 'Copy Response';
  copyAnswerBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(answerTextarea.value);
    copyAnswerBtn.textContent = 'Copied!';
    setTimeout(() => { copyAnswerBtn.textContent = 'Copy Response'; }, 1500);
  });
  answerSection.appendChild(copyAnswerBtn);
  dialog.appendChild(answerSection);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'share-actions';

  const joinBtn = document.createElement('button');
  joinBtn.className = 'share-btn';
  joinBtn.textContent = 'Join';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'share-btn share-btn-secondary';
  closeBtn.textContent = 'Cancel';
  closeBtn.addEventListener('click', closeJoinDialog);

  actions.appendChild(closeBtn);
  actions.appendChild(joinBtn);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Handle Escape
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeJoinDialog();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeJoinDialog();
  });

  // Join flow
  joinBtn.addEventListener('click', async () => {
    const offer = offerTextarea.value.trim();
    if (!offer) return;

    joinBtn.disabled = true;
    joinBtn.textContent = 'Connecting...';
    statusEl.textContent = 'Generating response code...';
    offerTextarea.readOnly = true;

    try {
      const { answer } = await joinRemoteSession(project.id, offer);

      answerTextarea.value = answer;
      answerSection.classList.remove('hidden');
      // joinRemoteSession resolves after the data channel init is received,
      // meaning the connection is already established at this point.
      statusEl.textContent = 'Connected! Remote session is now active.';
      statusEl.classList.add('share-status-connected');

      closeBtn.textContent = 'Close';
    } catch (err) {
      statusEl.textContent = `Error: ${err instanceof Error ? err.message : 'Invalid code'}`;
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join';
      offerTextarea.readOnly = false;
    }
  });
}

export function closeJoinDialog(): void {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
}
