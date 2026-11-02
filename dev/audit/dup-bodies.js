#!/usr/bin/env node
// Audit tool: find byte-identical function bodies duplicated across modules.
// Groups top-level `function`/`const fn = (…) =>` bodies by normalized hash.
// Usage: node dev/audit/dup-bodies.js [srcDir=src] [minLines=4]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..', '..');
const srcDir = path.resolve(root, process.argv[2] || 'src');
const minLines = Number(process.argv[3] || 4);
const files = [];

(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(p);
  }
})(srcDir);

const groups = new Map();

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (!/^\s*(export\s+)?(async\s+)?function\s+\w+/.test(head) && !/^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(.*\)\s*(:[^=]+)?=>/.test(head)) continue;
    let depth = 0, opened = false, body = [];
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; opened = true; }
        else if (ch === '}') depth--;
      }
      body.push(lines[j]);
      if (opened && depth === 0) break;
    }
    if (body.length < minLines) continue;
    const norm = body.map(l => l.trim()).filter(Boolean).join('\n');
    if ((norm.match(/\n/g) || []).length < minLines - 1) continue;
    const name = (norm.match(/function\s+(\w+)/) || norm.match(/const\s+(\w+)/) || [])[1];
    if (!name) continue;
    const key = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name, file: path.relative(root, file).split(path.sep).join('/'), line: i + 1, lines: body.length });
  }
}

const dups = [...groups.entries()].filter(([, v]) => new Set(v.map(x => x.file)).size > 1);
dups.sort((a, b) => b[1].length - a[1].length);
console.log(`files scanned: ${files.length}  duplicated bodies (cross-file): ${dups.length}`);
for (const [, v] of dups) {
  console.log(`\n${v[0].name} (${v[0].lines} lines) ×${v.length}`);
  for (const x of v) console.log(`  ${x.file}:${x.line}`);
}
process.exit(0);
