// Tests for the PTY-output SSH scanner (todos/ssh-session-name-prefix-plan.md
// §8 "Main: ssh-detect.test.ts"). The sidecar write is mocked so the pure
// detection logic and its publish contract are tested without electron/fs.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./hook-status', () => ({
  writeSshStatus: vi.fn(),
}));

import { writeSshStatus } from './hook-status';
import {
  observePtyOutput,
  _resetSshDetectForTesting,
  MAX_SSH_SCAN_SESSIONS,
  DETECTED_SSH_TTL_MS,
} from './ssh-detect';

const write = vi.mocked(writeSshStatus);

const T0 = 1_700_000_000_000;
const SEC = 1000;

beforeEach(() => {
  _resetSshDetectForTesting();
  write.mockClear();
});

describe('observePtyOutput — command echo detection', () => {
  it('connects on a line-start ssh echo and writes the sidecar', () => {
    const r = observePtyOutput('s1', 'ssh lab.example.com\r\n', T0);
    expect(r).toEqual({ host: 'lab.example.com' });
    expect(write).toHaveBeenCalledWith('s1', 'lab.example.com', 'detected');
  });

  it('detects the echo after a shell prompt on the same line', () => {
    const r = observePtyOutput('s1', 'user@local:~ $ ssh lab\r\n', T0);
    expect(r).toEqual({ host: 'lab' });
  });

  it('normalizes user@host from the echo', () => {
    const r = observePtyOutput('s1', 'ssh root@lab\r\n', T0);
    expect(r).toEqual({ host: 'root@lab' });
  });

  it('consumes `-p 2221` as a flag pair instead of reading the port as host', () => {
    const r = observePtyOutput('s1', 'ssh -p 2221 lab\r\n', T0);
    expect(r).toEqual({ host: 'lab' });
  });

  it('skips single-token flags like -oProxyCommand=x', () => {
    const r = observePtyOutput('s1', 'ssh -oProxyCommand=x lab\r\n', T0);
    expect(r).toEqual({ host: 'lab' });
  });

  it('never publishes a port suffix (ssh lab:22)', () => {
    const r = observePtyOutput('s1', 'ssh lab:22\r\n', T0);
    expect(r).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('never publishes a host parseSshHost rejects (ssh ..)', () => {
    const r = observePtyOutput('s1', 'ssh ..\r\n', T0);
    expect(r).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('joins an echo split across two chunks', () => {
    expect(observePtyOutput('s1', 'ss', T0)).toBeNull();
    const r = observePtyOutput('s1', 'h lab\r\n', T0 + SEC);
    expect(r).toEqual({ host: 'lab' });
  });

  it('does not rewrite the sidecar when the same host echoes again', () => {
    observePtyOutput('s1', 'ssh lab\r\n', T0);
    write.mockClear();
    expect(observePtyOutput('s1', 'ssh lab\r\n', T0 + 5 * SEC)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('republishes on a nested ssh (last host wins)', () => {
    observePtyOutput('s1', 'ssh lab\r\n', T0);
    const r = observePtyOutput('s1', 'ssh other\r\n', T0 + 5 * SEC);
    expect(r).toEqual({ host: 'other' });
  });
});

describe('observePtyOutput — OSC title', () => {
  it('corroborates a matching title without republishing', () => {
    observePtyOutput('s1', 'ssh root@lab\r\n', T0);
    write.mockClear();
    const r = observePtyOutput('s1', '\x1b]0;root@lab:~\x07', T0 + 2 * SEC);
    expect(r).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('ignores a mismatching title inside the corroboration window', () => {
    observePtyOutput('s1', 'ssh root@lab\r\n', T0);
    // Local title still up (remote shell has not printed yet) — not a
    // disconnect while the echo is fresh.
    const r = observePtyOutput('s1', '\x1b]0;user@local:~\x07', T0 + 2 * SEC);
    expect(r).toBeNull();
  });

  it('disconnects when a different title returns after the window', () => {
    observePtyOutput('s1', 'ssh root@lab\r\n', T0);
    const r = observePtyOutput('s1', '\x1b]0;user@local:~\x07', T0 + 30 * SEC);
    expect(r).toEqual({ host: null });
    expect(write).toHaveBeenCalledWith('s1', null, 'detected');
  });

  it('disconnects on a plain dir title (no user@host) after the window', () => {
    observePtyOutput('s1', 'ssh root@lab\r\n', T0);
    const r = observePtyOutput('s1', '\x1b]0;~/project\x07', T0 + 30 * SEC);
    expect(r).toEqual({ host: null });
  });

  it('ignores titles while not connected', () => {
    const r = observePtyOutput('s1', '\x1b]0;user@local:~\x07', T0);
    expect(r).toBeNull();
  });
});

describe('observePtyOutput — TTL and eviction', () => {
  it('drops a connection whose evidence is older than the TTL', () => {
    observePtyOutput('s1', 'ssh lab\r\n', T0);
    const r = observePtyOutput('s1', 'echo hi\r\n', T0 + DETECTED_SSH_TTL_MS + SEC);
    expect(r).toEqual({ host: null });
  });

  it('keeps a connection whose evidence is inside the TTL', () => {
    observePtyOutput('s1', 'ssh lab\r\n', T0);
    const r = observePtyOutput('s1', 'echo hi\r\n', T0 + DETECTED_SSH_TTL_MS - SEC);
    expect(r).toBeNull();
  });

  it('evicts the oldest session past MAX_SSH_SCAN_SESSIONS', () => {
    for (let i = 0; i < MAX_SSH_SCAN_SESSIONS + 1; i++) {
      observePtyOutput(`s${i}`, `ssh h${i}\r\n`, T0);
    }
    // s0 was evicted; its echo now reads as a fresh connect instead of a no-op.
    write.mockClear();
    const r = observePtyOutput('s0', 'ssh h0\r\n', T0 + SEC);
    expect(r).toEqual({ host: 'h0' });
    expect(write).toHaveBeenCalledWith('s0', 'h0', 'detected');
  });
});
