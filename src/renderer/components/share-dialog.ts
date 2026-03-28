// Share dialog — host-side UI for sharing a session via P2P.

import type { ShareMode } from '../../shared/sharing-types.js';
import { shareSession, acceptShareAnswer, endShare } from '../sharing/share-manager.js';
import { isSharing, isConnected } from '../sharing/peer-host.js';

let activeOverlay: HTMLElement | null = null;
let pendingShareSessionId: string | null = null;

export function showShareDialog(sessionId: string): void {
  closeShareDialog();

  const overlay = document.createElement('div');
  overlay.className = 'share-overlay';
  activeOverlay = overlay;

  const dialog = document.createElement('div');
  dialog.className = 'share-dialog';

  // Title
  const title = document.createElement('h3');
  title.textContent = 'Share Session';
  dialog.appendChild(title);

  // Privacy disclosure
  const notice = document.createElement('div');
  notice.className = 'share-notice';
  notice.textContent = 'Your full terminal scrollback history will be shared with the peer.';
  dialog.appendChild(notice);

  // Step 1: Choose mode
  const modeSection = document.createElement('div');
  modeSection.className = 'share-section';

  const modeLabel = document.createElement('div');
  modeLabel.className = 'share-label';
  modeLabel.textContent = 'Access level';
  modeSection.appendChild(modeLabel);

  const modeGroup = document.createElement('div');
  modeGroup.className = 'share-radio-group';

  const readonlyRadio = createRadio('share-mode', 'readonly', 'Read-only', true);
  const readwriteRadio = createRadio('share-mode', 'readwrite', 'Read-write', false);
  modeGroup.appendChild(readonlyRadio);
  modeGroup.appendChild(readwriteRadio);
  modeSection.appendChild(modeGroup);
  dialog.appendChild(modeSection);

  // Status area
  const statusEl = document.createElement('div');
  statusEl.className = 'share-status';
  dialog.appendChild(statusEl);

  // Step 2: Offer code (hidden initially)
  const offerSection = document.createElement('div');
  offerSection.className = 'share-section hidden';

  const offerLabel = document.createElement('div');
  offerLabel.className = 'share-label';
  offerLabel.textContent = 'Send this code to your peer';
  offerSection.appendChild(offerLabel);

  const offerTextarea = document.createElement('textarea');
  offerTextarea.className = 'share-code';
  offerTextarea.readOnly = true;
  offerTextarea.rows = 3;
  offerSection.appendChild(offerTextarea);

  const copyOfferBtn = document.createElement('button');
  copyOfferBtn.className = 'share-btn share-btn-secondary';
  copyOfferBtn.textContent = 'Copy Code';
  copyOfferBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(offerTextarea.value);
    copyOfferBtn.textContent = 'Copied!';
    setTimeout(() => { copyOfferBtn.textContent = 'Copy Code'; }, 1500);
  });
  offerSection.appendChild(copyOfferBtn);
  dialog.appendChild(offerSection);

  // Step 3: Answer code (hidden initially)
  const answerSection = document.createElement('div');
  answerSection.className = 'share-section hidden';

  const answerLabel = document.createElement('div');
  answerLabel.className = 'share-label';
  answerLabel.textContent = 'Paste your peer\'s response code';
  answerSection.appendChild(answerLabel);

  const answerTextarea = document.createElement('textarea');
  answerTextarea.className = 'share-code';
  answerTextarea.rows = 3;
  answerTextarea.placeholder = 'Paste response code here...';
  answerSection.appendChild(answerTextarea);

  const connectBtn = document.createElement('button');
  connectBtn.className = 'share-btn';
  connectBtn.textContent = 'Connect';
  answerSection.appendChild(connectBtn);
  dialog.appendChild(answerSection);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'share-actions';

  const startBtn = document.createElement('button');
  startBtn.className = 'share-btn';
  startBtn.textContent = 'Start Sharing';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'share-btn share-btn-secondary';
  closeBtn.textContent = 'Cancel';
  closeBtn.addEventListener('click', closeShareDialog);

  actions.appendChild(closeBtn);
  actions.appendChild(startBtn);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Handle Escape
  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeShareDialog();
  };
  overlay.addEventListener('keydown', handleKeydown);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeShareDialog();
  });

  // Start sharing flow
  startBtn.addEventListener('click', async () => {
    const mode: ShareMode = (document.querySelector('input[name="share-mode"]:checked') as HTMLInputElement)?.value as ShareMode || 'readonly';

    startBtn.disabled = true;
    startBtn.textContent = 'Generating code...';
    statusEl.textContent = 'Generating connection code...';

    pendingShareSessionId = sessionId;

    try {
      const { offer, handle } = await shareSession(sessionId, mode);

      offerTextarea.value = offer;
      offerSection.classList.remove('hidden');
      answerSection.classList.remove('hidden');
      modeSection.classList.add('hidden');
      startBtn.classList.add('hidden');
      statusEl.textContent = 'Waiting for peer to connect...';

      handle.onConnected(() => {
        closeShareDialog();
      });

      connectBtn.addEventListener('click', () => {
        const answer = answerTextarea.value.trim();
        if (!answer) return;
        try {
          acceptShareAnswer(sessionId, answer);
          connectBtn.disabled = true;
          connectBtn.textContent = 'Connecting...';
          statusEl.textContent = 'Establishing connection...';
        } catch (err) {
          statusEl.textContent = err instanceof Error ? err.message : 'Invalid response code';
        }
      });
    } catch (err) {
      if (pendingShareSessionId && isSharing(pendingShareSessionId)) {
        endShare(pendingShareSessionId);
      }
      pendingShareSessionId = null;
      statusEl.textContent = `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
      startBtn.disabled = false;
      startBtn.textContent = 'Start Sharing';
    }
  });
}

export function closeShareDialog(): void {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
  if (pendingShareSessionId && isSharing(pendingShareSessionId) && !isConnected(pendingShareSessionId)) {
    endShare(pendingShareSessionId);
  }
  pendingShareSessionId = null;
}

function createRadio(name: string, value: string, labelText: string, checked: boolean): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'share-radio-label';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  input.checked = checked;
  const span = document.createElement('span');
  span.textContent = labelText;
  wrapper.appendChild(input);
  wrapper.appendChild(span);
  return wrapper;
}
