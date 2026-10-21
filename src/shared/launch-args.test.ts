import { describe, it, expect } from 'vitest';
import { tokenizeArgs, findConflictingLaunchFlags, findConflictingEnvKeys } from './launch-args';

describe('tokenizeArgs', () => {
  it('splits on runs of whitespace', () => {
    expect(tokenizeArgs('--model  opus\t--provider\nolla')).toEqual(['--model', 'opus', '--provider', 'olla']);
  });

  it('returns [] for empty or whitespace-only input', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   \t \n\r ')).toEqual([]);
  });

  it('keeps quoted spaces inside a single argument', () => {
    expect(tokenizeArgs('--append-system-prompt "Use concise replies"'))
      .toEqual(['--append-system-prompt', 'Use concise replies']);
  });

  it('preserves empty quoted arguments (double and single quotes)', () => {
    expect(tokenizeArgs('--flag "" --other')).toEqual(['--flag', '', '--other']);
    expect(tokenizeArgs("''")).toEqual(['']);
  });

  it('unescapes quote and backslash inside double quotes', () => {
    expect(tokenizeArgs('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(tokenizeArgs('"a\\\\b"')).toEqual(['a\\b']);
  });

  it('keeps other backslashes inside double quotes verbatim', () => {
    expect(tokenizeArgs('"C:\\temp\\x"')).toEqual(['C:\\temp\\x']);
  });

  it('keeps backslashes before non-quote characters verbatim (Windows paths)', () => {
    expect(tokenizeArgs('--dir C:\\Users\\me')).toEqual(['--dir', 'C:\\Users\\me']);
    // A backslash is literal, but delimiters still split after it.
    expect(tokenizeArgs('a\\ b')).toEqual(['a\\', 'b']);
  });

  it('escapes only quote characters and backslashes outside quotes', () => {
    expect(tokenizeArgs('a\\"b')).toEqual(['a"b']);
    expect(tokenizeArgs("a\\'b")).toEqual(["a'b"]);
    expect(tokenizeArgs('a\\\\b')).toEqual(['a\\b']);
  });

  it('keeps a lone trailing backslash (Windows paths)', () => {
    expect(tokenizeArgs('C:\\')).toEqual(['C:\\']);
    expect(tokenizeArgs('--dir C:\\')).toEqual(['--dir', 'C:\\']);
  });

  it('treats an unclosed quote as literal to the end of input', () => {
    expect(tokenizeArgs('"abc def')).toEqual(['abc def']);
    expect(tokenizeArgs("'abc def")).toEqual(['abc def']);
  });

  it('performs no shell expansion', () => {
    expect(tokenizeArgs('$HOME `id` *')).toEqual(['$HOME', '`id`', '*']);
  });

  it('keeps a prompt starting with option characters as one argument', () => {
    expect(tokenizeArgs('--foo --bar')).toEqual(['--foo', '--bar']);
    expect(tokenizeArgs('"--foo bar"')).toEqual(['--foo bar']);
  });
});

describe('findConflictingLaunchFlags', () => {
  it('detects profile, storage and session-identity flags (space and = forms)', () => {
    const cases: Array<[string[], string]> = [
      [['--profile', 'work'], '--profile'],
      [['--profile=work'], '--profile'],
      [['--session-dir', '/sessions'], '--session-dir'],
      [['--session-dir=/sessions'], '--session-dir'],
      [['--no-session'], '--no-session'],
      [['--session', 'abc'], '--session'],
      [['--resume', 'abc'], '--resume'],
      [['--continue'], '--continue'],
      [['-r'], '-r'],
      [['-c'], '-c'],
      // Vibeyard pins --session-id itself (claude/pi fresh launches); a later
      // user occurrence wins in argv, so the CLI writes a transcript the
      // session watcher can never attribute.
      [['--session-id', '019d3512-caf9-7b50-8d2b-ccccdcf8ff14'], '--session-id'],
      [['--session-id=019d3512-caf9-7b50-8d2b-ccccdcf8ff14'], '--session-id'],
    ];
    for (const [tokens, flag] of cases) {
      const conflicts = findConflictingLaunchFlags(tokens);
      expect(conflicts.map((c) => c.flag)).toContain(flag);
      expect(conflicts[0].reason.length).toBeGreaterThan(0);
    }
  });

  it('does not flag ordinary flags or flag-like values', () => {
    expect(findConflictingLaunchFlags(['--model', 'opus', '--append-system-prompt', 'x', '-p'])).toEqual([]);
    // A value that merely contains a flag name is not a flag.
    expect(findConflictingLaunchFlags(['--model', 'no-session-9000'])).toEqual([]);
  });

  it('does not resolve prototype-chain names off the reason map', () => {
    // A positional arg named like an Object.prototype member used to index
    // through the prototype chain and return the function as the "reason" —
    // blocking the spawn with `function Object() { [native code] }` as the
    // actionable error. Lookup is hasOwn-guarded.
    expect(findConflictingLaunchFlags(['constructor'])).toEqual([]);
    expect(findConflictingLaunchFlags(['__proto__'])).toEqual([]);
    expect(findConflictingLaunchFlags(['toString'])).toEqual([]);
    expect(findConflictingLaunchFlags(['toString=1'])).toEqual([]);
  });

  it('reports every conflicting token, not just the first', () => {
    const conflicts = findConflictingLaunchFlags(['--no-session', '--profile', 'work']);
    expect(conflicts.map((c) => c.flag).sort()).toEqual(['--no-session', '--profile']);
  });
});

describe('findConflictingEnvKeys', () => {
  it('matches the unsupported storage selectors case-insensitively', () => {
    expect(findConflictingEnvKeys({ PI_CODING_AGENT_SESSION_DIR: '/x', SAFE: '1' })).toEqual(['PI_CODING_AGENT_SESSION_DIR']);
    expect(findConflictingEnvKeys({ pi_coding_agent_session_dir: '/x' })).toEqual(['pi_coding_agent_session_dir']);
    expect(findConflictingEnvKeys({ CODEX_HOME: '/work/codex' })).toEqual(['CODEX_HOME']);
    expect(findConflictingEnvKeys({ codex_home: '/work/codex' })).toEqual(['codex_home']);
    expect(findConflictingEnvKeys({ SAFE: '1' })).toEqual([]);
  });
});
