#!/usr/bin/env node
// Renderer build + bundle budget (architecture audit 2026-10-28, P1; split
// landed with P3 the same day).
//
// Why this file exists: the renderer shipped as one ~1.3 MB minified IIFE and
// nothing measured it. The bundle is now ES modules with esbuild chunk splitting
// (`--format=esm --splitting`), which is only executable because the app loads
// over the privileged `app://` scheme — Chromium refuses module scripts on
// `file://` (src/main/app-scheme.ts). The budget gate and the per-owner report
// are unchanged in purpose: a number that fails the build when the entry grows,
// plus a report that names what is actually big inside it.
//
// Sourcemaps: built always (dev: inline). The package excludes `dist/**/*.map`
// (package.json build.files), so a packaged app pays nothing while a pasted
// renderer stack trace stays symbolicable by anyone holding the matching build.
import { build } from 'esbuild';
import { statSync } from 'node:fs';

const DEV = process.argv.includes('--dev');
const OUT_DIR = 'dist/renderer';
const OUT = `${OUT_DIR}/index.js`;
// Two budgets, measured on the 2026-10-28 split tree (entry 190.6 KiB, total
// 1273.5 KiB):
//   ENTRY  = the file that blocks first paint. 190.6 + headroom.
//   TOTAL  = every JS byte the app ships (entry + chunks). The pre-split number
//            (1400) kept: total is what the app grew by, and splitting moves
//            bytes between files without removing them — gating only the entry
//            would let a 5 MB chunk grow ungated.
// Raising either is a deliberate act: do it in a commit that says why.
const ENTRY_BUDGET_KIB = 350;
const TOTAL_BUDGET_KIB = 1400;

const result = await build({
  entryPoints: ['src/renderer/index.ts'],
  outdir: OUT_DIR,
  bundle: true,
  format: 'esm',
  splitting: true,
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
// Every emitted output (entry + chunks) with its size, biggest last after the
// entry, so a growth in a shared chunk is visible in the same report.
const chunks = Object.keys(result.metafile.outputs)
  .filter((key) => key.startsWith(`${OUT_DIR}/`) && key.endsWith('.js') && key !== OUT)
  .map((key) => ({ key, size: statSync(key).size }))
  .sort((a, b) => b.size - a.size);
const total = bytes + chunks.reduce((sum, c) => sum + c.size, 0);

console.log(`[bundle] ${OUT} = ${kib(bytes)} KiB (entry budget ${ENTRY_BUDGET_KIB} KiB)${DEV ? ' [dev, unminified]' : ''}`);
for (const [owner, b] of top) console.log(`[bundle]   ${kib(b).padStart(8)} KiB  ${owner}`);
for (const c of chunks) console.log(`[bundle]   ${kib(c.size).padStart(8)} KiB  chunk  ${c.key}`);
console.log(`[bundle]   ${kib(total).padStart(8)} KiB  total JS shipped (budget ${TOTAL_BUDGET_KIB} KiB)`);

if (!DEV && bytes > ENTRY_BUDGET_KIB * 1024) {
  console.error(
    `[bundle] FAIL: renderer entry is ${kib(bytes)} KiB, over the ${ENTRY_BUDGET_KIB} KiB entry budget.\n` +
    `[bundle] The entry is what blocks first paint: move weight behind a dynamic import (see renderMarkdownContent in src/renderer/components/file-reader.ts), or raise ENTRY_BUDGET_KIB in a commit that explains the growth.`,
  );
  process.exit(1);
}

if (!DEV && total > TOTAL_BUDGET_KIB * 1024) {
  console.error(
    `[bundle] FAIL: renderer ships ${kib(total)} KiB of JS, over the ${TOTAL_BUDGET_KIB} KiB total budget.\n` +
    `[bundle] Shrink what is big (report above names the owners), or raise TOTAL_BUDGET_KIB in scripts/build-renderer.mjs in a commit that explains the growth.`,
  );
  process.exit(1);
}
