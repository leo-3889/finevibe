/**
 * IPC channel parity gate (architecture audit 2026-10-28, P2).
 *
 * The app crosses the renderer↔main boundary on ~133 string channels: 116
 * `ipcMain.handle`/`on` registrations, 19 main→renderer pushes, and the
 * preload surface that wires them to `window.finevibe`. Nothing checked that
 * the two ends agree, so a renamed channel goes silent at runtime instead of
 * failing a build — the exact class of drift this repo already gates for
 * module-level collections (`module-map-governance.test.ts`).
 *
 * Three invariants, all static (no Electron, no runtime):
 *
 *   A. every channel preload invokes/sends is registered in main;
 *   B. every channel main pushes is listened for in preload;
 *   C. every channel main registers is used by preload (dead-handler detector).
 *
 * Scanner floor assertions guard the failure mode of any static scan: a regex
 * that silently matches nothing would turn all three green.
 */
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push({ file: path.relative(SRC, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

/** Channels main registers (`ipcMain.handle` / `ipcMain.on` / `ipcMain.once`). */
function collectRegistered(files: Array<{ file: string; text: string }>): Map<string, string> {
  const found = new Map<string, string>();
  for (const { file, text } of files) {
    for (const m of text.matchAll(/ipcMain\.(?:handle|on|once)\(\s*'([^']+)'/g)) found.set(m[1], file);
  }
  return found;
}

/** Channels main pushes (any `webContents.send('channel', …)` / `send('channel', …)`). */
function collectPushed(files: Array<{ file: string; text: string }>): Map<string, string> {
  const found = new Map<string, string>();
  for (const { file, text } of files) {
    for (const m of text.matchAll(/\.send\(\s*'([^']+)'/g)) found.set(m[1], file);
  }
  return found;
}

const mainFiles = sources(path.join(SRC, 'main'));
const preloadFiles = sources(path.join(SRC, 'preload'));

const registered = collectRegistered(mainFiles);
const pushed = collectPushed(mainFiles);

const invoked = new Map<string, string>();
const sent = new Map<string, string>();
const listened = new Map<string, string>();
for (const { file, text } of preloadFiles) {
  for (const m of text.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)) invoked.set(m[1], file);
  for (const m of text.matchAll(/ipcRenderer\.send(?:Sync)?\(\s*'([^']+)'/g)) sent.set(m[1], file);
  // Preload wraps listeners in `onChannel('x', …)`; the raw form appears in the
  // webview guest preload.
  for (const m of text.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)) listened.set(m[1], file);
  for (const m of text.matchAll(/onChannel\(\s*'([^']+)'/g)) listened.set(m[1], file);
}

/**
 * Channels registered from a variable (not a string literal), so the scanner
 * cannot see them. Each entry names the registration site.
 */
const DYNAMIC_HANDLERS = new Map<string, string>([
  ['settings:conflictDialogResponse', 'main/settings-guard.ts registers it with ipcMain.once(channel)'],
]);

describe('IPC channel parity (preload ↔ main)', () => {
  it('the scanners see the boundary (floor guards a silent regex miss)', () => {
    expect(registered.size).toBeGreaterThanOrEqual(100);
    expect(pushed.size).toBeGreaterThanOrEqual(15);
    expect(invoked.size).toBeGreaterThanOrEqual(90);
    expect(listened.size).toBeGreaterThanOrEqual(30);
  });

  it('A: every channel preload invokes or sends is registered in main', () => {
    const orphaned = [...invoked.keys()]
      .filter((ch) => !registered.has(ch))
      .map((ch) => `${ch} (invoke ← ${invoked.get(ch)})`)
      .concat(
        [...sent.keys()]
          .filter((ch) => !registered.has(ch) && !DYNAMIC_HANDLERS.has(ch))
          .map((ch) => `${ch} (send ← ${sent.get(ch)})`),
      );
    expect(orphaned, `channels preload calls with no ipcMain registration:\n  ${orphaned.join('\n  ')}`).toEqual([]);
  });

  it('B: every channel main pushes is listened for in preload', () => {
    const unlistened = [...pushed.keys()]
      .filter((ch) => !listened.has(ch))
      .map((ch) => `${ch} (push ← ${pushed.get(ch)})`);
    expect(unlistened, `channels main sends that no preload listener receives:\n  ${unlistened.join('\n  ')}`).toEqual([]);
  });

  it('C: every channel main registers is used by preload (no dead handlers)', () => {
    const dead = [...registered.keys()]
      .filter((ch) => !invoked.has(ch) && !sent.has(ch) && !listened.has(ch))
      .map((ch) => `${ch} (registered in ${registered.get(ch)})`);
    expect(dead, `main handlers nothing in preload ever calls:\n  ${dead.join('\n  ')}`).toEqual([]);
  });
});
