import { describe, expect, it } from 'vitest';
import { parseSshHost } from './ssh-host';

describe('parseSshHost', () => {
  it('accepts plain hosts', () => {
    expect(parseSshHost('myserver')).toEqual({ host: 'myserver' });
    expect(parseSshHost(' lab.example.com ')).toEqual({ host: 'lab.example.com' });
    expect(parseSshHost('10.0.0.8')).toEqual({ host: '10.0.0.8' });
  });

  it('accepts user@host and normalizes', () => {
    expect(parseSshHost('root@lab.example.com')).toEqual({ host: 'root@lab.example.com', user: 'root' });
    expect(parseSshHost('dev.d-1@host')).toEqual({ host: 'dev.d-1@host', user: 'dev.d-1' });
  });

  it('rejects ports, ssh:// URLs, whitespace, and empty', () => {
    expect(parseSshHost('host:22')).toBeNull();
    expect(parseSshHost('ssh://host')).toBeNull();
    expect(parseSshHost('two words')).toBeNull();
    expect(parseSshHost('a b@c')).toBeNull();
    expect(parseSshHost('')).toBeNull();
    expect(parseSshHost('   ')).toBeNull();
  });

  it('rejects option-injection and shell metacharacters', () => {
    expect(parseSshHost('-oProxyCommand=evil')).toBeNull();
    expect(parseSshHost('host;rm')).toBeNull();
    expect(parseSshHost('host$X')).toBeNull();
    expect(parseSshHost('host`x`')).toBeNull();
    expect(parseSshHost('@host')).toBeNull();
    expect(parseSshHost('user@@host')).toBeNull();
  });

  it('rejects malformed hostnames', () => {
    expect(parseSshHost('-host')).toBeNull();
    expect(parseSshHost('host-')).toBeNull();
    expect(parseSshHost('host..name')).toBeNull();
    expect(parseSshHost('x'.repeat(254))).toBeNull();
    expect(parseSshHost('x'.repeat(253))).toEqual({ host: 'x'.repeat(253) });
  });
});
