// Guest-side WebRTC logic for P2P session sharing.
// Uses native RTCPeerConnection (available in Electron's Chromium).

import type { ShareMode, ShareMessage } from '../../shared/sharing-types.js';
import { ICE_CONFIG, sendMessage, waitForIceGathering } from './webrtc-utils.js';

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
}

interface GuestPeer {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  mode: ShareMode | null;
  connected: boolean;
}

const guestPeers = new Map<string, GuestPeer>();
let guestIdCounter = 0;

export function joinShare(offer: string): { guestId: string; handle: JoinHandle } {
  const guestId = `guest-${++guestIdCounter}`;

  let initCb: ((data: InitData) => void) | null = null;
  let dataCb: ((payload: string) => void) | null = null;
  let resizeCb: ((cols: number, rows: number) => void) | null = null;
  let disconnectedCb: EventCallback | null = null;
  let endCb: EventCallback | null = null;

  const pc = new RTCPeerConnection(ICE_CONFIG);

  const guestPeer: GuestPeer = {
    pc,
    dc: null,
    mode: null,
    connected: false,
  };

  guestPeers.set(guestId, guestPeer);

  pc.ondatachannel = (event: RTCDataChannelEvent) => {
    const dc = event.channel;
    guestPeer.dc = dc;

    dc.onopen = () => {
      guestPeer.connected = true;
    };

    dc.onmessage = (msgEvent: MessageEvent) => {
      let msg: ShareMessage;
      try {
        msg = JSON.parse(msgEvent.data);
      } catch {
        return;
      }

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

    dc.onclose = () => {
      guestPeer.connected = false;
      cleanupGuest(guestId);
      disconnectedCb?.();
    };
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      guestPeer.connected = false;
      cleanupGuest(guestId);
      disconnectedCb?.();
    }
  };

  return {
    guestId,
    handle: {
      async getAnswer(): Promise<string> {
        const desc = JSON.parse(atob(offer)) as RTCSessionDescriptionInit;
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);
        return btoa(JSON.stringify(pc.localDescription));
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
        disconnectedCb = cb;
      },
      onEnd(cb: EventCallback): void {
        endCb = cb;
      },
    },
  };
}

function disconnectGuest(guestId: string): void {
  const guestPeer = guestPeers.get(guestId);
  if (!guestPeer) return;
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
