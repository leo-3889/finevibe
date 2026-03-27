// Host-side WebRTC logic for P2P session sharing.
// Uses native RTCPeerConnection (available in Electron's Chromium).

import type { ShareMode, ShareMessage } from '../../shared/sharing-types.js';
import { getTerminalInstance } from '../components/terminal-pane.js';
import { SerializeAddon } from '@xterm/addon-serialize';
import { ICE_CONFIG, sendMessage, waitForIceGathering } from './webrtc-utils.js';

interface HostPeer {
  sessionId: string;
  mode: ShareMode;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  connected: boolean;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  missedPongs: number;
  serializeAddon: SerializeAddon;
}

const hostPeers = new Map<string, HostPeer>();

const KEEPALIVE_INTERVAL = 30_000;
const MAX_MISSED_PONGS = 3;
const CHUNK_SIZE = 64 * 1024;

type EventCallback = () => void;

export interface ShareHandle {
  getOffer(): Promise<string>;
  acceptAnswer(answer: string): void;
  stop(): void;
  onConnected(cb: EventCallback): void;
  onDisconnected(cb: EventCallback): void;
}

export function startShare(sessionId: string, mode: ShareMode): ShareHandle {
  stopShare(sessionId);

  const instance = getTerminalInstance(sessionId);
  if (!instance) throw new Error(`No terminal instance for session ${sessionId}`);

  const serializeAddon = new SerializeAddon();
  instance.terminal.loadAddon(serializeAddon);

  let connectedCb: EventCallback | null = null;
  let disconnectedCb: EventCallback | null = null;

  const pc = new RTCPeerConnection(ICE_CONFIG);
  const dc = pc.createDataChannel('terminal', { ordered: true });

  const hostPeer: HostPeer = {
    sessionId,
    mode,
    pc,
    dc,
    connected: false,
    keepaliveTimer: null,
    missedPongs: 0,
    serializeAddon,
  };

  hostPeers.set(sessionId, hostPeer);

  dc.onopen = () => {
    hostPeer.connected = true;

    const scrollback = serializeAddon.serialize();
    const { cols, rows } = instance.terminal;
    const sessionName = instance.sessionId;

    const initMsg: ShareMessage = {
      type: 'init',
      scrollback: '',
      mode,
      cols,
      rows,
      sessionName,
    };

    if (scrollback.length > CHUNK_SIZE) {
      sendMessage(dc, initMsg);
      for (let i = 0; i < scrollback.length; i += CHUNK_SIZE) {
        sendMessage(dc, { type: 'data', payload: scrollback.slice(i, i + CHUNK_SIZE) });
      }
    } else {
      initMsg.scrollback = scrollback;
      sendMessage(dc, initMsg);
    }

    hostPeer.keepaliveTimer = setInterval(() => {
      if (!hostPeer.connected) return;
      hostPeer.missedPongs++;
      if (hostPeer.missedPongs > MAX_MISSED_PONGS) {
        stopShare(sessionId);
        return;
      }
      sendMessage(dc, { type: 'ping' });
    }, KEEPALIVE_INTERVAL);

    connectedCb?.();
  };

  dc.onmessage = (event: MessageEvent) => {
    let msg: ShareMessage;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'input' && mode === 'readwrite') {
      window.vibeyard.pty.write(sessionId, msg.payload);
    } else if (msg.type === 'pong') {
      hostPeer.missedPongs = 0;
    }
  };

  dc.onclose = () => {
    hostPeer.connected = false;
    cleanup(sessionId);
    disconnectedCb?.();
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      hostPeer.connected = false;
      cleanup(sessionId);
      disconnectedCb?.();
    }
  };

  return {
    async getOffer(): Promise<string> {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      return btoa(JSON.stringify(pc.localDescription));
    },
    acceptAnswer(answer: string): void {
      const desc = JSON.parse(atob(answer)) as RTCSessionDescriptionInit;
      pc.setRemoteDescription(new RTCSessionDescription(desc));
    },
    stop(): void {
      stopShare(sessionId);
    },
    onConnected(cb: EventCallback): void {
      connectedCb = cb;
    },
    onDisconnected(cb: EventCallback): void {
      disconnectedCb = cb;
    },
  };
}

export function stopShare(sessionId: string): void {
  const hostPeer = hostPeers.get(sessionId);
  if (!hostPeer) return;

  if (hostPeer.connected) {
    try { sendMessage(hostPeer.dc, { type: 'end' }); } catch { /* ignore */ }
  }
  cleanup(sessionId);
  hostPeer.dc.close();
  hostPeer.pc.close();
}

export function broadcastData(sessionId: string, data: string): void {
  const hostPeer = hostPeers.get(sessionId);
  if (!hostPeer?.connected) return;
  sendMessage(hostPeer.dc, { type: 'data', payload: data });
}

export function broadcastResize(sessionId: string, cols: number, rows: number): void {
  const hostPeer = hostPeers.get(sessionId);
  if (!hostPeer?.connected) return;
  sendMessage(hostPeer.dc, { type: 'resize', cols, rows });
}

export function isSharing(sessionId: string): boolean {
  return hostPeers.has(sessionId);
}

export function isConnected(sessionId: string): boolean {
  return hostPeers.get(sessionId)?.connected ?? false;
}

export function getShareMode(sessionId: string): ShareMode | null {
  return hostPeers.get(sessionId)?.mode ?? null;
}

function cleanup(sessionId: string): void {
  const hostPeer = hostPeers.get(sessionId);
  if (!hostPeer) return;
  if (hostPeer.keepaliveTimer) {
    clearInterval(hostPeer.keepaliveTimer);
    hostPeer.keepaliveTimer = null;
  }
  hostPeer.serializeAddon.dispose();
  hostPeers.delete(sessionId);
}

export function _resetForTesting(): void {
  for (const [sessionId] of hostPeers) {
    stopShare(sessionId);
  }
  hostPeers.clear();
}
