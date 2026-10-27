/**
 * B3 — bounded-map governance gate.
 *
 * Every module-level `Map`/`Set` in src/main is process-lifetime: a key added
 * and never dropped is a leak that outlives every session. This test scans the
 * whole of src/main (excluding *.test.ts) for zero-indent collection
 * declarations and fails on any `Name@path` not present in ALLOWLIST below.
 *
 * The gate's contract: a NEW module-level Map/Set fails this test until a
 * reviewer adds it to ALLOWLIST with a bound-class annotation, one of:
 *
 *   capped:<CONST>            — an exported/declared cap constant evicts (LRU
 *                               or FIFO; the fs-utils.ts idiom).
 *   teardown                  — keyed by session/pane/root/etc.; every key is
 *                               dropped on exit/destroy/stop (grouped below
 *                               by the teardown owner).
 *   transient                 — in-flight promise / one-shot marker maps whose
 *                               keys are deleted by the operation itself.
 *   bounded-by-construction   — keys can only come from a small fixed set
 *                               (extension lists, provider registries, a
 *                               string-literal union).
 *
 * Scanner contract (see scanModuleCollections): declarations are flagged only
 * at ZERO indentation at line start, which is what keeps function bodies,
 * comment text and template-literal content out of the hits.
 */
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Zero-indent `const|let|var NAME[: Type] = new Map/Set[<...>](`.
 * `[^\n]*\(` after `\b` absorbs generic type arguments (`new Map<string,
 * Map<string, number>>()`), and the word boundary keeps look-alikes
 * (`new MongoClient()`, `new SetUp()`) out. `export const` is NOT matched:
 * the contract is exactly the zero-indent `const|let|var` line start.
 */
export function scanModuleCollections(source: string): string[] {
  const hits: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const m = /^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*new\s+(Map|Set)\b[^\n]*\(/.exec(line);
    if (m) hits.push(m[1]);
  }
  return hits;
}

const MAIN_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Every non-test .ts under src/main, as `Name@src/main-relative/path` keys. */
export function scanTree(root: string): string[] {
  const keys: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        for (const name of scanModuleCollections(readFileSync(p, 'utf8'))) {
          keys.push(`${name}@${path.relative(root, p).replaceAll('\\', '/')}`);
        }
      }
    }
  };
  walk(root);
  return keys;
}

// Reviewed on 2026-10-23 against the tree of that date (46 entries).
// Adding an entry here IS the review step of the gate; the annotation must
// name the bound class and, for `capped`, the constant that enforces it.
const ALLOWLIST: Record<string, string> = {
  // capped: explicit constant + eviction (LRU/FIFO).
  'assignedCodexIds@codex-session-watcher.ts': 'capped:MAX_ASSIGNED_IDS (FIFO evict oldest handed-out id)',
  'metaCache@codex-session-watcher.ts': 'capped:MAX_META_CACHE_ENTRIES (rollout meta LRU)',
  'targetCanonicalCache@fs-utils.ts': 'capped:TARGET_CANONICAL_CACHE_MAX (LRU + TTL)',
  'metaCache@launch-session-dir.ts': 'capped:META_CACHE_MAX (FIFO evict oldest dir meta)',
  'gitWatchedRoots@ipc-handlers.ts': 'capped:MAX_GIT_WATCHED_ROOTS (FIFO evict oldest root)',
  'foldsCaseByDir@settings-guard.ts': 'capped:FOLDS_CASE_BY_DIR_MAX (FIFO evict oldest probed dir)',
  'statusTailCache@providers/pi-compatible-transcripts.ts': 'capped:MAX_STATUS_TAIL_CACHE (FIFO evict oldest tail)',
  'textCache@session-deep-search.ts': 'capped:MAX_CACHE_ENTRIES + MAX_CACHE_CHARS (LRU evict oldest)',
  'gateRootCanonicalByPath@store.ts': 'capped:GATE_ROOT_CANONICAL_MAX (FIFO, PA-08 memo)',
  'connections@hosts/ssh-client.ts': 'capped:MAX_CACHED_CONNECTIONS (FIFO evict oldest ssh2 client; closeConnection drops per host)',

  // teardown: cleared on watcher/file stop, session exit, store invalidate,
  // provider stop and app shutdown — every key has an owner-side drop.
  'pendingSessions@codex-session-watcher.ts': 'teardown: deleted on match/abandon; watcher stop drains',
  'dateDirWatchers@codex-session-watcher.ts': 'teardown: closed + cleared in stopCodexSessionWatcher',
  'installedHookFiles@copilot-hooks.ts': 'teardown: quit cleanup unlinks and clears every recorded hook file',
  'refCounts@file-watcher.ts': 'teardown: drops to zero per unwatch; cleared in stopAllFileWatchers',
  'pending@file-watcher.ts': 'teardown: drained on every flush; cleared in stopAllFileWatchers',
  'rootCanonicalCache@fs-utils.ts': 'capped:ROOT_CANONICAL_CACHE_MAX (LRU; roots also dropped by invalidateCanonicalPathCache)',
  'gitChangedListeners@git-watcher.ts': 'teardown: unsubscribe closure deletes the listener',
  'lastMtimes@hook-status.ts': 'teardown: unregisterSession + stop clear; sweep drops vanished files',
  'eventReaders@hook-status.ts': 'teardown: cleared on stopHookStatus',
  'eventContinuations@hook-status.ts': 'teardown: cleared on stopHookStatus',
  'knownSessionIds@hook-status.ts': 'teardown: unregisterSession deletes; stop clears',
  'remoteStatuses@hook-status.ts': 'teardown: unregisterSession deletes; cleanupAll clears (keyed by session, bounded by knownSessionIds)',
  'remoteHostCooldown@hook-status.ts': 'capped:32 FIFO (REMOTE_HOST_COOLDOWN_MAX); cleanupAll clears',
  'outsideHomeConsent@ipc-handlers.ts': 'capped:OUTSIDE_HOME_CONSENT_MAX (FIFO evict oldest consent answer)',
  'enumerateCache@ipc-handlers.ts': 'capped:ENUMERATE_CACHE_MAX (LRU + TTL; cleared by invalidateEnumerations)',
  'topFilesCache@ipc-handlers.ts': 'capped:TOP_FILES_CACHE_MAX (LRU + TTL; cleared by invalidateEnumerations)',
  'protectedLaunchDirs@launch-session-dir.ts': 'teardown: one dir per launch this process; lives for the process (documented)',
  'connections@mcp-client.ts': 'teardown: deleted when the connection closes; cleared on shutdown',
  'launchStates@providers/omp-provider.ts': 'teardown: deleted on session exit; cleared on provider stop',
  'launchStates@providers/pi-provider.ts': 'teardown: deleted on session exit; cleared on provider stop',
  'launchStates@providers/pi-bolt-provider.ts': 'teardown: deleted on session exit; cleared on provider stop',
  'ptys@pty-manager.ts': 'teardown: deleted on PTY exit/kill',
  'spawningInFlight@pty-manager.ts': 'teardown: spawnPty finally owns the delete',
  'entries@session-transcript-sync.ts': 'teardown: deleted per pane stop; cleared on stopAll',
  'profileInstallMemo@settings-guard.ts': 'teardown: per-profile mtime memo; cleared on consent/settings reset',

  // transient: keys mark work in flight and are deleted by the work itself.
  'REMOTE_WALK_IGNORE@hosts/remote-fs.ts': 'bounded-by-construction: const walk ignore-set, never mutated',
  'watches@hosts/remote-watch.ts': 'capped:MAX_REMOTE_WATCHES (FIFO evict oldest poll)',
  'fullDecodes@codex-session-watcher.ts': 'transient: decode in flight; deleted in finally',
  'outsideHomeConsentInFlight@ipc-handlers.ts': 'transient: shared dialog promise; deleted on settle',
  'enumerateInFlight@ipc-handlers.ts': 'transient: shared walk promise; deleted by its owner run',
  'topFilesScans@ipc-handlers.ts': 'transient: shared scan promise; deleted on settle',
  'pendingKills@pty-manager.ts': 'transient: spawn-completion marker; consumed on spawn (inline 100 safety cap)',
  'inFlight@session-deep-search.ts': 'transient: shared read promise; deleted on settle',
  'toolRefreshInFlight@hosts/enrollment.ts': 'transient: shared host tool-refresh promise; key deleted when the probe settles',

  // bounded-by-construction: keys can only come from a small fixed set.
  'MAC_PACKAGE_EXTENSIONS@fs-utils.ts': 'bounded-by-construction: fixed extension list',
  'IGNORE_SEGMENTS@git-watcher.ts': 'bounded-by-construction: fixed segment list',
  'SESSION_ID_ENV_KEYS@pty-manager.ts': 'bounded-by-construction: two literal env key names',
  'GIT_DIR_FILES@git-watcher.ts': 'bounded-by-construction: fixed file list',
  'prunedBases@launch-session-dir.ts': 'bounded-by-construction: one add per project base, sweep-once marker',
  'states@log-throttle.ts': 'bounded-by-construction: keyed by the 4-member ConsoleMethodName union',
  'providers@providers/registry.ts': 'bounded-by-construction: the fixed provider registry',
  'probeCache@providers/resolve-binary.ts': 'bounded-by-construction: keyed by known CLI binary names; TTL + invalidateBinaryCache',
  'TEXT_EXTENSIONS@readiness/checkers/context-optimization.ts': 'bounded-by-construction: fixed extension list',
  'lastPruneAt@session-deep-search.ts': 'bounded-by-construction: keyed by provider id (fixed set)',
};

describe('module-level Map/Set governance (B3)', () => {
  // The scanner is pure text analysis; its fixtures are the gate's own unit
  // tests. A new collection at zero indent MUST be flagged.
  describe('scanner', () => {
    it('flags a new module-level Map at zero indentation', () => {
      expect(scanModuleCollections('const NEWMAP = new Map();\n')).toEqual(['NEWMAP']);
    });

    it('flags generic instantiations and nested generics', () => {
      expect(scanModuleCollections('const s = new Set<string>();\n')).toEqual(['s']);
      expect(scanModuleCollections('const m = new Map<string, { at: number; files: string[] }>();\n')).toEqual(['m']);
      expect(scanModuleCollections('const n = new Map<string, Map<string, number>>();\n')).toEqual(['n']);
    });

    it('flags type-annotated declarations and let/var', () => {
      expect(scanModuleCollections('const t: Map<string, string> = new Map();\n')).toEqual(['t']);
      expect(scanModuleCollections('let inflight: Promise<string> | null = null;\nvar seen = new Set();\n')).toEqual(['seen']);
    });

    it('ignores indented declarations (function bodies, object literals, classes)', () => {
      const src = [
        'function f() {',
        '  const inner = new Map();',
        '  return inner;',
        '}',
        'class C {',
        '  handlers = new Map<string, number>();',
        '}',
        '  const alsoIndented = new Set([1]);',
      ].join('\n');
      expect(scanModuleCollections(src)).toEqual([]);
    });

    it('ignores comments and template-literal content', () => {
      const src = [
        '// const COMMENTED = new Map();',
        '/* const BLOCKED = new Set(); */',
        ' * const JSDOC = new Map<string, string>();',
        'const TEMPLATE = `',
        '  const INSIDE_TEMPLATE = new Map();',
        '`;',
      ].join('\n');
      // The zero-indent rule is the prescribed defense: template content is
      // indented in every source here, so column-0 declarations are all the
      // scanner ever sees.
      expect(scanModuleCollections(src)).toEqual([]);
    });

    it('ignores collection look-alikes and non-collection constructors', () => {
      const src = [
        'const client = new MongoClient();',
        'const up = new SetUp();',
        'const emitter = new EventEmitter();',
        'const mapper = new Mapper(map);',
      ].join('\n');
      expect(scanModuleCollections(src)).toEqual([]);
    });

    it('is scoped to zero-indent const|let|var (export const is out of contract)', () => {
      expect(scanModuleCollections('export const SHARED = new Map<string, string>();\n')).toEqual([]);
    });
  });

  describe('allowlist', () => {
    it('annotations name a bound class', () => {
      for (const [key, note] of Object.entries(ALLOWLIST)) {
        expect(note, key).toMatch(/^(capped:[A-Z0-9_]+|teardown|transient|bounded-by-construction)(:|\s|\()/);
      }
    });
  });

  it('every module-level Map/Set in src/main is reviewed with a bound class', () => {
    const found = scanTree(MAIN_ROOT);
    const unreviewed = found.filter((k) => !(k in ALLOWLIST)).sort();
    // A stale allowlist entry means the collection was renamed/removed; the
    // review record must stay accurate, so fail this too.
    const stale = Object.keys(ALLOWLIST).filter((k) => !found.includes(k)).sort();
    expect(unreviewed, `New module-level Map/Set without a bound-class allowlist entry:\n  ${unreviewed.join('\n  ')}`).toEqual([]);
    expect(stale, `Allowlist entries no longer present in src/main:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
