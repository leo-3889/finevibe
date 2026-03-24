// Shared WebRTC utilities for P2P session sharing.

import type { ShareMessage } from '../../shared/sharing-types.js';

export const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export function sendMessage(dc: RTCDataChannel, msg: ShareMessage): void {
  if (dc.readyState === 'open') {
    dc.send(JSON.stringify(msg));
  }
}

export function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Timeout after 10s in case ICE gathering stalls
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, 10_000);
  });
}
