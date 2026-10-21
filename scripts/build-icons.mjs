#!/usr/bin/env node
// The icon master is assets/icon-source.png (1024x1024, tracked), rendered by
// scripts/generate-icon.mjs. Regenerate the master first if the design changed.
// Outputs:
//   build/icon.png  - electron-builder top-level/linux icon + in-app window icon
//   build/icon.icns - macOS (mac.icon)
//   build/icon.ico  - Windows (win.icon)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

console.log('Icons built: build/icon.png, build/icon.icns, build/icon.ico');
