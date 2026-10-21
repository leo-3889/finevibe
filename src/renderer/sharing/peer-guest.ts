// Guest-side WebRTC logic for P2P session sharing.
// Uses native RTCPeerConnection (available in Electron's Chromium).

import type { ShareMode, ShareMessage } from '../../shared/sharing-types.js';
import { ICE_CONFIG, sendMessage, waitForIceGathering, encodeConnectionCode, decodeConnectionCode } from './webrtc-utils.js';
import { computeChallengeResponse, hexToBytes, validateShareKey } from './share-crypto.js';

export interface InitData {
  scrollback: string;
  mode: ShareMode;
  cols: number;
  rows: number;
  sessionName: string;
}

type EventCallback = () => void;

export interface JoinHandle {
  getAnswer(): Promise<string>;
  sendInput(data: string): void;
  disconnect(): void;
  onInit(cb: (data: InitData) => void): void;
  onData(cb: (payload: string) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  onDisconnected(cb: EventCallback): void;
  onEnd(cb: EventCallback): void;
  onAuthFailed(cb: (reason: string) => void): void;
}

interface GuestPeer {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  mode: ShareMode | null;
  connected: boolean;
  authenticated: boolean;
  authTimeout: ReturnType<typeof setTimeout> | null;
}

const guestPeers = new Map<string, GuestPeer>();
let guestIdCounter = 0;

// Host parity (peer-host.ts AUTH_TIMEOUT): a join whose handshake stalls
// after the data channel opens — auth-challenge/auth-result never arrive
// because the host abandoned it — has no ICE `disconnected` to reclaim it,
// so an abandoned join would keep a live RTCPeerConnection and a
// pendingJoinHandles entry until app quit.
const AUTH_TIMEOUT = 10_000;

export function joinShare(offer: string, passphrase: string): { guestId: string; handle: JoinHandle } {
  const keyError = validateShareKey(passphrase);
  if (keyError) throw new Error(keyError);
  const guestId = `guest-${++guestIdCounter}`;

  let initCb: ((data: InitData) => void) | null = null;
  let dataCb: ((payload: string) => void) | null = null;
  let resizeCb: ((cols: number, rows: number) => void) | null = null;
  const disconnectedCbs: EventCallback[] = [];
  let endCb: EventCallback | null = null;
  let authFailedCb: ((reason: string) => void) | null = null;
  let disconnectFired = false;

  const pc = new RTCPeerConnection(ICE_CONFIG);

  const guestPeer: GuestPeer = {
    pc,
    dc: null,
    mode: null,
    connected: false,
    authenticated: false,
    authTimeout: null,
  };

  guestPeers.set(guestId, guestPeer);

  pc.ondatachannel = (event: RTCDataChannelEvent) => {
    const dc = event.channel;
    guestPeer.dc = dc;

    dc.onopen = () => {
      guestPeer.connected = true;
      // Handshake deadline: the channel opened, so the host accepted our
      // answer — if no valid auth-result ever arrives the join is abandoned;
      // tear it down (closes the RTCPeerConnection and fires disconnectedCbs,
      // which reclaims the share-manager pendingJoinHandles entry).
      guestPeer.authTimeout = setTimeout(() => {
        guestPeer.authTimeout = null;
        if (!guestPeer.authenticated) {
          authFailedCb?.('Authentication timed out');
          handleDisconnect();
        }
      }, AUTH_TIMEOUT);
    };

    dc.onmessage = (msgEvent: MessageEvent) => {
      let msg: ShareMessage;
      try {
        msg = JSON.parse(msgEvent.data);
      } catch {
        return;
      }

      // Auth handshake messages
      if (msg.type === 'auth-challenge') {
        const challengeBytes = hexToBytes(msg.challenge);
        computeChallengeResponse(challengeBytes, passphrase).then((response) => {
          sendMessage(dc, { type: 'auth-response', response });
        });
        return;
      }

      if (msg.type === 'auth-result') {
        if (guestPeer.authTimeout) {
          clearTimeout(guestPeer.authTimeout);
          guestPeer.authTimeout = null;
        }
        if (msg.ok) {
          guestPeer.authenticated = true;
        } else {
          authFailedCb?.(msg.reason ?? 'Authentication failed');
          disconnectGuest(guestId);
        }
        return;
      }

      // Ignore non-auth messages until authenticated
      if (!guestPeer.authenticated) return;

      switch (msg.type) {
        case 'init':
          guestPeer.mode = msg.mode;
          initCb?.({
            scrollback: msg.scrollback,
            mode: msg.mode,
            cols: msg.cols,
            rows: msg.rows,
            sessionName: msg.sessionName,
          });
          break;
        case 'data':
          dataCb?.(msg.payload);
          break;
        case 'resize':
          resizeCb?.(msg.cols, msg.rows);
          break;
        case 'end':
          endCb?.();
          disconnectGuest(guestId);
          break;
        case 'ping':
          sendMessage(dc, { type: 'pong' });
          break;
      }
    };

    dc.onclose = handleDisconnect;
  };

  const handleDisconnect = () => {
    if (disconnectFired) return;
    disconnectFired = true;
    guestPeer.connected = false;
    // Peer-loss paths (dc.onclose, ICE disconnected/failed) must close the
    // natives, not just drop the map entry: an open RTCPeerConnection keeps
    // sending ICE connectivity checks toward the departed host (leaking local
    // IP:port to the peer we just left) and stays unreclaimable until reload.
    // disconnectGuest is idempotent — the dc.onclose fan-out from its own
    // dc.close() re-enters as a no-op (guest already removed from the map).
    disconnectGuest(guestId);
    for (const cb of disconnectedCbs) cb();
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      handleDisconnect();
    }
  };

  return {
    guestId,
    handle: {
      async getAnswer(): Promise<string> {
        const desc = await decodeConnectionCode(offer, 'offer', passphrase);
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);
        return encodeConnectionCode(pc.localDescription, passphrase);
      },
      sendInput(data: string): void {
        if (guestPeer.mode !== 'readwrite' || !guestPeer.connected || !guestPeer.dc) return;
        sendMessage(guestPeer.dc, { type: 'input', payload: data });
      },
      disconnect(): void {
        disconnectGuest(guestId);
      },
      onInit(cb: (data: InitData) => void): void {
        initCb = cb;
      },
      onData(cb: (payload: string) => void): void {
        dataCb = cb;
      },
      onResize(cb: (cols: number, rows: number) => void): void {
        resizeCb = cb;
      },
      onDisconnected(cb: EventCallback): void {
        disconnectedCbs.push(cb);
      },
      onEnd(cb: EventCallback): void {
        endCb = cb;
      },
      onAuthFailed(cb: (reason: string) => void): void {
        authFailedCb = cb;
      },
    },
  };
}

function disconnectGuest(guestId: string): void {
  const guestPeer = guestPeers.get(guestId);
  if (!guestPeer) return;
  if (guestPeer.authTimeout) {
    clearTimeout(guestPeer.authTimeout);
    guestPeer.authTimeout = null;
  }
  if (guestPeer.dc) guestPeer.dc.close();
  guestPeer.pc.close();
  cleanupGuest(guestId);
}

function cleanupGuest(guestId: string): void {
  guestPeers.delete(guestId);
}

export function _resetForTesting(): void {
  for (const [guestId] of guestPeers) {
    disconnectGuest(guestId);
  }
  guestPeers.clear();
  guestIdCounter = 0;
}
