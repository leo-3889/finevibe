import { beforeEach, describe, expect, it } from 'vitest';
import {
  setSshStatus,
  getSshStatus,
  removeSshSession,
  onSshChange,
  _resetSshForTesting,
  type SshState,
} from './session-ssh';

const explicit: SshState = { host: 'lab.example.com', source: 'explicit' };
const spawned: SshState = { host: 'built.example.com', source: 'spawned' };
const detected: SshState = { host: 'tunnel.example.com', source: 'detected' };

describe('session-ssh registry', () => {
  beforeEach(() => _resetSshForTesting());

  it('stores and returns live state', () => {
    expect(getSshStatus('s1')).toBeNull();
    setSshStatus('s1', explicit);
    expect(getSshStatus('s1')).toEqual(explicit);
  });

  it('a weaker source never overwrites a stronger one', () => {
    setSshStatus('s1', explicit);
    setSshStatus('s1', detected);
    expect(getSshStatus('s1')).toEqual(explicit);
    setSshStatus('s1', spawned);
    expect(getSshStatus('s1')).toEqual(explicit);
  });

  it('detected applies only while no stronger state exists; spawned beats detected', () => {
    setSshStatus('s1', detected);
    expect(getSshStatus('s1')).toEqual(detected);
    setSshStatus('s1', spawned);
    expect(getSshStatus('s1')).toEqual(spawned);
    setSshStatus('s1', detected);
    expect(getSshStatus('s1')).toEqual(spawned);
  });

  it('equal source overwrites on host change; identical write is a no-op', () => {
    const seen: Array<[string, SshState | null]> = [];
    onSshChange((sid, st) => seen.push([sid, st]));
    setSshStatus('s1', { host: 'a', source: 'detected' });
    setSshStatus('s1', { host: 'a', source: 'detected' });
    expect(seen).toHaveLength(1);
    setSshStatus('s1', { host: 'b', source: 'detected' });
    expect(seen).toHaveLength(2);
    expect(getSshStatus('s1')?.host).toBe('b');
  });

  it('disconnect clears and notifies once; second disconnect is silent', () => {
    const seen: Array<[string, SshState | null]> = [];
    onSshChange((sid, st) => seen.push([sid, st]));
    setSshStatus('s1', explicit);
    removeSshSession('s1');
    expect(getSshStatus('s1')).toBeNull();
    expect(seen[1]).toEqual(['s1', null]);
    removeSshSession('s1');
    expect(seen).toHaveLength(2);
  });

  it('unsubscribe removes the listener', () => {
    let calls = 0;
    const off = onSshChange(() => calls++);
    setSshStatus('s1', explicit);
    off();
    setSshStatus('s2', explicit);
    expect(calls).toBe(1);
  });
});
