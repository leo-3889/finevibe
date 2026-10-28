/**
 * Row 22: the preload bundle was in the coverage map at 0.0% — nothing in the
 * suite imported it, so the renderer's ONLY path to main had no runtime
 * evidence (the static `ipc-channel-parity.test.ts` compares channel *names*
 * between main and preload; it cannot see argument order, the `|| 'claude'`
 * normalizations, the zoom clamp, or a listener that never unsubscribes).
 *
 * This file imports the real preload with a stubbed `electron`, captures what
 * `contextBridge.exposeInMainWorld` received, and then walks EVERY function of
 * the exposed bridge, calling it with unique sentinels. Each function must
 * make exactly one IPC call, on a `domain:verb` channel, carrying the sentinels
 * in order — so a renamed channel, a dropped argument, a swapped argument
 * order, or a listener whose unsubscribe leaks fails here, on any host.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { kind: 'invoke' | 'send' | 'sendSync' | 'on'; channel: string; args: unknown[] };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  exposed: new Map<string, unknown>(),
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  zoomFactor: 0,
  sendSyncReply: 'SENDSYNC_RESULT' as unknown,
  pathForFile: 'C:\\dropped\\file.txt',
  removeListener: (_channel: string, _listener: unknown) => {},
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      state.exposed.set(key, value);
    },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => {
      state.calls.push({ kind: 'invoke', channel: String(args[0]), args: args.slice(1) });
      return Promise.resolve('INVOKE_RESULT');
    },
    send: (...args: unknown[]) => {
      state.calls.push({ kind: 'send', channel: String(args[0]), args: args.slice(1) });
    },
    // The two sync round-trips (`store:save-sync`, the prefs read) block the
    // renderer and answer synchronously — a distinct contract from invoke/send,
    // so it gets its own kind and its own return value.
    sendSync: (...args: unknown[]) => {
      state.calls.push({ kind: 'sendSync', channel: String(args[0]), args: args.slice(1) });
      return state.sendSyncReply;
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      state.calls.push({ kind: 'on', channel, args: [] });
      const set = state.listeners.get(channel) ?? new Set();
      set.add(listener);
      state.listeners.set(channel, set);
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      state.listeners.get(channel)?.delete(listener);
      state.removeListener(channel, listener);
    },
  },
  webFrame: {
    setZoomFactor: (factor: number) => {
      state.zoomFactor = factor;
    },
  },
  webUtils: {
    getPathForFile: () => state.pathForFile,
  },
}));

const BRIDGE_KEY = 'finevibe';

async function loadBridge(): Promise<Record<string, Record<string, unknown>>> {
  vi.resetModules();
  state.calls = [];
  state.exposed.clear();
  state.listeners.clear();
  await import('./preload');
  const api = state.exposed.get(BRIDGE_KEY);
  if (!api || typeof api !== 'object') throw new Error(`preload exposed no "${BRIDGE_KEY}" object`);
  return api as Record<string, Record<string, unknown>>;
}

/** Every `namespace.method` pair the bridge exposes. */
function bridgeMethods(api: Record<string, Record<string, unknown>>): Array<[string, () => unknown]> {
  const out: Array<[string, () => unknown]> = [];
  for (const [ns, group] of Object.entries(api)) {
    for (const [name, fn] of Object.entries(group)) {
      if (typeof fn === 'function') out.push([`${ns}.${name}`, fn as () => unknown]);
    }
  }
  return out;
}

// Methods that reach Electron objects instead of an IPC channel.
const NON_IPC_METHODS = new Set(['fs.getDroppedFilePath', 'zoom.set']);
// Methods that translate main's reply instead of handing it back verbatim.
// `store.saveSync` returns `sendSync(...) === true` — a strict flush
// acknowledgement, so it gets its own test below.
const ENVELOPE_METHODS = new Set(['store.saveSync']);

describe('preload bridge (row 22)', () => {
  beforeEach(() => {
    state.calls = [];
    state.zoomFactor = 0;
    state.removeListener = vi.fn();
  });

  it('exposes the bridge and the clipboard-timing flag on the main world', async () => {
    await loadBridge();
    expect([...state.exposed.keys()].sort()).toEqual([
      '__FINEVIBE_CLIPBOARD_TIMING__',
      BRIDGE_KEY,
    ]);
    // The renderer's sandboxed world has no process.env, so this global is the
    // only forwarding path for FINEVIBE_CLIPBOARD_TIMING=1.
    expect(state.exposed.get('__FINEVIBE_CLIPBOARD_TIMING__')).toBe(
      process.env.FINEVIBE_CLIPBOARD_TIMING === '1',
    );
  });

  it('every bridge method makes exactly one IPC call on a domain:verb channel', async () => {
    const api = await loadBridge();
    const methods = bridgeMethods(api);
    expect(methods.length).toBeGreaterThan(100); // the whole surface, not a sample

    const offenders: string[] = [];
    for (const [path, fn] of methods) {
      if (NON_IPC_METHODS.has(path)) continue;
      state.calls = [];
      const arity = fn.length;
      const sentinels = Array.from({ length: arity }, (_, i) => `${path}#${i}`);
      // `invoke` resolves; a rejected/throwing method body is a real defect.
      await Promise.resolve((fn as (...a: unknown[]) => unknown)(...sentinels));
      const ipc = state.calls.filter((call) => call.kind !== 'on');      const subs = state.calls.filter((call) => call.kind === 'on');
      const total = ipc.length + subs.length;
      if (total !== 1) {
        offenders.push(`${path}: ${total} IPC calls (expected 1)`);
        continue;
      }
      const channel = (ipc[0] ?? subs[0])!.channel;
      if (!/^[a-z][\w-]*:[\w-]+$/.test(channel)) offenders.push(`${path}: channel "${channel}"`);
    }
    expect(offenders).toEqual([]);
  });

  it('passes every argument through in order, including the normalized defaults', async () => {
    const api = await loadBridge();
    const offenders: string[] = [];
    for (const [path, fn] of bridgeMethods(api)) {
      if (NON_IPC_METHODS.has(path)) continue;
      state.calls = [];
      const sentinels = Array.from({ length: fn.length }, (_, i) => `${path}#${i}`);
      await Promise.resolve((fn as (...a: unknown[]) => unknown)(...sentinels));
      const call = state.calls.find((c) => c.kind !== 'on');
      if (!call) continue; // listener-only method, covered by the unsubscribe test
      // Every sentinel must appear, in the order given. Extra entries are the
      // documented normalizations (`extraArgs || ''`, `providerId || 'claude'`).
      let cursor = 0;
      for (const sentinel of sentinels) {
        const at = call.args.indexOf(sentinel, cursor);
        if (at === -1) {
          offenders.push(`${path}: "${sentinel}" missing from ${call.channel}(${JSON.stringify(call.args)})`);
          break;
        }
        cursor = at + 1;
      }
    }
    expect(offenders).toEqual([]);
  });

  it('hands main\'s answer straight back (invoke promises, sendSync values)', async () => {
    const api = await loadBridge();
    const offenders: string[] = [];
    for (const [path, fn] of bridgeMethods(api)) {
      if (NON_IPC_METHODS.has(path) || ENVELOPE_METHODS.has(path)) continue;
      state.calls = [];
      const sentinels = Array.from({ length: fn.length }, (_, i) => `${path}#${i}`);
      const result = await Promise.resolve((fn as (...a: unknown[]) => unknown)(...sentinels));
      const kind = state.calls[0]?.kind;
      if (kind === 'invoke' && result !== 'INVOKE_RESULT') offenders.push(`${path}: returned ${String(result)}`);
      if (kind === 'sendSync' && result !== 'SENDSYNC_RESULT') offenders.push(`${path}: sync returned ${String(result)}`);
      if (kind === 'send' && result !== undefined) offenders.push(`${path}: fire-and-forget returned ${String(result)}`);
      // A subscription method's contract IS the unsubscribe closure.
      if (kind === 'on' && typeof result !== 'function') {
        offenders.push(`${path}: listener returned ${typeof result}, expected an unsubscribe function`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every listener subscribes to a channel and its unsubscribe detaches it', async () => {
    const api = await loadBridge();
    const offenders: string[] = [];
    let checked = 0;
    for (const [path, fn] of bridgeMethods(api)) {
      if (NON_IPC_METHODS.has(path)) continue;
      state.calls = [];
      const callback = vi.fn();
      const unsub = (fn as (cb: unknown) => unknown)(callback);
      const sub = state.calls.find((c) => c.kind === 'on');
      if (!sub) continue; // not a listener method
      checked += 1;
      if (typeof unsub !== 'function') {
        offenders.push(`${path}: unsubscribe is ${typeof unsub}`);
        continue;
      }
      const set = state.listeners.get(sub.channel) ?? new Set();
      if (set.size !== 1) offenders.push(`${path}: ${set.size} listeners on ${sub.channel}`);
      const [listener] = [...set];
      (listener as (e: unknown, ...a: unknown[]) => void)({} as never, 'p1', 'p2');
      // The payload must reach the renderer callback (the `(x as T) || ''`
      // adapters are part of the contract; the values must survive).
      const flat = callback.mock.calls.flat();
      if (!flat.includes('p1')) offenders.push(`${path}: payload did not reach the callback`);
      const removeSpy = vi.fn();
      state.removeListener = removeSpy;
      (unsub as () => void)();
      if (!removeSpy.mock.calls.some(([c]) => c === sub.channel)) {
        offenders.push(`${path}: unsubscribe did not remove ${sub.channel}`);
      }
      if ((state.listeners.get(sub.channel) ?? new Set()).size !== 0) {
        offenders.push(`${path}: listener still attached after unsubscribe`);
      }
    }
    expect(checked).toBeGreaterThan(20); // the 30 onChannel surfaces are exercised
    expect(offenders).toEqual([]);
  });

  it('store.saveSync is a strict `=== true` flush acknowledgement (S1-03)', async () => {
    const api = await loadBridge();
    const saveSync = api.store!.saveSync as (s: unknown) => boolean;
    // The renderer flushes on beforeunload and must not treat a partial answer
    // as a completed write: only main's literal `true` means the state is on disk.
    state.sendSyncReply = true;
    expect(saveSync({ projects: [] })).toBe(true);
    state.sendSyncReply = false;
    expect(saveSync({ projects: [] })).toBe(false);
    // Torn-down renderer: sendSync answers undefined. An object reply (an {ok}
    // envelope, say) is not an acknowledgement either.
    state.sendSyncReply = undefined;
    expect(saveSync({ projects: [] })).toBe(false);
    state.sendSyncReply = { ok: true };
    expect(saveSync({ projects: [] })).toBe(false);
    expect(state.calls.map((c) => c.channel)).toEqual(Array(4).fill('store:save-sync'));
    expect(state.calls.every((c) => c.kind === 'sendSync')).toBe(true);
    // The sync read on the same channel family hands main's reply back verbatim
    // (theme/zoom are needed before the first paint).
    state.sendSyncReply = 'SENDSYNC_RESULT';
    expect((api.store!.startupPrefs as () => unknown)()).toBe('SENDSYNC_RESULT');
  });

  it('clamps zoom to the duplicated ZOOM_MIN/ZOOM_MAX contract', async () => {
    const api = await loadBridge();
    const zoom = api.zoom!.set as (factor: number) => void;
    zoom(1.0);
    expect(state.zoomFactor).toBe(1.0);
    zoom(5);
    expect(state.zoomFactor).toBe(2.0); // ZOOM_MAX, mirrored in preload.ts
    zoom(0.1);
    expect(state.zoomFactor).toBe(0.75); // ZOOM_MIN
  });

  it('fs.getDroppedFilePath goes through webUtils, not IPC', async () => {
    const api = await loadBridge();
    state.calls = [];
    const got = (api.fs!.getDroppedFilePath as (f: unknown) => string)({ name: 'file.txt' });
    expect(got).toBe(state.pathForFile);
    expect(state.calls).toEqual([]);
  });
});
