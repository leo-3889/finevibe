// FineVibe app icon generator (pure Node, no deps).
// Renders the app tile: dark squircle + accent "❯_" terminal-prompt glyph (name-agnostic).
// All art math lives in scripts/icon-art.mjs, shared with the NSIS wizard BMPs
// rendered by scripts/build-icons.mjs.
// Usage: node scripts/generate-icon.mjs [out.png]
// Writes the tracked icon master consumed by scripts/build-icons.mjs.
import { writeFileSync } from 'node:fs';
import { renderTile, encodePng, DESIGN } from './icon-art.mjs';

const SIZE = DESIGN;
const png = encodePng(renderTile(SIZE), SIZE, SIZE);

const out = process.argv[2] ?? 'assets/icon-source.png';
writeFileSync(out, png);
console.log(`${out}: ${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)}KB`);
