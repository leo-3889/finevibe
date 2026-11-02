// Audit helper: normalize CRLF worktree files back to LF.
// The repo has LF blobs, `core.autocrlf=false` and no `.gitattributes`, so any
// tool that writes CRLF turns a 5-line fix into a whole-file diff. Run from the
// repo root: `node dev/audit/normalize-eol.js [dir ...]` (defaults below).
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DEFAULTS = ['src', 'test', 'docs', 'scripts', 'todos'];
const EXT = /\.(ts|tsx|js|cjs|mjs|json|md|sh|yml|yaml|css|html)$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', 'build', '.flake-tmp']);

const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
let scanned = 0;
const fixed = [];

function check(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('\r\n')) return;
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n'));
  fixed.push(path.relative(ROOT, file).split(path.sep).join('/'));
}

function walk(entry) {
  const abs = path.resolve(ROOT, entry);
  if (!fs.existsSync(abs)) return;
  if (fs.statSync(abs).isFile()) {
    if (EXT.test(abs)) {
      scanned++;
      check(abs);
    }
    return;
  }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    walk(path.join(entry, e.name));
  }
}

for (const t of targets) walk(t);
console.log(`scanned ${scanned} files`);
console.log(fixed.length ? `normalized:\n  ${fixed.join('\n  ')}` : 'no CRLF found');
