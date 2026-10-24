#!/usr/bin/env node
// The icon master is assets/icon-source.png (1024x1024, tracked), rendered by
// scripts/generate-icon.mjs. Regenerate the master first if the design changed.
//   build/icon.png  - electron-builder top-level/linux icon + in-app window icon
//   build/icon.icns - macOS (mac.icon)
//   build/icon.ico  - Windows (win.icon)
//   build/installerHeader.bmp   - NSIS assisted-wizard header strip, 150x57
//   build/installerSidebar.bmp  - NSIS welcome/finish page bitmap, 164x314
// The NSIS assisted installer (nsis.oneClick:false) ignores installerHeaderIcon.ico
// and reads its wizard art from those two BMPs, found by filename in `build`
// (NsisTarget configureDefines, non-oneClick branch). makensis demands exactly
// those pixel sizes. Both are rendered from the same art as the icon master.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderTile, BG_TOP, BG_BOT, clamp01 } from './icon-art.mjs';
import png2icons from 'png2icons';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'assets', 'icon-source.png');
const build = path.join(root, 'build');

const png = fs.readFileSync(src);
const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
if (size[0] !== size[1] || size[0] < 1024) {
  console.error(`Expected square >=1024px source icon, got ${size.join('x')} from ${src}`);
  process.exit(1);
}

fs.mkdirSync(build, { recursive: true });
fs.writeFileSync(path.join(build, 'icon.png'), png);

const icns = png2icons.createICNS(png, png2icons.BICUBIC, 0);
if (!icns) {
  console.error('createICNS failed (source PNG must be square, >=256px, RGBA)');
  process.exit(1);
}
fs.writeFileSync(path.join(build, 'icon.icns'), icns);

const ico = png2icons.createICO(png, png2icons.BICUBIC, 0, false, true);
if (!ico) {
  console.error('createICO failed (source PNG must be square, >=256px, RGBA)');
  process.exit(1);
}
fs.writeFileSync(path.join(build, 'icon.ico'), ico);

// ---- NSIS wizard art (from scripts/icon-art.mjs, same art as the master) ----

// 24bpp uncompressed BMP: BITMAPFILEHEADER + BITMAPINFOHEADER + bottom-up BGR
// rows padded to 4 bytes. No AND mask, so biHeight stays positive (= h).
function bmp24(w, h, rgb) {
  const row = (w * 3 + 3) & ~3;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(54 + row * h, 2); // file size
  buf.writeUInt32LE(54, 10);          // pixel data offset
  buf.writeUInt32LE(40, 14);          // biSize
  buf.writeInt32LE(w, 18);            // biWidth
  buf.writeInt32LE(h, 22);            // biHeight (positive => bottom-up)
  buf.writeUInt16LE(1, 26);           // biPlanes
  buf.writeUInt16LE(24, 28);          // biBitCount
  buf.writeUInt32LE(0, 30);           // biCompression: BI_RGB
  buf.writeUInt32LE(row * h, 34);     // biSizeImage
  for (let y = 0; y < h; y++) {
    const s = (h - 1 - y) * w * 3;
    for (let x = 0; x < w; x++) {
      const i = s + x * 3, o = 54 + y * row + x * 3;
      buf[o] = rgb[i + 2]; buf[o + 1] = rgb[i + 1]; buf[o + 2] = rgb[i]; // BGR
    }
  }
  return buf;
}

// Diagonal BG_TOP -> BG_BOT gradient, same ramp family as the tile interior.
function gradient(w, h) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = clamp01((x + 0.5 + y + 0.5) / (w + h));
    const i = (y * w + x) * 3;
    rgb[i] = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * g;
    rgb[i + 1] = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * g;
    rgb[i + 2] = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * g;
  }
  return rgb;
}

// Alpha-composite a renderTile() square (ts x ts RGBA) onto rgb at (ox, oy).
function over(rgb, w, h, tile, ts, ox, oy) {
  for (let y = 0; y < ts; y++) for (let x = 0; x < ts; x++) {
    const dx = ox + x, dy = oy + y;
    if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
    const t = (y * ts + x) * 4, a = tile[t + 3] / 255;
    if (a === 0) continue;
    const i = (dy * w + dx) * 3;
    rgb[i] += (tile[t] - rgb[i]) * a;
    rgb[i + 1] += (tile[t + 1] - rgb[i + 1]) * a;
    rgb[i + 2] += (tile[t + 2] - rgb[i + 2]) * a;
  }
}

// Header strip: tile hugging the right edge (MUI_HEADERIMAGE_RIGHT), text left.
const HW = 150, HH = 57, HTS = 53;
const header = gradient(HW, HH);
over(header, HW, HH, renderTile(HTS), HTS, HW - HTS - 6, 2);
fs.writeFileSync(path.join(build, 'installerHeader.bmp'), bmp24(HW, HH, header));

// Sidebar: tile centered in the upper third over the gradient, text zone below.
const SW = 164, SH = 314, STS = 132;
const sidebar = gradient(SW, SH);
over(sidebar, SW, SH, renderTile(STS), STS, (SW - STS) >> 1, 48);
fs.writeFileSync(path.join(build, 'installerSidebar.bmp'), bmp24(SW, SH, sidebar));

console.log('Icons built: build/icon.png, build/icon.icns, build/icon.ico, build/installerHeader.bmp, build/installerSidebar.bmp');
