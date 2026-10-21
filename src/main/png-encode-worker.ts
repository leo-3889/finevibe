import * as zlib from 'zlib';

/**
 * P4 off-main PNG encoder (todos/clipboard-paste-latency-plan.md).
 *
 * P0 measured `toPNG` as the dominant main-thread freeze of a screenshot
 * paste — 192 ms p50 at 1080p, 307 ms at 1440p (docs/performance.md) — on
 * the same thread that pumps every PTY chunk. This file is forked as an
 * Electron `utilityProcess`: main hands over the decoded RGBA bytes
 * (`NativeImage.toBitmap()`, a copy, not an encode) and the geometry; the
 * PNG container is built here, off the main thread, with nothing but
 * Node's built-in `zlib` — no dependency, no native module.
 *
 * Filter type 0 (None) per scanline keeps the encoder boring; `deflate`
 * still collapses terminal-style redundancy well (see the repetitive-row
 * test). Every chunk carries a real CRC32 so any image reader accepts the
 * file — providers open pasted screenshots with arbitrary tools.
 */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA8888 (the shape `NativeImage.toBitmap()` returns) → 8-bit truecolor+alpha PNG. */
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const stride = width * 4;
  if (width <= 0 || height <= 0 || rgba.length !== stride * height) {
    throw new Error(`PNG encode size mismatch: ${rgba.length} bytes for ${width}x${height}`);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- utilityProcess entry ---------------------------------------------------
//
// The parent (ipc-handlers.ts) posts {id, rgba: ArrayBuffer (transferred),
// width, height} and gets back {id, ok, png} / {id, ok:false, error}. A
// plain `node` run (vitest imports this module for the encoder tests) has
// no parentPort, so the loop below simply never starts.
type EncodeRequest = { id: number; rgba: ArrayBuffer; width: number; height: number };
type ParentPort = {
  on(event: 'message', cb: (event: { data: EncodeRequest }) => void): void;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
};

// SAFETY: Electron's utilityProcess child exposes `process.parentPort`;
// a plain node process (vitest importing the encoder) has no such property,
// which is exactly the undefined case the `if` below guards.
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parentPort) {
  parentPort.on('message', (event) => {
    const { id, rgba, width, height } = event.data;
    try {
      const png = encodePng(Buffer.from(rgba), width, height);
      const view = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
      parentPort.postMessage({ id, ok: true, png: view }, [view]);
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
