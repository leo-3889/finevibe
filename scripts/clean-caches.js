#!/usr/bin/env node
// Dev-machine cache pruning (npm run clean:caches).
//
// Deletes ONLY:
//   1. The electron / electron-builder download caches (regrown by the next
//      build's downloads — Electron zips, winCodeSign, nsis, tooling):
//        win32   %LOCALAPPDATA%\electron-builder\Cache
//                %LOCALAPPDATA%\electron\Cache
//        darwin  ~/Library/Caches/electron-builder
//                ~/Library/Caches/electron
//                ~/.cache/electron-builder / ~/.cache/electron
//        linux   ~/.cache/electron-builder
//                ~/.cache/electron
//   2. FineVibe temp scratch: top-level entries of os.tmpdir() matching
//      /^(fv-|vb-|fv?clipbench|finevibe-|vibeyard-)/ that are older than
//      24h. The age guard protects scratch of running instances (clipboard
//      monitor, updater staging); locked entries are skipped on
//      EPERM/EBUSY/EACCES, so a live app is never disturbed.
//
// Safe by construction: every deletion target is derived from the fixed
// absolute roots above, each entry is stat'ed before deletion, the resolved
// path is asserted to sit under its root, and nothing outside the roots —
// in particular nothing under %APPDATA% — is ever traversed. Dev-only
// script: no test suite (it targets machine state, not repo state).
//
// Usage: node scripts/clean-caches.js [--dry-run]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SCRATCH_AGE_MS = 24 * 60 * 60 * 1000;
const SCRATCH_PATTERN = /^(fv-|vb-|fv?clipbench|finevibe-|vibeyard-)/;
const MB = 1024 * 1024;

const mb = bytes => (bytes / MB).toFixed(1);

function treeSize(target) {
  // Sum of regular-file sizes under target. Symlinks and unreadable
  // entries count as 0 — this feeds the freed-MB report only, never a
  // deletion decision.
  let st;
  try { st = fs.lstatSync(target); } catch { return 0; }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    total += treeSize(path.join(target, e.name));
  }
  return total;
}

function remove(target) {
  // Locked entries of a running app stay behind; anything else is a real
  // error and propagates.
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') return false;
    throw err;
  }
}

function assertUnder(target, root, label) {
  const resolved = path.resolve(target);
  const base = path.resolve(root);
  if (!path.isAbsolute(base) || (resolved !== base && !resolved.startsWith(base + path.sep))) {
    throw new Error(`refusing to delete ${label} entry ${resolved}: not under ${base}`);
  }
  return resolved;
}

function pruneEntries(label, root, entries, freed) {
  let removed = 0;
  let skipped = 0;
  for (const entry of entries) {
    const target = assertUnder(path.join(root, entry), root, label);
    let st;
    try { st = fs.lstatSync(target); } catch { continue; } // vanished mid-run
    if (st.isSymbolicLink()) { skipped += 1; continue; } // never follow symlinks
    const size = treeSize(target);
    if (DRY_RUN) {
      freed.bytes += size;
      freed.entries += 1;
      removed += 1;
      continue;
    }
    if (remove(target)) {
      freed.bytes += size;
      freed.entries += 1;
      removed += 1;
    } else {
      skipped += 1;
    }
  }
  return { removed, skipped };
}

function pruneCacheRoot(label, root, results) {
  const line = `  ${label.padEnd(28)} ${root}`;
  if (!fs.existsSync(root)) {
    results.push(`${line}  — not present`);
    return { bytes: 0, entries: 0 };
  }
  const freed = { bytes: 0, entries: 0 };
  const entries = fs.readdirSync(root);
  const { removed, skipped } = pruneEntries(label, root, entries, freed);
  const parts = [`${mb(freed.bytes)} MB`];
  if (removed) parts.push(`${removed} entries`);
  if (skipped) parts.push(`${skipped} skipped (locked/symlink)`);
  results.push(`  ${label.padEnd(28)} ${root}  ${parts.join(', ')}`);
  return freed;
}

function pruneTempScratch(tmpRoot, results) {
  const label = 'temp scratch (>24h)';
  const freed = { bytes: 0, entries: 0 };
  if (!fs.existsSync(tmpRoot)) {
    results.push(`  ${label.padEnd(28)} ${tmpRoot}  — not present`);
    return freed;
  }
  const now = Date.now();
  const candidates = fs.readdirSync(tmpRoot).filter(name => SCRATCH_PATTERN.test(name));
  const fresh = [];
  const stale = [];
  for (const name of candidates) {
    let st;
    try { st = fs.lstatSync(assertUnder(path.join(tmpRoot, name), tmpRoot, label)); }
    catch { continue; }
    (now - st.mtimeMs > MAX_SCRATCH_AGE_MS ? stale : fresh).push(name);
  }
  pruneEntries(label, tmpRoot, stale, freed);
  const parts = [`${mb(freed.bytes)} MB`];
  if (freed.entries) parts.push(`${freed.entries} entries`);
  if (fresh.length) parts.push(`${fresh.length} fresh (<24h, kept)`);
  results.push(`  ${label.padEnd(28)} ${tmpRoot}  ${parts.join(', ')}`);
  return freed;
}

function main() {
  const home = os.homedir();
  const cacheRoots = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      cacheRoots.push(
        ['electron-builder cache', path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache')],
        ['electron cache', path.join(process.env.LOCALAPPDATA, 'electron', 'Cache')],
      );
    }
  } else {
    cacheRoots.push(
      ['electron cache', path.join(home, '.cache', 'electron')],
      ['electron-builder cache', path.join(home, '.cache', 'electron-builder')],
    );
    if (process.platform === 'darwin') {
      cacheRoots.push(
        ['electron cache (Library)', path.join(home, 'Library', 'Caches', 'electron')],
        ['electron-builder cache (Library)', path.join(home, 'Library', 'Caches', 'electron-builder')],
      );
    }
  }

  console.log(`clean-caches${DRY_RUN ? ' (--dry-run: nothing deleted)' : ''}`);
  const results = [];
  let total = 0;
  for (const [label, root] of cacheRoots) {
    total += pruneCacheRoot(label, root, results).bytes;
  }
  total += pruneTempScratch(os.tmpdir(), results).bytes;
  for (const line of results) console.log(line);
  console.log(`  ${'TOTAL'.padEnd(28)} ${mb(total)} MB${DRY_RUN ? ' would be freed' : ' freed'}`);
}

main();
