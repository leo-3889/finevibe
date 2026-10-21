// FineVibe app icon generator (pure Node, no deps).
// Renders the app tile: dark squircle + accent "❯_" terminal-prompt glyph (name-agnostic).
// Every shape is a signed-distance field -> exact 1px analytic antialiasing.
// Usage: node scripts/generate-icon.mjs [out.png]
// Writes the tracked icon master consumed by scripts/build-icons.mjs.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;
const S = SIZE;

// ---- palette (mirrors src/renderer/styles/base.css) ----
const BG_TOP = [0x1b, 0x1e, 0x2a];      // raised panel, lifted
const BG_BOT = [0x0b, 0x0c, 0x10];      // canvas, deepened
const ACCENT = [0x85, 0x88, 0xf2];      // --accent
const ACCENT_HI = [0xb3, 0xb5, 0xfb];   // lightened accent for the chevron top
const WHITE = [0xf5, 0xf6, 0xfa];

// ---- SDF primitives ----
const clamp01 = (t) => Math.min(Math.max(t, 0), 1);
const smooth = (d) => clamp01(0.5 - d); // coverage for 1px AA, d in px

function sdRoundBox(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ax = qx > 0 ? qx : 0;
  const ay = qy > 0 ? qy : 0;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r;
}

function sdSegment(x, y, ax, ay, bx, by) {
  const px = x - ax, py = y - ay, bx_ = bx - ax, by_ = by - ay;
  const t = clamp01((px * bx_ + py * by_) / (bx_ * bx_ + by_ * by_));
  return Math.hypot(px - bx_ * t, py - by_ * t);
}
const sdCapsule = (x, y, a, b, r) => sdSegment(x, y, a[0], a[1], b[0], b[1]) - r;

// ---- glyph geometry (1024 canvas) ----
// chevron ❯: two capsules meeting at the right
const CHEV_A = [368, 300], CHEV_B = [648, 512], CHEV_C = [368, 724];
const CHEV_R = 66;
// underscore: rounded bar, baseline-aligned under the chevron's lower arm
const UND = { cx: 706, cy: 724, hw: 128, hh: 34, r: 30 };

// chevron stroke color: vertical gradient accent -> lighter at top
function chevronColor(y) {
  const t = clamp01((y - CHEV_A[1]) / (CHEV_C[1] - CHEV_A[1]));
  return [
    ACCENT_HI[0] + (ACCENT[0] - ACCENT_HI[0]) * t,
    ACCENT_HI[1] + (ACCENT[1] - ACCENT_HI[1]) * t,
    ACCENT_HI[2] + (ACCENT[2] - ACCENT_HI[2]) * t,
  ];
}

const img = Buffer.alloc(S * S * 4);
const TILE = { cx: S / 2, cy: S / 2, hw: 448, hh: 448, r: 224 };

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const px = x + 0.5, py = y + 0.5;

    // tile: squircle-ish rounded box with 1px AA
    const dTile = sdRoundBox(px, py, TILE.cx, TILE.cy, TILE.hw, TILE.hh, TILE.r);
    const tileCov = smooth(dTile);

    // diagonal background gradient inside the tile
    const g = clamp01((px + py) / (2 * S));
    let r = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * g;
    let gr = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * g;
    let b = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * g;

    // faint top rim highlight (ring where |d|<1 near the top edge)
    if (dTile > -3 && dTile < 0.5 && py < TILE.cy) {
      const rim = smooth(dTile) * smooth(-dTile - 2.5) * (1 - py / TILE.cy) * 0.20;
      r += (255 - r) * rim; gr += (255 - gr) * rim; b += (255 - b) * rim;
    }

    // subtle accent glow behind the glyph
    const dGlyph = Math.min(
      sdCapsule(px, py, CHEV_A, CHEV_B, CHEV_R),
      sdCapsule(px, py, CHEV_B, CHEV_C, CHEV_R),
      sdRoundBox(px, py, UND.cx, UND.cy, UND.hw, UND.hh, UND.r),
    );
    const glow = Math.exp(-Math.max(dGlyph, 0) / 90) * 0.16;
    r += (ACCENT[0] - r) * glow; gr += (ACCENT[1] - gr) * glow; b += (ACCENT[2] - b) * glow;

    // chevron (two capsules), gradient fill
    const dChev = Math.min(sdCapsule(px, py, CHEV_A, CHEV_B, CHEV_R), sdCapsule(px, py, CHEV_B, CHEV_C, CHEV_R));
    const chevCov = smooth(dChev);
    if (chevCov > 0) {
      const c = chevronColor(py);
      r += (c[0] - r) * chevCov; gr += (c[1] - gr) * chevCov; b += (c[2] - b) * chevCov;
    }

    // underscore: solid accent
    const dUnd = sdRoundBox(px, py, UND.cx, UND.cy, UND.hw, UND.hh, UND.r);
    const undCov = smooth(dUnd);
    if (undCov > 0) {
      r += (WHITE[0] - r) * undCov; gr += (WHITE[1] - gr) * undCov; b += (WHITE[2] - b) * undCov;
    }

    const i = (y * S + x) * 4;
    img[i] = r; img[i + 1] = gr; img[i + 2] = b;
    img[i + 3] = tileCov * 255; // outside the squircle: fully transparent
  }
}

// ---- minimal PNG encoder (truecolor+alpha, filter 0) ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) img.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2] ?? 'assets/icon-source.png';
writeFileSync(out, png);
console.log(`${out}: ${S}x${S}, ${(png.length / 1024).toFixed(1)}KB`);
