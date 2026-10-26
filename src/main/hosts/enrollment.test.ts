import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '../../shared/types';

// Scripted fake ssh-client: exec responses keyed by command substring.
const execLog: string[] = [];
let execScript: (command: string) => string;
let connectImpl: (record: HostRecord, verify?: (fp: string) => boolean) => Promise<{ fingerprint: string }>;

vi.mock('./ssh-client', () => ({
  connect: vi.fn(async (record: HostRecord, opts?: { verifyHostKey?: (fp: string) => boolean }) => {
    const res = await connectImpl(record, opts?.verifyHostKey);
    return { client: {}, fingerprint: res.fingerprint };
  }),
  exec: vi.fn(async (record: HostRecord, command: string) => {
    void record;
    execLog.push(command);
    return execScript(command);
  }),
}));

vi.mock('./keys', async (importOriginal) => {
  const real = await importOriginal<typeof import('./keys')>();
  return { ...real, readPublicKeyLine: vi.fn(() => 'ssh-ed25519 AAAAPUB finevibe:test') };
});

vi.mock('./secrets', () => ({ getHostSecret: vi.fn(() => null) }));

// The file plane (sftp seam) the hook merge reads/writes through.
const plane = vi.hoisted(() => ({
  readProviderFile: vi.fn<(hostId: string | undefined, relPath: string) => Promise<string | null>>(async () => null),
  writeProviderFile: vi.fn<(hostId: string | undefined, relPath: string, content: string) => Promise<void>>(async () => {}),
}));
vi.mock('./provider-fs', () => ({
  readProviderFile: plane.readProviderFile,
  writeProviderFile: plane.writeProviderFile,
}));

const updates: Record<string, unknown>[] = [];
const statuses: [string, string, string | undefined][] = [];
vi.mock('./host-registry', () => ({
  updateHost: vi.fn((_id: string, patch: Record<string, unknown>) => {
    updates.push(patch);
    return { id: _id, ...patch };
  }),
  setEnrollmentStatus: vi.fn((id: string, status: string, detail?: string) => {
    statuses.push([id, status, detail]);
    return null;
  }),
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ud' } }));

vi.mock('../providers/registry', () => ({
  getAllProviderMetas: () => [
    { id: 'pi', binaryName: 'pi' },
    { id: 'claude', binaryName: 'claude' },
  ],
}));

import { enrollHost, probePrerequisites, provisionRemoteProfileDir, refreshHostTools, testHost, unenrollHost } from './enrollment';
import { HOST_HOOK_MARKER, hostHookEntries, mergeHookBlock } from './host-hooks';

const PIN = 'SHA256:pinned123';
const record: HostRecord = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  name: 'strix',
  user: 'dev',
  host: '192.168.2.242',
  port: 22,
  authKind: 'password',
  managedKey: true,
  privateKeyPath: '/tmp/ud/hosts/x/id_ed25519',
  enrollmentStatus: 'draft',
  hostKeyFingerprint: PIN,
};

function script(responses: Record<string, string>): (command: string) => string {
  return (command: string) => {
    for (const [needle, out] of Object.entries(responses)) {
      if (command.includes(needle)) return out;
    }
    return '';
  };
}

beforeEach(() => {
  execLog.length = 0;
  updates.length = 0;
  statuses.length = 0;
  execScript = script({});
  connectImpl = async () => ({ fingerprint: PIN });
  plane.readProviderFile.mockReset().mockResolvedValue(null);
  plane.writeProviderFile.mockReset().mockResolvedValue(undefined);
});

describe('testHost', () => {
  it('reports a new fingerprint for an unpinned host', async () => {
    const unpinned = { ...record, hostKeyFingerprint: undefined };
    const res = await testHost(unpinned);
    expect(res).toMatchObject({ ok: true, newFingerprint: PIN, hostKeyChanged: false });
  });

  it('refuses on pinned-key change', async () => {
    connectImpl = async (_r, verify) => {
      if (verify && !verify('SHA256:evil')) throw new Error('host-key-changed');
      return { fingerprint: 'SHA256:evil' };
    };
    const res = await testHost(record);
    expect(res.ok).toBe(false);
    expect(res.hostKeyChanged).toBe(true);
  });

  it('reports auth failure as a failed connect step', async () => {
    connectImpl = async () => {
      throw new Error('All configured authentication methods failed');
    };
    const res = await testHost(record);
    expect(res.ok).toBe(false);
    expect(res.steps[0]).toMatchObject({ step: 'connect', ok: false });
  });
});

describe('probePrerequisites', () => {
  it('parses path+version per binary and flags missing ones', async () => {
    execScript = script({
      'command -v pi ': '/usr/local/bin/pi\tpi 1.2.3\n',
      'command -v claude ': '', // missing
      'command -v node ': '/usr/bin/node\tv24.0.0\n',
      'command -v git ': '/usr/bin/git\tgit version 2.45.0\n',
    });
    const out = await probePrerequisites(record);
    expect(out?.pi).toEqual({ ok: true, path: '/usr/local/bin/pi', version: 'pi 1.2.3' });
    expect(out?.claude).toEqual({ ok: false });
    expect(out?.git?.ok).toBe(true);
  });
});

describe('enrollHost', () => {
  const fullScript = {
    uname: 'Linux\n',
    '$SHELL': '/bin/bash\n',
    'cat ~/.ssh/authorized_keys': 'ssh-rsa AAAAforeign user@laptop\n',
    'authorized_keys && chmod': '', // deploy append succeeds
    'command -v pi ': '/usr/local/bin/pi\tpi 1.2.3\n',
    'command -v claude ': '/usr/bin/claude\t2.0\n',
    'command -v node ': '/usr/bin/node\tv24.0.0\n',
    'command -v git ': '/usr/bin/git\tgit version 2.45.0\n',
    'mkdir -p ~/.finevibe ~/.finevibe/run': '',
  };

  it('golden path: enrolled, key deployed, all prereqs, hooks merged, dirs made', async () => {
    execScript = script(fullScript);
    const events: string[] = [];
    const res = await enrollHost(record, (e) => events.push(e.status));
    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => s.step)).toEqual(['connect', 'env', 'key-deploy', 'prereqs', 'host-hooks', 'dirs']);
    expect(res.steps.every((s) => s.ok)).toBe(true);
    expect(events).toEqual(['probing', 'enrolled']);
    // Deploy appended exactly one marker block for this id.
    const deploy = execLog.find((c) => c.includes('authorized_keys && chmod'))!;
    expect(deploy).toContain(`# finevibe:${record.id} begin`);
    expect(updates.some((u) => 'prerequisites' in u)).toBe(true);
    expect(updates.some((u) => u.enrollmentStatus === 'enrolled' && u.enrolledAt)).toBe(true);
    // Step 5.5 merged the block into both probed tools' settings files (pi +
    // claude), creating them from nothing (the plane reads null).
    const written = plane.writeProviderFile.mock.calls.map(([hostId, p]) => [hostId, p]);
    expect(written).toEqual([
      [record.id, '~/.claude/settings.json'],
      [record.id, '~/.pi/agent/settings.json'],
    ]);
    const claudeWrite = plane.writeProviderFile.mock.calls.find(([, p]) => p === '~/.claude/settings.json')!;
    expect(JSON.parse(claudeWrite[2]).hooks.Stop[0].hooks[0].command).toContain(HOST_HOOK_MARKER);
    // Parent dirs are exec-lane mkdirs (the seam never creates dirs).
    expect(execLog).toContain('mkdir -p ~/.claude');
    // Sidecar dir the hooks write into, created at the dirs step.
    expect(execLog).toContain('mkdir -p ~/.finevibe ~/.finevibe/run');
  });

  it('host-hooks merge preserves a foreign settings file verbatim', async () => {
    execScript = script(fullScript);
    plane.readProviderFile.mockImplementation(async (_h, p) =>
      p === '~/.claude/settings.json' ? JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign.sh' }] }] } }) : null,
    );
    await enrollHost(record, () => {});
    const claudeWrite = plane.writeProviderFile.mock.calls.find(([, p]) => p === '~/.claude/settings.json')!;
    const parsed = JSON.parse(claudeWrite[2]);
    expect(parsed.model).toBe('opus');
    expect(parsed.hooks.Stop).toHaveLength(2);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('foreign.sh');
  });

  it('host-hooks is idempotent: an already-merged file is not rewritten', async () => {
    execScript = script(fullScript);
    plane.readProviderFile.mockImplementation(async (_h, p) => {
      const providerId = p.includes('claude') ? 'claude' : 'pi';
      return mergeHookBlock(null, hostHookEntries(providerId)).json;
    });
    const res = await enrollHost(record, () => {});
    expect(res.steps.find((s) => s.step === 'host-hooks')?.ok).toBe(true);
    expect(plane.writeProviderFile).not.toHaveBeenCalled();
  });

  it('host-hooks partial: a corrupt settings.json is reported, never overwritten', async () => {
    execScript = script(fullScript);
    plane.readProviderFile.mockImplementation(async (_h, p) =>
      p === '~/.claude/settings.json' ? '{corrupt' : null,
    );
    const res = await enrollHost(record, () => {});
    const hookStep = res.steps.find((s) => s.step === 'host-hooks');
    expect(hookStep?.ok).toBe(false);
    expect(hookStep?.detail).toContain('~/.claude/settings.json');
    expect(res.ok).toBe(true); // enrolled, partial: the rest of the steps ran
    expect(res.steps.some((s) => s.step === 'dirs')).toBe(true);
    // The pi file (readable) was still merged; the corrupt claude file was not.
    expect(plane.writeProviderFile.mock.calls.map(([, p]) => p)).toEqual(['~/.pi/agent/settings.json']);
  });

  it('host-hooks skips settings files of tools the probe did not find', async () => {
    execScript = script({ ...fullScript, 'command -v claude ': '' });
    const res = await enrollHost(record, () => {});
    expect(res.steps.find((s) => s.step === 'host-hooks')?.ok).toBe(true);
    expect(plane.writeProviderFile.mock.calls.map(([, p]) => p)).toEqual(['~/.pi/agent/settings.json']);
  });

  it('pins the approved fingerprint when the record had none', async () => {
    execScript = script(fullScript);
    const unpinned = { ...record, hostKeyFingerprint: undefined };
    await enrollHost(unpinned, () => {}, { pin: PIN });
    expect(updates[0]).toMatchObject({ hostKeyFingerprint: PIN });
  });

  it('fails without a pin when the record has none', async () => {
    const unpinned = { ...record, hostKeyFingerprint: undefined };
    const res = await enrollHost(unpinned, () => {});
    expect(res.ok).toBe(false);
    expect(statuses[0]?.[1]).toBe('failed');
    expect(statuses[0]?.[2]).toMatch(/not pinned/);
  });

  it('refuses non-POSIX targets (R2)', async () => {
    execScript = script({ ...fullScript, uname: 'Windows_NT\n' });
    const res = await enrollHost(record, () => {});
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => s.step === 'env')?.ok).toBe(false);
    expect(statuses.some((s) => s[1] === 'failed' && /POSIX/.test(s[2] ?? ''))).toBe(true);
  });

  it('partial when a prereq is missing — later steps still run', async () => {
    execScript = script({ ...fullScript, 'command -v claude ': '' });
    const events: string[] = [];
    const res = await enrollHost(record, (e) => events.push(e.status));
    expect(res.ok).toBe(true);
    expect(res.steps.find((s) => s.step === 'prereqs')?.ok).toBe(false);
    expect(res.steps.some((s) => s.step === 'dirs')).toBe(true);
    // Success/partial paths persist via updateHost + emit (statuses[] is
    // only filled by the fail-path setEnrollmentStatus).
    expect(events).toEqual(['probing', 'partial']);
    expect(updates.some((u) => u.enrollmentStatus === 'partial')).toBe(true);
  });

  it('key-change mid-enroll fails hard', async () => {
    connectImpl = async (_r, verify) => {
      if (verify && !verify('SHA256:rotated')) throw new Error('host-key-changed');
      return { fingerprint: 'SHA256:rotated' };
    };
    const res = await enrollHost(record, () => {});
    expect(res.ok).toBe(false);
    expect(res.steps[0]).toMatchObject({ step: 'connect', ok: false, detail: 'host-key-changed' });
  });

  it('key deploy is skipped for non-managed records', async () => {
    execScript = script(fullScript);
    const res = await enrollHost({ ...record, managedKey: false, authKind: 'key', privateKeyPath: '/x' }, () => {});
    expect(res.steps.some((s) => s.step === 'key-deploy')).toBe(false);
    expect(res.ok).toBe(true);
  });
});

describe('unenrollHost', () => {
  it('rewrites authorized_keys without exactly the finevibe block', async () => {
    const foreign = 'ssh-rsa AAAAforeign user@laptop\n';
    execScript = script({
      'cat ~/.ssh/authorized_keys': `${foreign}# finevibe:${record.id} begin\nssh-ed25519 AAAAPUB finevibe\n# finevibe:${record.id} end\nssh-ed25519 AAAAother finevibe:host-2\n`,
    });
    const res = await unenrollHost(record);
    expect(res.ok).toBe(true);
    const rewrite = execLog.find((c) => c.includes('base64 -d'))!;
    const b64 = rewrite.match(/printf '%s' '([^']+)'/)![1];
    const written = Buffer.from(b64, 'base64').toString('utf8');
    expect(written).toContain('AAAAforeign');
    expect(written).toContain('finevibe:host-2');
    expect(written).not.toContain(`finevibe:${record.id}`);
  });

  it('no-op when no block exists', async () => {
    execScript = script({ 'cat ~/.ssh/authorized_keys': 'ssh-rsa AAAAforeign\n' });
    const res = await unenrollHost(record);
    expect(res).toEqual({ ok: true, detail: 'no marker block present' });
    expect(execLog.some((c) => c.includes('base64 -d'))).toBe(false);
  });

  it('strips exactly the hook block from every settings target', async () => {
    execScript = script({ 'cat ~/.ssh/authorized_keys': 'ssh-rsa AAAAforeign\n' });
    // Unprobed record → every known settings path is inspected; only the pi
    // file carries a FineVibe block (plus a foreign hook that must survive).
    plane.readProviderFile.mockImplementation(async (_h, p) => {
      if (p !== '~/.pi/agent/settings.json') return '{corrupt';
      return mergeHookBlock('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"foreign.sh"}]}]}}', hostHookEntries('pi')).json;
    });
    const res = await unenrollHost(record);
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('corrupt'); // corrupt files are skipped, reported
    const write = plane.writeProviderFile.mock.calls.find(([, p]) => p === '~/.pi/agent/settings.json')!;
    const parsed = JSON.parse(write[2]);
    expect(JSON.stringify(parsed.hooks).includes(HOST_HOOK_MARKER)).toBe(false);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('foreign.sh');
  });
});

// Per-host providers T1: managed profile provisioning over the exec lane.
describe('provisionRemoteProfileDir', () => {
  it('mkdirs the unquoted managed dir (tilde must expand) and returns the absolute path', async () => {
    execScript = script({ 'mkdir -p ~/.finevibe/profiles/': '/home/dev/.finevibe/profiles/abc' });
    const dir = await provisionRemoteProfileDir(record, 'abc');
    expect(dir).toBe('/home/dev/.finevibe/profiles/abc');
    expect(execLog[0]).toBe(`mkdir -p ~/.finevibe/profiles/abc && printf '%s' ~/.finevibe/profiles/abc`);
  });

  it('refuses ids outside the managed-id charset', async () => {
    await expect(provisionRemoteProfileDir(record, '../evil')).rejects.toThrow(/Invalid profile id/);
    await expect(provisionRemoteProfileDir(record, 'a; rm -rf /')).rejects.toThrow(/Invalid profile id/);
    expect(execLog).toHaveLength(0);
  });

  it('refuses a non-absolute echo-back (remote shell misbehaved)', async () => {
    execScript = script({ 'mkdir -p': '~/.finevibe/profiles/abc' });
    await expect(provisionRemoteProfileDir(record, 'abc')).rejects.toThrow(/returned/);
  });
});

describe('refreshHostTools', () => {
  it('probes once, persists the record, and shares the in-flight run', async () => {
    execScript = script({ 'command -v pi': '/home/dev/.local/bin/pi' });
    const a = refreshHostTools(record);
    const b = refreshHostTools(record); // deduped: same promise, one probe
    await Promise.all([a, b]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ lastProbeOk: true });
    expect((updates[0] as { prerequisites?: Record<string, { ok: boolean }> }).prerequisites?.pi?.ok).toBe(true);
    // Settled runs are evicted: the next call probes again.
    await refreshHostTools(record);
    expect(updates).toHaveLength(2);
  });

  it('liveness gate: an unreachable host rejects and never rewrites the record (audit T1 #1)', async () => {
    execScript = (command: string) => {
      if (command === 'true') throw new Error('ECONNREFUSED');
      return '';
    };
    await expect(refreshHostTools(record)).rejects.toThrow(/ECONNREFUSED/);
    // The healthy record must survive: no prerequisites/lastProbeAt write.
    expect(updates).toHaveLength(0);
  });
});
