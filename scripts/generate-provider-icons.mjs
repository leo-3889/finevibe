#!/usr/bin/env node
// Provider icon generator (pure Node, no deps).
//
// Renders the provider marks FineVibe does not ship as checked-in brand art,
// into src/renderer/assets/providers/<id>.png — the path every renderer asks
// for (`assets/providers/${providerId}.png` in board-card.ts and tab-list.ts),
// copied verbatim into the package by scripts/copy-assets.js and drawn at the
// 14px `.tab-provider-icon` size (styles/tabs.css).
//
// Deterministic: same inputs, byte-identical output (fixed supersample grid,
// deflate level pinned, no timestamps).
//
// pi-bolt: the upstream Pi-Bolt logo, vendored as `pi-bolt.svg` next to the
// PNG it produces — https://github.com/opensec-git/Pi-Bolt `docs/images/logo.svg`
// (sha256 ccbb953e8f8c3ef9fc773463f5221458d2dc9746eae60e2b7634071f649e22f1,
// MIT, © 2025 Mario Zechner / © 2026 OpenSec). Geometry and colours are parsed
// out of the SVG, never restated here, so re-vendoring the upstream file is
// the only step a logo change needs.
//
// Pi, OMP, and the five upstream CLIs keep their existing marks; this script
// writes only the ids in ICONS below. src/renderer/provider-icons.test.ts
// fails the build if any provider id lacks an icon, if two share icon bytes
// (the byte-copy defect that shipped pi-bolt.png as a copy of pi.png), or if a
// file in that directory is owned by no provider.
//
// Usage: node scripts/generate-provider-icons.mjs [out-dir]
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const SIZE = 96; // well above the 14px render size; the guard floor is 32px
const S = SIZE;
const SAMPLES = 8; // per axis, per pixel

// Straight (non-premultiplied) source-over accumulator for one pixel.
function pixel() {
  let r = 0, g = 0, b = 0, a = 0;
  return {
    over(rgb, na) {
      if (na <= 0) return;
      const oa = na + a * (1 - na);
      r = Math.round((rgb[0] * na + r * a * (1 - na)) / oa);
      g = Math.round((rgb[1] * na + g * a * (1 - na)) / oa);
      b = Math.round((rgb[2] * na + b * a * (1 - na)) / oa);
      a = oa;
    },
    write(img, o) {
      img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = Math.round(255 * a);
    },
  };
}

/** Even-odd point-in-polygon, in the polygon's own coordinate space. */
function inside(x, y, pts) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Rasterize an SVG made of flat `<polygon fill="#rrggbb" points="…"/>` shapes
 * (the upstream logo's exact form) onto the SIZE canvas, document order.
 */
function renderSvgPolygons(svg, scale = 1, ox = 0, oy = 0) {
  const vb = (svg.match(/viewBox="([\d.\s-]+)"/) ?? [null, `0 0 ${S} ${S}`])[1]
    .trim().split(/\s+/).map(Number);
  const polys = [...svg.matchAll(/<polygon[^>]*fill="#([0-9a-fA-F]{6})"[^>]*points="([^"]*)"/g)]
    .map((m) => ({
      rgb: [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)],
      pts: m[2].trim().split(/\s+/).map((p) => p.split(',').map(Number)),
    }));
  if (!polys.length) throw new Error('no <polygon fill=… points=…> shapes found in the SVG');

  // viewBox -> canvas: uniform scale, centered, then caller's offset (viewBox units).
  const k = (S / Math.max(vb[2], vb[3])) * scale;
  const tx = (S - vb[2] * k) / 2 + ox * k;
  const ty = (S - vb[3] * k) / 2 + oy * k;
  const toCanvas = ([x, y]) => [(x - vb[0]) * k + tx, (y - vb[1]) * k + ty];

  const img = Buffer.alloc(S * S * 4);
  const shapePts = polys.map((p) => p.pts.map(toCanvas));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = pixel();
      for (let s = 0; s < polys.length; s++) {
        let hit = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            if (inside(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES, shapePts[s])) hit++;
          }
        }
        px.over(polys[s].rgb, hit / (SAMPLES * SAMPLES));
      }
      px.write(img, (y * S + x) * 4);
    }
  }
  return img;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'src', 'renderer', 'assets', 'providers');
const ICONS = {
  // Full-bleed: the bolt fills its 800x800 viewBox diagonally on its own.
  'pi-bolt': () => renderSvgPolygons(readFileSync(path.join(assetDir, 'pi-bolt.svg'), 'utf8')),
};

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
function encodePng(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) img.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = process.argv[2] ?? assetDir;
mkdirSync(outDir, { recursive: true });
for (const [id, render] of Object.entries(ICONS)) {
  const png = encodePng(render());
  const file = path.join(outDir, `${id}.png`);
  writeFileSync(file, png);
  console.log(`${path.relative(root, file)}: ${S}x${S}, ${(png.length / 1024).toFixed(1)}KB`);
}
