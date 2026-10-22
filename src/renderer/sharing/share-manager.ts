// Orchestrates P2P session sharing — ties together peer-host, peer-guest,
// AppState, and the terminal/remote-terminal panes.

import type { ShareMode } from '../../shared/sharing-types.js';
import { startShare, stopShare, broadcastData, broadcastResize, isSharing, type ShareHandle } from './peer-host.js';
import { joinShare, type JoinHandle, type InitData } from './peer-guest.js';
import { appState } from '../state.js';
import {
  createRemoteTerminalPane,
  writeRemoteData,
  resizeRemoteTerminal,
  showRemoteEndOverlay,
  destroyRemoteTerminal,
} from '../components/remote-terminal-pane.js';

const shareHandles = new Map<string, ShareHandle>();
const guestHandles = new Map<string, JoinHandle>();
const pendingJoinHandles = new Set<JoinHandle>();

// Listeners notified when sharing state changes (start/stop/connect/disconnect)
type ShareChangeListener = () => void;
const shareChangeListeners: ShareChangeListener[] = [];

/**
 * PA-32: push-only arrays had no public unsubscribe (the audit's
 * "latent growth" row). Returning a dispose closure is the pattern
 * `appState.on` already uses; call sites that ignore it keep working.
 */
export function onShareChange(cb: ShareChangeListener): () => void {
  shareChangeListeners.push(cb);
  return () => {
    const i = shareChangeListeners.indexOf(cb);
    if (i !== -1) shareChangeListeners.splice(i, 1);
  };
}

function notifyShareChange(): void {
  // Snapshot: a listener that unsubscribes during notification must not
  // make the splice shift entries past an un-notified neighbour.
  for (const cb of [...shareChangeListeners]) cb();
}

// --- Host side ---

export interface ShareResult {
  offer: string;
  handle: ShareHandle;
}

export async function shareSession(sessionId: string, mode: ShareMode, passphrase: string): Promise<ShareResult> {
  const handle = startShare(sessionId, mode, passphrase);
  shareHandles.set(sessionId, handle);
  notifyShareChange();

  // Attach the lifecycle callbacks BEFORE the await, mirroring the hardened
  // guest path below: getOffer() can reject (createOffer/setLocalDescription
  // failure) and the teardown wiring must already be in place — the offer
  // itself is irrelevant to cleanup.
  handle.onConnected(() => {
    notifyShareChange();
  });

  handle.onDisconnected(() => {
    shareHandles.delete(sessionId);
    notifyShareChange();
  });

  let offer: string;
  try {
    offer = await handle.getOffer();
  } catch (err) {
    // The RTCPeerConnection is live and gathering ICE (STUN probes leak the
    // host's local IP:port until the 10 s timeout); without stopShare the
    // share map entry, badge and PTY feed all persist for a peer that can
    // never connect.
    endShare(sessionId);
    throw err;
  }

  return { offer, handle };
}

export async function acceptShareAnswer(sessionId: string, answer: string): Promise<void> {
  const handle = shareHandles.get(sessionId);
  if (!handle) throw new Error(`No active share for session ${sessionId}`);
  await handle.acceptAnswer(answer);
}

export function endShare(sessionId: string): void {
  stopShare(sessionId);
  shareHandles.delete(sessionId);
  notifyShareChange();
}

export function forwardPtyData(sessionId: string, data: string): void {
  broadcastData(sessionId, data);
}

export function forwardResize(sessionId: string, cols: number, rows: number): void {
  broadcastResize(sessionId, cols, rows);
}

// --- Guest side ---

// C3RP-06: pendingJoinHandles had no join-wide timeout. A host that
// accepts the answer but never sends init (dead mid-handshake, wedged
// renderer) pinned the handle — and its RTCPeerConnection — forever.
const JOIN_INIT_TIMEOUT = 30_000;

export async function joinRemoteSession(projectId: string, offer: string, passphrase: string, onConnected?: () => void, onFailed?: (reason: 'auth-failed' | 'ended', detail?: string) => void): Promise<{ answer: string }> {
  const { handle } = joinShare(offer, passphrase);
  // Register synchronously: getAnswer() can reject (wrong key, malformed
  // SDP), and the RTCPeerConnection joinShare created must stay reachable
  // by disconnect/cleanup on that path — one leaked PC per failed join
  // otherwise, until a renderer reload.
  pendingJoinHandles.add(handle);
  const joinTimeout = setTimeout(() => {
    if (!pendingJoinHandles.has(handle)) return;
    pendingJoinHandles.delete(handle);
    try { handle.disconnect(); } catch { /* peer already torn down */ }
  }, JOIN_INIT_TIMEOUT);
  let answer: string;
  try {
    answer = await handle.getAnswer();
  } catch (err) {
    clearTimeout(joinTimeout);
    pendingJoinHandles.delete(handle);
    try { handle.disconnect(); } catch { /* peer already torn down */ }
    throw err;
  }

  // Set up init handler to create the remote session once the connection is established.
  // This happens asynchronously after the host accepts our answer.
  handle.onInit((initData: InitData) => {
    if (!pendingJoinHandles.has(handle)) return;
    pendingJoinHandles.delete(handle);
    clearTimeout(joinTimeout);

    const localSessionId = crypto.randomUUID();
    guestHandles.set(localSessionId, handle);

    // Create the terminal pane BEFORE adding to state, because addRemoteSession
    // triggers a layout render that needs the pane to already exist.
    createRemoteTerminalPane(localSessionId, initData.mode, initData.cols, initData.rows, (data: string) => {
      handle.sendInput(data);
    });

    if (initData.scrollback) {
      writeRemoteData(localSessionId, initData.scrollback);
    }

    const session = appState.addRemoteSession(projectId, localSessionId, initData.sessionName, initData.mode);
    if (!session) {
      console.error('Failed to create remote session');
      destroyRemoteTerminal(localSessionId);
      guestHandles.delete(localSessionId);
      handle.disconnect();
      return;
    }

    onConnected?.();

    handle.onData((payload: string) => {
      writeRemoteData(localSessionId, payload);
    });

    // S3-02: the resize leg existed end to end (protocol, host sender,
    // guest API, forwardResize) but nothing connected it: the pane stayed
    // frozen at join-time geometry, so host resizes re-wrapped every
    // incoming line and garbled full-screen TUIs for the guest.
    handle.onResize((cols: number, rows: number) => {
      resizeRemoteTerminal(localSessionId, cols, rows);
    });

    const cleanup = () => {
      if (!guestHandles.has(localSessionId)) return;
      showRemoteEndOverlay(localSessionId);
      guestHandles.delete(localSessionId);
    };

    handle.onDisconnected(cleanup);
  });

  handle.onDisconnected(() => {
    pendingJoinHandles.delete(handle);
  });

  // C5R-03: with the answer in the host's hands the dialog waited blind:
  // a rejected answer (auth-result ok:false) and a host `end` mid-wait
  // were swallowed, stranding the dialog on "The session will appear
  // once they connect." Host twin: share-dialog wires onAuthFailed to
  // its status line; here the note goes through the dialog's callback.
  const failJoin = (reason: 'auth-failed' | 'ended', detail?: string) => {
    if (!pendingJoinHandles.delete(handle)) return; // init (or a timeout) won the race
    clearTimeout(joinTimeout);
    try { handle.disconnect(); } catch { /* peer already torn down */ }
    onFailed?.(reason, detail);
  };
  handle.onAuthFailed((detail: string) => failJoin('auth-failed', detail));
  handle.onEnd(() => failJoin('ended'));

  return { answer };
}

export function disconnectRemoteSession(sessionId: string): void {
  const handle = guestHandles.get(sessionId);
  if (handle) {
    handle.disconnect();
    guestHandles.delete(sessionId);
  }
}

export function isRemoteSession(sessionId: string): boolean {
  return guestHandles.has(sessionId);
}

// --- Cleanup ---

export function initShareManager(): void {
  appState.on('session-removed', (data?: unknown) => {
    const d = data as { sessionId?: string } | undefined;
    if (!d?.sessionId) return;
    const sessionId = d.sessionId;

    if (isSharing(sessionId)) {
      endShare(sessionId);
    }

    if (guestHandles.has(sessionId)) {
      disconnectRemoteSession(sessionId);
      destroyRemoteTerminal(sessionId);
    }
  });
}

export function cleanupAllShares(): void {
  for (const [sessionId] of shareHandles) {
    endShare(sessionId);
  }
  for (const [sessionId] of guestHandles) {
    disconnectRemoteSession(sessionId);
  }
  for (const handle of pendingJoinHandles) {
    handle.disconnect();
  }
  pendingJoinHandles.clear();
}

export function _resetForTesting(): void {
  shareHandles.clear();
  guestHandles.clear();
  pendingJoinHandles.clear();
  shareChangeListeners.length = 0;
}
