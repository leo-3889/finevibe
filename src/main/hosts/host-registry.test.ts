import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '../../shared/types';

const state = { hosts: [] as HostRecord[] };
const saveState = vi.fn();

vi.mock('../store', () => ({
  loadState: () => state,
  saveState: () => saveState(),
}));
vi.mock('./secrets', () => ({ deleteHostSecret: vi.fn() }));
vi.mock('./ssh-client', () => ({ closeConnection: vi.fn() }));

import { HostValidationError, createHost, deleteHost, getHost, listHosts, setEnrollmentStatus, updateHost } from './host-registry';

const DRAFT = {
  name: 'strix',
  user: 'dev',
  host: '192.168.2.242',
  port: 22,
  authKind: 'password',
  managedKey: false,
  enrollmentStatus: 'draft',
};

beforeEach(() => {
  state.hosts = [];
  saveState.mockClear();
});

describe('createHost', () => {
  it('generates an id, validates, persists', () => {
    const rec = createHost(DRAFT);
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.name).toBe('strix');
    expect(state.hosts).toHaveLength(1);
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('defaults the port to 22 and trims the name', () => {
    const rec = createHost({ ...DRAFT, port: undefined, name: '  strix ' });
    expect(rec.port).toBe(22);
    expect(rec.name).toBe('strix');
  });

  it('rejects invalid drafts', () => {
    expect(() => createHost(null)).toThrow(HostValidationError);
    expect(() => createHost({ ...DRAFT, host: '-oProxyCommand=evil' })).toThrow(HostValidationError);
    expect(() => createHost({ ...DRAFT, port: 99999 })).toThrow(HostValidationError);
    expect(state.hosts).toHaveLength(0);
  });

  it('rejects duplicate ids', () => {
    const rec = createHost(DRAFT);
    expect(() => createHost({ ...DRAFT, id: rec.id })).toThrow(/already exists/);
  });
});

describe('updateHost / setEnrollmentStatus', () => {
  it('patches fields and keeps the id immutable', () => {
    const rec = createHost(DRAFT);
    const updated = updateHost(rec.id, { name: 'strix-2', id: 'evil' as never });
    expect(updated.name).toBe('strix-2');
    expect(updated.id).toBe(rec.id);
  });

  it('writes enrollment status + detail', () => {
    const rec = createHost(DRAFT);
    const updated = setEnrollmentStatus(rec.id, 'partial', 'provider codex missing');
    expect(updated?.enrollmentStatus).toBe('partial');
    expect(updated?.enrollmentDetail).toBe('provider codex missing');
  });

  it('rejects patches for unknown ids and invalid merges', () => {
    expect(() => updateHost('missing', { name: 'x' })).toThrow(/unknown host/);
    const rec = createHost(DRAFT);
    expect(() => updateHost(rec.id, { port: 0 })).toThrow(HostValidationError);
  });
});

describe('deleteHost', () => {
  it('removes the record', () => {
    const rec = createHost(DRAFT);
    deleteHost(rec.id);
    expect(listHosts()).toHaveLength(0);
    expect(getHost(rec.id)).toBeNull();
  });

  it('ignores unknown ids', () => {
    expect(() => deleteHost('missing')).not.toThrow();
  });
});
