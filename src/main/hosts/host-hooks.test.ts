import { describe, expect, it } from 'vitest';
import {
  HOST_HOOK_MARKER,
  hostHookEntries,
  hostStatusCmd,
  mergeHookBlock,
  stripHookBlock,
} from './host-hooks';

// The merge core is pure string→string: everything below is a table.

describe('hostStatusCmd', () => {
  it('golden: sh -c, mkdir guard, tmp+mv, marker last', () => {
    expect(hostStatusCmd('Stop', 'completed', 'FINEVIBE_SESSION_ID')).toBe(
      `sh -c 'mkdir -p "$HOME/.finevibe/run" && echo "Stop:completed" > ` +
        `"$HOME/.finevibe/run/$FINEVIBE_SESSION_ID.status.tmp" && ` +
        `mv "$HOME/.finevibe/run/$FINEVIBE_SESSION_ID.status.tmp" ` +
        `"$HOME/.finevibe/run/$FINEVIBE_SESSION_ID.status" ${HOST_HOOK_MARKER}'`,
    );
  });
});

describe('hostHookEntries', () => {
  it('claude uses CLAUDE_IDE_SESSION_ID, the pi lineage uses FINEVIBE_SESSION_ID', () => {
    const claude = hostHookEntries('claude');
    expect(claude.map((e) => e.event)).toEqual(['UserPromptSubmit', 'PostToolUse', 'Stop', 'PermissionRequest']);
    expect(claude.every((e) => e.command.includes('CLAUDE_IDE_SESSION_ID'))).toBe(true);
    expect(claude.every((e) => e.command.includes(HOST_HOOK_MARKER))).toBe(true);
    expect(hostHookEntries('pi').every((e) => e.command.includes('FINEVIBE_SESSION_ID'))).toBe(true);
    expect(hostHookEntries('omp').every((e) => e.command.includes('FINEVIBE_SESSION_ID'))).toBe(true);
  });
});

const ENTRIES = hostHookEntries('pi');

function settingsWithForeign(): string {
  return JSON.stringify(
    {
      model: 'opus',
      env: { X: '1' },
      hooks: {
        Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign-hook.sh' }] }],
      },
    },
    null,
    2,
  );
}

describe('mergeHookBlock', () => {
  it('missing file: creates the hooks tree with one matcher per event', () => {
    const { json, changed } = mergeHookBlock(null, ENTRIES);
    expect(changed).toBe(true);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['PermissionRequest', 'PostToolUse', 'Stop', 'UserPromptSubmit'].sort(),
    );
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain(HOST_HOOK_MARKER);
  });

  it('foreign keys and foreign hooks survive verbatim', () => {
    const { json } = mergeHookBlock(settingsWithForeign(), ENTRIES);
    const parsed = JSON.parse(json);
    expect(parsed.model).toBe('opus');
    expect(parsed.env).toEqual({ X: '1' });
    const stop = parsed.hooks.Stop;
    expect(stop).toHaveLength(2);
    expect(stop[0].hooks[0].command).toBe('foreign-hook.sh');
    expect(stop[1].hooks[0].command).toContain(HOST_HOOK_MARKER);
  });

  it('idempotent: re-merging the result changes nothing (changed:false, original returned shape stable)', () => {
    const once = mergeHookBlock(settingsWithForeign(), ENTRIES);
    const twice = mergeHookBlock(once.json, ENTRIES);
    expect(twice.changed).toBe(false);
    // No duplicated handlers:
    expect(stripHookBlock(twice.json).changed).toBe(true);
    const after = mergeHookBlock(settingsWithForeign(), ENTRIES).json;
    expect(JSON.parse(twice.json)).toEqual(JSON.parse(after));
  });

  it('replacing a previously-installed block of a DIFFERENT provider keeps one block', () => {
    const claude = mergeHookBlock(null, hostHookEntries('claude')).json;
    const swapped = mergeHookBlock(claude, ENTRIES).json;
    const commands = (Object.values(JSON.parse(swapped).hooks) as { hooks: { command: string }[] }[]).flat()
      .map((m) => m.hooks[0].command);
    expect(commands).toHaveLength(4);
    expect(commands.every((c) => c.includes('FINEVIBE_SESSION_ID'))).toBe(true);
    expect(commands.every((c) => !c.includes('CLAUDE_IDE_SESSION_ID'))).toBe(true);
  });

  it('corrupt JSON throws and the caller leaves the file untouched', () => {
    expect(() => mergeHookBlock('{not json', ENTRIES)).toThrow(/corrupt/);
    expect(() => mergeHookBlock('[1,2]', ENTRIES)).toThrow(/not a JSON object/);
  });

  it('corrupt hooks SHAPES are refused, not rewritten (audit T2 #8)', () => {
    // `hooks: "x"` would Object.entries into char-keyed matchers…
    expect(() => mergeHookBlock('{"hooks":"x"}', ENTRIES)).toThrow(/hooks is not an object/);
    expect(() => mergeHookBlock('{"hooks":[]}', ENTRIES)).toThrow(/hooks is not an object/);
    // …and a non-array event value would be silently replaced by our block.
    expect(() => mergeHookBlock('{"hooks":{"Stop":"x"}}', ENTRIES)).toThrow(/hooks\.Stop is not an array/);
    expect(() => stripHookBlock('{"hooks":{"Stop":"x"}}')).toThrow(/hooks\.Stop is not an array/);
    // A well-formed empty hooks object stays fine.
    expect(() => mergeHookBlock('{"hooks":{}}', ENTRIES)).not.toThrow();
  });
});

describe('stripHookBlock', () => {
  it('removes exactly the marked handlers, keeps foreign ones', () => {
    const merged = mergeHookBlock(settingsWithForeign(), ENTRIES).json;
    const { json, changed } = stripHookBlock(merged);
    expect(changed).toBe(true);
    const parsed = JSON.parse(json);
    expect(parsed.model).toBe('opus');
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('foreign-hook.sh');
    // Events that carried ONLY FineVibe handlers are dropped entirely.
    expect(parsed.hooks.UserPromptSubmit).toBeUndefined();
  });

  it('drops an empty hooks object when the block was the only hook', () => {
    const merged = mergeHookBlock(null, ENTRIES).json;
    const { json } = stripHookBlock(merged);
    expect(JSON.parse(json).hooks).toBeUndefined();
  });

  it('nothing marked: changed:false, original text returned verbatim', () => {
    const foreign = settingsWithForeign();
    const { json, changed } = stripHookBlock(foreign);
    expect(changed).toBe(false);
    expect(json).toBe(foreign);
  });

  it('corrupt JSON throws', () => {
    expect(() => stripHookBlock('nope{')).toThrow(/corrupt/);
  });
});
