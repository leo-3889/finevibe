import { describe, expect, it } from 'vitest';
import * as zlib from 'zlib';
import { encodePng } from './png-encode-worker';

// The P4 encode must be a REAL PNG — a provider opens the pasted file with
// any image reader, so the container is verified from scratch here: the
// 8-byte signature, IHDR geometry, every chunk's CRC recomputed with an
// independent CRC32 implementation, and the inflated IDAT reconstructed
// pixel-for-pixel.

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

type Chunk = { type: string; data: Buffer };

function parseChunks(png: Buffer): Chunk[] {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const chunks: Chunk[] = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    const crc = png.readUInt32BE(off + 8 + len);
    expect(crc, `CRC of ${type}`).toBe(crc32(png.subarray(off + 4, off + 8 + len)));
    chunks.push({ type, data });
    off += 12 + len;
  }
  return chunks;
}

function scanlines(png: Buffer, width: number, height: number): Buffer {
  const chunks = parseChunks(png);
  expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  expect(ihdr.readUInt32BE(0)).toBe(width);
  expect(ihdr.readUInt32BE(4)).toBe(height);
  expect(ihdr[8]).toBe(8); // bit depth
  expect(ihdr[9]).toBe(6); // color type: truecolor + alpha
  return zlib.inflateSync(chunks[1].data);
}

describe('encodePng (P4 off-main encoder)', () => {
  it('encodes a 2x2 RGBA bitmap to a pixel-exact PNG', () => {
    const rgba = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 128,
      0, 0, 255, 255, 10, 20, 30, 0,
    ]);

    const raw = scanlines(encodePng(rgba, 2, 2), 2, 2);

    // Each scanline: one filter-type byte (0 = None) then width*4 samples.
    expect(raw).toEqual(Buffer.concat([
      Buffer.from([0]), rgba.subarray(0, 8),
      Buffer.from([0]), rgba.subarray(8, 16),
    ]));
  });

  it('encodes a 1x1 fully transparent pixel', () => {
    const raw = scanlines(encodePng(Buffer.from([0, 0, 0, 0]), 1, 1), 1, 1);
    expect(raw).toEqual(Buffer.from([0, 0, 0, 0, 0]));
  });

  it('deflates repetitive rows smaller than the raw scanlines (a real deflate, not a passthrough)', () => {
    const width = 256;
    const height = 256;
    const rgba = Buffer.alloc(width * height * 4, 7);
    const png = encodePng(rgba, width, height);
    expect(png.length).toBeLessThan(width * height * 4);
    const raw = scanlines(png, width, height);
    expect(raw.length).toBe((width * 4 + 1) * height);
  });

  it('rejects a bitmap whose byte length does not match width*height*4', () => {
    expect(() => encodePng(Buffer.alloc(5), 2, 2)).toThrow(/size/);
  });
});
