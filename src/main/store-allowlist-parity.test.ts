/**
 * Store↔ipc-handlers allowlist parity gate (row 32, code-cleanup audit
 * 2026-10-28).
 *
 * store.ts documents that its `cliConfigRoots()` "mirrors the read allowlist
 * in ipc-handlers `isAllowedReadPath` — the CLI config trees a 'project' must
 * never launder into the git-exec/destructive root set", but nothing checked
 * it: the two lists sit in different files and drift would silently widen or
 * narrow the destructive-root refusals. Static scan in the
 * `ipc-channel-parity.test.ts` idiom (no Electron, no runtime): extract both
 * lists from source and pin the documented delta — `.claude.json` and
 * `.mcp.json` are files, refused by store's directory check, so only the
 * directory trees are listed there.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Source of `fn(...)` up to its column-0 closing brace (inner braces are
 *  indented, so `\n}` only ever matches the function's own end). */
function functionBody(file: string, signature: string): string {
  const text = readFileSync(path.join(HERE, file), 'utf8');
  const start = text.indexOf(signature);
  expect(start, `${signature} not found in ${file}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n}', start);
  expect(end, `${signature} has no column-0 closing brace in ${file}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** `path.join(home, '…')` entries inside a function body. */
function homeEntries(body: string): string[] {
  return [...body.matchAll(/path\.join\(home, '([^']+)'\)/g)].map((m) => m[1]);
}

/** Absolute directories pushed by the platform branches (`push('…')`). */
function platformDirs(body: string): string[] {
  return [...body.matchAll(/push\('([^']+)'\)/g)].map((m) => m[1]);
}

const storeBody = functionBody('store.ts', 'function cliConfigRoots()');
const ipcBody = functionBody('ipc-handlers.ts', 'function isAllowedReadPath');

describe('store.ts ↔ ipc-handlers.ts read-allowlist mirror (row 32)', () => {
  it('scanner floor: both allowlists actually contain entries', () => {
    // A regex that silently matches nothing would turn every assertion green.
    expect(homeEntries(ipcBody).length).toBeGreaterThanOrEqual(4);
    expect(homeEntries(storeBody).length).toBeGreaterThanOrEqual(4);
    expect(platformDirs(ipcBody)).toHaveLength(3);
    expect(platformDirs(storeBody)).toHaveLength(3);
  });

  it('store lists exactly the directory trees ipc-handlers allows', () => {
    const ipc = new Set(homeEntries(ipcBody));
    const store = new Set(homeEntries(storeBody));
    // The documented delta: the two file entries never join store's list
    // (store validates directories only).
    const onlyInIpc = [...store].length === 0 ? [] : [...ipc].filter((e) => !store.has(e));
    expect(onlyInIpc.sort()).toEqual(['.claude.json', '.mcp.json']);
    // And store never lists a tree ipc-handlers does not allow reading.
    expect([...store].filter((e) => !ipc.has(e))).toEqual([]);
  });

  it('the platform ClaudeCode dirs are byte-identical in both files', () => {
    // darwin/win32/linux branches: same three literals in both files, same
    // order. A rename in one file (or a dropped branch) fails here.
    expect(platformDirs(storeBody)).toEqual(platformDirs(ipcBody));
  });
});
