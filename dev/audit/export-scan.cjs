#!/usr/bin/env node
// Audit tool: exported symbols with zero references outside their own file.
// Classifies each as test-only (any test references it) or in-file-only.
// Usage: node dev/audit/export-scan.cjs [srcDir=src] [--verify NAME,NAME]
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
let verifyArg = '';
const vi = args.findIndex(a => a.startsWith('--verify'));
if (vi >= 0) verifyArg = (args[vi].includes('=') ? args[vi].split('=')[1] : args[vi + 1] || '');
const srcDir = path.resolve(root, args[0] && !args[0].startsWith('--') ? args[0] : 'src');

const src = [], tests = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) (e.name.endsWith('.test.ts') ? tests : src).push(p);
  }
})(srcDir);

const EX = ['ex', 'port'].join('');
const decl = new RegExp('^' + EX + '\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum|abstract\\s+class)\\s+([A-Za-z_$][\\w$]*)');
const reexport = new RegExp('^' + EX + '\\s*\\{[^}]*\\b([A-Za-z_$][\\w$]*)\\b[^}]*\\}');
const decls = [];
for (const f of src) {
  const lines = fs.readFileSync(f, 'utf8').replace(/\r/g, '').split('\n');
  lines.forEach((l, i) => {
    const m = l.match(decl) || l.match(reexport);
    if (m) decls.push({ name: m[1], file: path.relative(root, f).split(path.sep).join('/'), line: i + 1 });
  });
}

const srcTokens = src.map(f => new Set((fs.readFileSync(f, 'utf8').match(/[A-Za-z_$][\w$]*/g) || [])));
const testTokens = tests.map(f => new Set((fs.readFileSync(f, 'utf8').match(/[A-Za-z_$][\w$]*/g) || [])));

const zero = [];
for (let i = 0; i < decls.length; i++) {
  const { name, file } = decls[i];
  let otherSrc = false, testRef = false;
  for (let k = 0; k < src.length; k++) {
    if (path.relative(root, src[k]).split(path.sep).join('/') === file) continue;
    if (srcTokens[k].has(name)) { otherSrc = true; break; }
  }
  if (!otherSrc) for (const t of testTokens) if (t.has(name)) { testRef = true; break; }
  if (!otherSrc) zero.push({ name, file, line: decls[i].line, verdict: testRef ? 'test-only' : 'in-file-only' });
}

zero.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
console.log(`declarations scanned: ${decls.length}  zero-external-reference: ${zero.length}  (test-only ${zero.filter(z => z.verdict === 'test-only').length}, in-file-only ${zero.filter(z => z.verdict === 'in-file-only').length})`);
for (const z of zero) console.log(`${z.verdict.padEnd(13)} ${z.file}:${z.line}  ${z.name}`);

if (verifyArg) {
  console.log('\n--- word-boundary verification (all src incl. tests) ---');
  for (const name of verifyArg.split(',').filter(Boolean)) {
    const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
    const hits = [];
    for (const f of [...src, ...tests]) {
      const ls = fs.readFileSync(f, 'utf8').replace(/\r/g, '').split('\n');
      ls.forEach((l, i) => { if (re.test(l)) hits.push(`${path.relative(root, f).split(path.sep).join('/')}:${i + 1}`); });
    }
    console.log(`${name}: ${hits.length} hit(s)  ${hits.slice(0, 8).join(' ')}`);
  }
}
process.exit(0);
