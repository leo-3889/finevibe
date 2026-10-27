#!/usr/bin/env node
// Renderer build + bundle budget (architecture audit 2026-10-28, P1).
//
// Why this file exists: the renderer shipped as one ~1.3 MB minified IIFE and
// nothing measured it. Chunk splitting is NOT available while the app loads
// over `file://` — Chromium blocks ES-module scripts on that scheme in
// Electron, so `--format=esm --splitting` needs a privileged app:// scheme
// first (recipe recorded in todos/AUDIT_STATUS.md). Until then the lever is a
// number that fails the build when the entry grows, plus a report that names
// what is actually big inside it.
//
// Sourcemaps: built always (dev: inline). The package excludes `dist/**/*.map`
// (package.json build.files), so a packaged app pays nothing while a pasted
// renderer stack trace stays symbolicable by anyone holding the matching build.
import { build } from 'esbuild';
import { statSync } from 'node:fs';

const DEV = process.argv.includes('--dev');
const OUT = 'dist/renderer/index.js';
// Budget = the measured 2026-10-28 entry plus ~10% headroom. Raising it is a
// deliberate act: do it in a commit that says why the app got bigger.
const BUDGET_KIB = 1400;

const result = await build({
  entryPoints: ['src/renderer/index.ts'],
  outfile: OUT,
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  minify: !DEV,
  sourcemap: DEV ? 'inline' : true,
  loader: { '.ts': 'ts' },
  metafile: true,
  logLevel: 'warning',
});

const kib = (bytes) => (bytes / 1024).toFixed(1);

// Aggregate the metafile by owning package so the report says WHAT is big.
const byOwner = new Map();
for (const [input, info] of Object.entries(result.metafile.outputs[OUT].inputs)) {
  const owner = input.includes('node_modules')
    ? input.split('node_modules/').pop().split('/').slice(0, input.split('node_modules/').pop().startsWith('@') ? 2 : 1).join('/')
    : 'src (app code)';
  byOwner.set(owner, (byOwner.get(owner) ?? 0) + info.bytesInOutput);
}
const top = [...byOwner.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

const bytes = statSync(OUT).size;
console.log(`[bundle] ${OUT} = ${kib(bytes)} KiB (budget ${BUDGET_KIB} KiB)${DEV ? ' [dev, unminified]' : ''}`);
for (const [owner, b] of top) console.log(`[bundle]   ${kib(b).padStart(8)} KiB  ${owner}`);

if (!DEV && bytes > BUDGET_KIB * 1024) {
  console.error(
    `[bundle] FAIL: renderer entry is ${kib(bytes)} KiB, over the ${BUDGET_KIB} KiB budget.\n` +
    `[bundle] Shrink the entry (lazy path for the top owner above), or raise BUDGET_KIB in scripts/build-renderer.mjs in a commit that explains the growth.`,
  );
  process.exit(1);
}
