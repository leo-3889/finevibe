#!/usr/bin/env node
// Audit tool: validate code pointers in markdown docs.
// Resolves `path.ts`, `path.ts:12`, `path.ts:12-49`, `dir/{a,b}.ts`, and the
// bare-basename shorthand docs use (`terminal-theme.ts` → src/renderer/terminal-theme.ts).
// Reports: unresolvable code pointers, pointers past EOF, ambiguous basenames.
// Usage: node dev/audit/pointer-check.js [docsDir=docs]
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const docsDir = path.resolve(root, process.argv[2] || 'docs');
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;
const lenCache = new Map();

function linesOf(p) {
  if (!lenCache.has(p)) {
    try { lenCache.set(p, fs.readFileSync(path.resolve(root, p), 'utf8').split(/\r?\n/).length); }
    catch { lenCache.set(p, -1); }
  }
  return lenCache.get(p);
}

function expandBraces(spec) {
  const m = spec.match(/\{([^}]*)\}/);
  if (!m) return [spec];
  const out = [];
  for (const alt of m[1].split(',')) {
    const head = spec.slice(0, m.index), tail = spec.slice(m.index + m[0].length);
    for (const r of expandBraces(head + alt.trim() + tail)) out.push(r);
  }
  return out;
}

const INDEX = (() => {
  const byBase = new Map();
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', 'dev', 'build', '.flake-tmp']);
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(d, e.name)); continue; }
      const rel = path.relative(root, path.join(d, e.name)).split(path.sep).join('/');
      if (!byBase.has(e.name)) byBase.set(e.name, []);
      byBase.get(e.name).push(rel);
    }
  })(root);
  return byBase;
})();

function resolve(cand, docDir) {
  const direct = [cand, path.relative(root, path.resolve(docDir, cand)).split(path.sep).join('/')];
  for (const d of direct) if (linesOf(d) !== -1) return { file: d };
  const base = cand.split('/').pop();
  let hits = INDEX.get(base) || [];
  if (cand.includes('/')) {
    const tail = cand.split('/').slice(0, -1).join('/');
    hits = hits.filter(p => p.includes('/' + tail + '/' + base) || p.startsWith(tail + '/' + base));
  }
  if (hits.length === 1) return { file: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return null;
}

const missing = [], stale = [], ambiguous = [], dataOnly = new Set();
let total = 0, code = 0;

function walkDocs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walkDocs(p); continue; }
    if (!e.name.endsWith('.md')) continue;
    const docDir = path.dirname(p);
    const text = fs.readFileSync(p, 'utf8');
    for (const raw of text.match(/`[\w./-]+\.(?:ts|tsx|js|json|yml|yaml|sh|py)(?::\d+(?:[-,]\d+)*)?`/g) || []) {
      const spec = raw.replace(/`/g, '');
      const [filePart, rangePart] = spec.split(':');
      for (const cand of expandBraces(filePart)) {
        if (!cand.includes('.')) continue;
        total++;
        const r = resolve(cand, docDir);
        if (!r) {
          if (CODE.test(cand)) missing.push(`${path.relative(root, p)}: ${spec}`);
          else dataOnly.add(cand);
          continue;
        }
        if (r.ambiguous) {
          if (CODE.test(cand)) ambiguous.push(`${path.relative(root, p)}: ${spec} → ${r.ambiguous.join(', ')}`);
          continue;
        }
        if (!CODE.test(r.file) || !rangePart) continue;
        code++;
        const len = linesOf(r.file);
        const max = Math.max(...rangePart.split(/[-,]/).map(Number));
        if (max > len) stale.push(`${path.relative(root, p)}: ${spec} — ${r.file} has ${len} lines`);
      }
    }
  }
}

walkDocs(docsDir);
const uniq = a => [...new Set(a)];
console.log(`refs: ${total}  code-range checks: ${code}  unresolvable code pointers: ${uniq(missing).length}  past EOF: ${uniq(stale).length}  ambiguous: ${uniq(ambiguous).length}  non-code refs: ${dataOnly.size}`);
for (const m of uniq(missing)) console.log(`MISSING    ${m}`);
for (const s of uniq(stale)) console.log(`STALE      ${s}`);
for (const a of uniq(ambiguous)) console.log(`AMBIGUOUS  ${a}`);
process.exit(uniq(missing).length + uniq(stale).length ? 1 : 0);
