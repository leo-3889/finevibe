// Host-side WebRTC logic for P2P session sharing.
// Uses native RTCPeerConnection (available in Electron's Chromium).

import type { ShareMode, ShareMessage } from '../../shared/sharing-types.js';
import { getTerminalInstance } from '../components/terminal-pane.js';
import { SerializeAddon } from '@xterm/addon-serialize';
import { ICE_CONFIG, sendMessage, waitForIceGathering, encodeConnectionCode, decodeConnectionCode } from './webrtc-utils.js';
import { generateChallenge, computeChallengeResponse, bytesToHex, validateShareKey } from './share-crypto.js';

interface HostPeer {
  sessionId: string;
  mode: ShareMode;
  passphrase: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  connected: boolean;
  authState: 'none' | 'pending' | 'verified';
  authChallenge: Uint8Array<ArrayBuffer> | null;
  authTimeout: ReturnType<typeof setTimeout> | null;
  // C5R-02: grace window after a transient ICE 'disconnected' (see ICE_GRACE).
  iceGraceTimer: ReturnType<typeof setTimeout> | null;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  missedPongs: number;
  serializeAddon: SerializeAddon;
  tornDown: boolean;
  disconnectedCbs: EventCallback[];
  disconnectFired: boolean;
  // C3RP-03: payloads queued behind a saturated SCTP send buffer.
  pending: string[];
  pendingBytes: number;
}

const hostPeers = new Map<string, HostPeer>();

const KEEPALIVE_INTERVAL = 30_000;
const MAX_MISSED_PONGS = 3;
// C3RP-04: CHUNK_SIZE counted UTF-16 units, but SCTP messages are capped
// (~256 KB in Chromium) and JSON-serialised ESC-dense output inflates
// (~6 bytes per escape). Chunk by serialised UTF-8 bytes under a
// conservative budget instead.
const MAX_SEND_BYTES = 200 * 1024;
// Envelope of {"type":"data","payload":"..."} — a round overhead allowance
// so the byte budget never has to mirror JSON escaping exactly.
const DATA_ENVELOPE_BYTES = 64;
const DATA_CHUNK_BUDGET = MAX_SEND_BYTES - DATA_ENVELOPE_BYTES;
// C3RP-03: stop draining the pending queue while the SCTP send buffer is
// above this mark; 'bufferedamountlow' (threshold set at channel creation)
// resumes it.
const MAX_BUFFERED_BYTES = 1024 * 1024;
// Backlog ceiling for readonly shares: a readonly viewer that cannot keep
// up drops its oldest output rather than growing the queue without bound.
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const AUTH_TIMEOUT = 10_000;
// C5R-02: a bare ICE 'disconnected' is transient in Chromium — ICE restarts
// and network path changes self-recover within seconds. Tearing down on the
// first one permanently killed live authenticated shares, so arm a grace
// timer and tear down only if the connection does not come back. 'failed'
// is terminal and tears down immediately.
const ICE_GRACE = 15_000;

const utf8Encoder = new TextEncoder();

function utf8ByteLength(s: string): number {
  return utf8Encoder.encode(s).length;
}

// Split a payload into pieces whose UTF-8 byte size stays under `budget`,
// never cutting a surrogate pair in half.
function chunkByUtf8Bytes(payload: string, budget: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < payload.length; i++) {
    const code = payload.charCodeAt(i);
    const isPair =
      code >= 0xd800 && code <= 0xdbff &&
      i + 1 < payload.length &&
      payload.charCodeAt(i + 1) >= 0xdc00 && payload.charCodeAt(i + 1) <= 0xdfff;
    let size: number;
    if (isPair) size = 4;
    else if (code <= 0x7f) size = 1;
    else if (code <= 0x7ff) size = 2;
    else size = 3;
    if (bytes + size > budget) {
      chunks.push(payload.slice(start, i));
      start = i;
      bytes = 0;
    }
    if (isPair) i++;
    bytes += size;
  }
  if (start < payload.length) chunks.push(payload.slice(start));
  return chunks;
}

type EventCallback = () => void;

export interface ShareHandle {
  getOffer(): Promise<string>;
  acceptAnswer(answer: string): Promise<void>;
  stop(): void;
  onConnected(cb: EventCallback): void;
  onDisconnected(cb: EventCallback): void;
  onAuthFailed(cb: (reason: string) => void): void;
}

// C3RP-03: enqueue a data payload as byte-budget pieces (C3RP-04 chunking),
// coalesced at drain time. A readonly viewer that cannot keep up sheds its
// oldest output past MAX_PENDING_BYTES; readwrite keeps stream ordering.
function queueData(peer: HostPeer, payload: string): void {
  for (const piece of chunkByUtf8Bytes(payload, DATA_CHUNK_BUDGET)) {
    peer.pending.push(piece);
    peer.pendingBytes += utf8ByteLength(piece);
  }
  if (peer.mode === 'readonly') {
    while (peer.pendingBytes > MAX_PENDING_BYTES && peer.pending.length > 1) {
      peer.pendingBytes -= utf8ByteLength(peer.pending.shift()!);
    }
  }
}

// Flush queued pieces: coalesce into as few messages as the byte budget
// allows, stop while the SCTP send buffer sits above MAX_BUFFERED_BYTES
// (resumed by 'bufferedamountlow'). Returns false only when the channel
// can no longer take messages at all.
function drainPending(peer: HostPeer): boolean {
  const dc = peer.dc;
  while (peer.pending.length > 0) {
    if (dc.readyState !== 'open') return false;
    if (dc.bufferedAmount > MAX_BUFFERED_BYTES) return true;
    let take = 0;
    let bytes = 0;
    while (take < peer.pending.length) {
      const size = utf8ByteLength(peer.pending[take]);
      if (take > 0 && bytes + size > DATA_CHUNK_BUDGET) break;
      bytes += size;
      take++;
    }
    const payload = peer.pending.slice(0, take).join('');
    peer.pending.splice(0, take);
    peer.pendingBytes -= bytes;
    try {
      sendMessage(dc, { type: 'data', payload });
    } catch {
      return false;
    }
  }
  return true;
}

export function startShare(sessionId: string, mode: ShareMode, passphrase: string): ShareHandle {
  const keyError = validateShareKey(passphrase);
  if (keyError) throw new Error(keyError);
  stopShare(sessionId);

  const instance = getTerminalInstance(sessionId);
  if (!instance) throw new Error(`No terminal instance for session ${sessionId}`);

  const serializeAddon = new SerializeAddon();
  instance.terminal.loadAddon(serializeAddon);

  const connectedCbs: EventCallback[] = [];
  const authFailedCbs: ((reason: string) => void)[] = [];

  const pc = new RTCPeerConnection(ICE_CONFIG);
  const dc = pc.createDataChannel('terminal', { ordered: true });
  // C3RP-03: low-water mark that re-arms drainPending (see below).
  dc.bufferedAmountLowThreshold = MAX_BUFFERED_BYTES;

  const hostPeer: HostPeer = {
    sessionId,
    mode,
    passphrase,
    pc,
    dc,
    connected: false,
    authState: 'none',
    authChallenge: null,
    authTimeout: null,
    keepaliveTimer: null,
    iceGraceTimer: null,
    missedPongs: 0,
    serializeAddon,
    tornDown: false,
    disconnectedCbs: [],
    disconnectFired: false,
    pending: [],
    pendingBytes: 0,
  };

  hostPeers.set(sessionId, hostPeer);
  dc.onbufferedamountlow = () => drainPending(hostPeer);

  // Returns false when the data channel rejects the session frames: the
  // caller must then not mark the peer connected (C3RP-04).
  const sendInitAndStartKeepalive = (): boolean => {
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

    const initOverheadBytes = utf8ByteLength(JSON.stringify(initMsg));
    if (utf8ByteLength(scrollback) + initOverheadBytes <= MAX_SEND_BYTES) {
      initMsg.scrollback = scrollback;
    }
    try {
      sendMessage(dc, initMsg);
    } catch {
      return false;
    }
    if (initMsg.scrollback === '' && scrollback.length > 0) {
      // Chunked scrollback rides the same pending/backpressure path as
      // live output (C3RP-03).
      queueData(hostPeer, scrollback);
      if (!drainPending(hostPeer)) return false;
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

    for (const cb of connectedCbs) cb();
    return true;
  };

  dc.onopen = () => {
    if (hostPeers.get(sessionId) !== hostPeer) return;
    // Start auth handshake — do not send session data until verified
    const challenge = generateChallenge();
    hostPeer.authChallenge = challenge;
    hostPeer.authState = 'pending';
    sendMessage(dc, { type: 'auth-challenge', challenge: bytesToHex(challenge) });

    hostPeer.authTimeout = setTimeout(() => {
      if (hostPeers.get(sessionId) === hostPeer && hostPeer.authState !== 'verified') {
        for (const cb of authFailedCbs) cb('Authentication timed out');
        stopShare(sessionId);
      }
    }, AUTH_TIMEOUT);
  };

  dc.onmessage = (event: MessageEvent) => {
    let msg: ShareMessage;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Auth handshake
    if (hostPeer.authState === 'pending' && msg.type === 'auth-response') {
      computeChallengeResponse(hostPeer.authChallenge!, passphrase).then((expected) => {
        if (hostPeers.get(sessionId) !== hostPeer || hostPeer.authState !== 'pending') return;
        if (hostPeer.authTimeout) {
          clearTimeout(hostPeer.authTimeout);
          hostPeer.authTimeout = null;
        }
        if (expected === msg.response) {
          hostPeer.authState = 'verified';
          try {
            sendMessage(dc, { type: 'auth-result', ok: true });
          } catch {
            teardown(hostPeer);
            return;
          }
          // C3RP-04: only mark connected once the session frames made it
          // out — a throwing dc.send must not leave a "connected" peer
          // with no keepalive whose every PTY chunk then throws.
          if (sendInitAndStartKeepalive()) {
            hostPeer.connected = true;
          } else {
            teardown(hostPeer);
          }
        } else {
          sendMessage(dc, { type: 'auth-result', ok: false, reason: 'Passphrase mismatch' });
          for (const cb of authFailedCbs) cb('Passphrase mismatch');
          stopShare(sessionId);
        }
      })
        // C3RP-05: a rejected challenge computation must not leave the
        // peer hanging in 'pending' with an open PC.
        .catch(() => teardown(hostPeer));
      return;
    }

    // Ignore all non-auth messages until verified
    if (hostPeer.authState !== 'verified') return;

    if (msg.type === 'input' && mode === 'readwrite') {
      window.finevibe.pty.write(sessionId, msg.payload);
    } else if (msg.type === 'pong') {
      hostPeer.missedPongs = 0;
    }
  };

  const handleDisconnect = () => {
    if (hostPeers.get(sessionId) !== hostPeer) return;
    // C3RP-02: teardown owns the single disconnect notification.
    teardown(hostPeer);
  };

  dc.onclose = handleDisconnect;

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      handleDisconnect();
    } else if (pc.iceConnectionState === 'disconnected') {
      // C5R-02: give Chromium's ICE self-recovery the grace window; if no
      // 'connected'/'completed' arrives before it expires, the peer is gone.
      if (!hostPeer.iceGraceTimer) {
        hostPeer.iceGraceTimer = setTimeout(() => {
          hostPeer.iceGraceTimer = null;
          handleDisconnect();
        }, ICE_GRACE);
      }
    } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      if (hostPeer.iceGraceTimer) {
        clearTimeout(hostPeer.iceGraceTimer);
        hostPeer.iceGraceTimer = null;
      }
    }
  };

  return {
    async getOffer(): Promise<string> {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      return encodeConnectionCode(pc.localDescription, passphrase);
    },
    async acceptAnswer(answer: string): Promise<void> {
      const desc = await decodeConnectionCode(answer, 'answer', passphrase);
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
    },
    stop(): void {
      stopShare(sessionId);
    },
    onConnected(cb: EventCallback): void {
      connectedCbs.push(cb);
    },
    onDisconnected(cb: EventCallback): void {
      hostPeer.disconnectedCbs.push(cb);
    },
    onAuthFailed(cb: (reason: string) => void): void {
      authFailedCbs.push(cb);
    },
  };
}

export function stopShare(sessionId: string): void {
  const hostPeer = hostPeers.get(sessionId);
  if (!hostPeer) return;

  if (hostPeer.connected) {
    try { sendMessage(hostPeer.dc, { type: 'end' }); } catch { /* ignore */ }
  }
  teardown(hostPeer);
}

export function broadcastData(sessionId: string, data: string): void {
  const hostPeer = hostPeers.get(sessionId);
  if (!hostPeer?.connected || hostPeer.authState !== 'verified') return;
  // C3RP-03: coalesced pending queue with SCTP backpressure, not an
  // unbounded dc.send per PTY chunk.
  queueData(hostPeer, data);
  drainPending(hostPeer);
}

export function broadcastResize(sessionId: string, cols: number, rows: number): void {
  const hostPeer = hostPeers.get(sessionId);
  if (!hostPeer?.connected || hostPeer.authState !== 'verified') return;
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

/**
 * Idempotent teardown for one specific peer instance. Closes both native
 * resources (data channel and peer connection) and releases ownership.
 *
 * Safe to call from any terminal path (ICE disconnect/failed, channel close,
 * auth failure/timeout, explicit stop, replacement). Handlers are detached
 * before the natives are closed so the resulting close events cannot
 * re-enter teardown. Ownership is only removed if this peer is still the
 * owner of its session id, so a late teardown of a replaced peer cannot
 * delete the replacement's map entry.
 */
function teardown(peer: HostPeer): void {
  if (peer.tornDown) return;
  peer.tornDown = true;

  // Detach handlers so native close events cannot re-enter teardown.
  peer.dc.onclose = null;
  peer.dc.onopen = null;
  peer.dc.onmessage = null;
  peer.dc.onbufferedamountlow = null;
  peer.pc.oniceconnectionstatechange = null;

  if (peer.keepaliveTimer) {
    clearInterval(peer.keepaliveTimer);
    peer.keepaliveTimer = null;
  }
  if (peer.authTimeout) {
    clearTimeout(peer.authTimeout);
    peer.authTimeout = null;
  }
  if (peer.iceGraceTimer) {
    clearTimeout(peer.iceGraceTimer);
    peer.iceGraceTimer = null;
  }
  peer.serializeAddon.dispose();
  peer.pending = [];
  peer.pendingBytes = 0;

  try { peer.dc.close(); } catch { /* ignore */ }
  try { peer.pc.close(); } catch { /* ignore */ }

  if (hostPeers.get(peer.sessionId) === peer) {
    hostPeers.delete(peer.sessionId);
    peer.connected = false;
    // C3RP-02: every terminal path (keepalive dead-peer, auth failure/
    // timeout, explicit stop, replacement) ends here, so the single
    // disconnect notification lives here — detached-close handlers used
    // to make stopShare-reached teardowns silent, pinning the share badge
    // and the share-manager handle on a dead viewer forever.
    if (!peer.disconnectFired) {
      peer.disconnectFired = true;
      for (const cb of peer.disconnectedCbs) cb();
    }
  }
}

export function _resetForTesting(): void {
  for (const peer of [...hostPeers.values()]) {
    teardown(peer);
  }
  hostPeers.clear();
}
