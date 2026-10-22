import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachWin32TerminalKeys, unlatchWin32Key } from './win32-terminal-keys';

function fixture(opts?: { latchKey?: string; latched?: boolean }) {
  const modes = new Map<string, (params: number[]) => boolean>();
  const terminal = { parser: { registerCsiHandler: (id: { final: string }, cb: (params: number[]) => boolean) => modes.set(id.final, cb) } };
  const write = vi.fn();
  const key = attachWin32TerminalKeys(terminal as unknown as Terminal, write, opts);
  const press = (name: string, extra = {}) => key({ key: name, type: 'keydown', preventDefault: vi.fn(), ...extra } as unknown as KeyboardEvent);
  return { modes, write, press };
}

describe('Win32 terminal key input', () => {
  // Each latch-backed test owns a distinct latchKey: the module-level latch set
  // outlives the Terminal, exactly like ConPTY's arming outlives an attach.
  it.each([['ArrowUp', 38, 72], ['ArrowDown', 40, 80], ['ArrowLeft', 37, 75], ['ArrowRight', 39, 77]])('encodes %s once mode 9001 is sighted and keeps encoding through ?9001l', (name, vk, scan) => {
    const f = fixture();
    expect(f.press(name as string)).toBeUndefined();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.modes.get('h')!([9001, 1004])).toBe(false);
    expect(f.press(name as string)).toBe(false);
    expect(f.write).toHaveBeenCalledWith(`\x1b[${vk};${scan};0;1;256;1_`);
    // Mode 9001 is monotonic per PTY: ConPTY never delivers a bare ESC again,
    // so a mode-off sighting must not return the keys to xterm.
    expect(f.modes.get('l')!([9001])).toBe(false);
    expect(f.press(name as string)).toBe(false);
    expect(f.write).toHaveBeenCalledTimes(2);
  });
  it('preserves modifiers and suppresses duplicate keyup writes', () => {
    const f = fixture();
    f.modes.get('h')!([9001]);
    f.press('ArrowLeft', { ctrlKey: true, altKey: true, shiftKey: true });
    expect(f.write).toHaveBeenCalledWith('\x1b[37;75;0;1;282;1_');
    expect(f.press('ArrowLeft', { type: 'keyup' })).toBe(false);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.press('a')).toBeUndefined();
    expect(f.press('ArrowUp', { isComposing: true })).toBeUndefined();
  });
  it('encodes Escape as a non-enhanced INPUT_RECORD with UnicodeChar 0x1b, latching on mode 9001', () => {
    const f = fixture();
    expect(f.press('Escape')).toBeUndefined();
    expect(f.write).not.toHaveBeenCalled();
    f.modes.get('h')!([9001]);
    expect(f.press('Escape')).toBe(false);
    expect(f.write).toHaveBeenCalledWith('\x1b[27;1;27;1;0;1_');
    f.press('Escape', { ctrlKey: true });
    expect(f.write).toHaveBeenLastCalledWith('\x1b[27;1;27;1;8;1_');
    expect(f.press('Escape', { type: 'keyup' })).toBe(false);
    f.modes.get('l')!([9001]);
    // The bare ESC this would let through is swallowed by the armed ConPTY.
    expect(f.press('Escape')).toBe(false);
    expect(f.write).toHaveBeenLastCalledWith('\x1b[27;1;27;1;0;1_');
  });
  it('re-attach regression: a fresh handler on a latched PTY encodes Escape, never falls through to a bare ESC', () => {
    const latchKey = 'pty-reattach';
    const first = fixture({ latchKey });
    first.modes.get('h')!([9001]); // ConPTY's spawn-time advertisement on the live PTY
    const reattached = fixture({ latchKey }); // Terminal re-created/re-attached on the SAME PTY
    // enabled starts from the PTY's latch, so the fall-through that writes the
    // renderer's own `\x1b` (swallowed by ConPTY, killing menu dismissal) is
    // unreachable: the key is encoded and xterm is suppressed.
    expect(reattached.press('Escape')).toBe(false);
    expect(reattached.write).toHaveBeenCalledWith('\x1b[27;1;27;1;0;1_');
  });
  it('does not un-latch a latched key on ?9001l', () => {
    const latchKey = 'pty-unlatch';
    const f = fixture({ latchKey });
    f.modes.get('h')!([9001]);
    expect(f.modes.get('l')!([9001])).toBe(false);
    expect(f.press('Escape')).toBe(false); // same handler keeps encoding
    const reattached = fixture({ latchKey }); // and so does the next attach
    expect(reattached.press('Escape')).toBe(false);
    expect(reattached.write).toHaveBeenCalledWith('\x1b[27;1;27;1;0;1_');
  });
  it('encodes immediately when latched is pre-set, with no prior ?9001h sighting', () => {
    const f = fixture({ latchKey: 'pty-prearmed', latched: true });
    expect(f.press('Escape')).toBe(false);
    expect(f.write).toHaveBeenCalledWith('\x1b[27;1;27;1;0;1_');
  });
  it('leaves Escape to xterm with no latchKey and mode 9001 never sighted', () => {
    const f = fixture();
    expect(f.press('Escape')).toBeUndefined();
    expect(f.write).not.toHaveBeenCalled();
  });
});

describe('Win32 latch lifecycle (C2R-13)', () => {
  // The latch is keyed by session id, so destroying the PTY has to release it:
  // the pane owners call unlatchWin32Key from their destroy paths, and a set
  // that never shrank kept every closed tab's id alive for the renderer's life.
  it('unlatchWin32Key releases the key so a fresh attach on it starts unarmed', () => {
    const latchKey = 'pty-released';
    const armed = fixture({ latchKey });
    armed.modes.get('h')!([9001]);

    unlatchWin32Key(latchKey);

    const fresh = fixture({ latchKey });
    expect(fresh.press('Escape')).toBeUndefined();
    expect(fresh.write).not.toHaveBeenCalled();
  });

  it('unlatching one PTY leaves every other latch armed', () => {
    const doomed = 'pty-doomed';
    const survivor = 'pty-survivor';
    for (const key of [doomed, survivor]) {
      fixture({ latchKey: key }).modes.get('h')!([9001]);
    }

    unlatchWin32Key(doomed);

    expect(fixture({ latchKey: survivor }).press('Escape')).toBe(false);
    expect(fixture({ latchKey: doomed }).press('Escape')).toBeUndefined();
  });
});

// C5R-08: ControlKeyState parity — AltGr must encode RIGHT_ALT_PRESSED (0x4),
// Caps Lock CAPS_LOCK (0x80); NUM_LOCK has no renderer signal and stays out.
describe('Win32 ControlKeyState modifier bits', () => {
  it('encodes AltGr as RIGHT_ALT_PRESSED alongside CONTROL_PRESSED', () => {
    const f = fixture({ latched: true });
    f.press('ArrowLeft', {
      altKey: true,
      ctrlKey: true,
      getModifierState: (k: string) => k === 'AltGraph',
    });
    // 256 base | 8 CONTROL | 4 RIGHT_ALT — never the left-Alt 0x2.
    expect(f.write).toHaveBeenCalledWith('\x1b[37;75;0;1;268;1_');
  });

  it('encodes Caps Lock as CAPS_LOCK (0x80)', () => {
    const f = fixture({ latched: true });
    f.press('ArrowUp', { getModifierState: (k: string) => k === 'CapsLock' });
    expect(f.write).toHaveBeenCalledWith('\x1b[38;72;0;1;384;1_');
  });

  it('keeps plain left Alt at ALT_PRESSED (0x2) without an AltGraph signal', () => {
    const f = fixture({ latched: true });
    f.press('ArrowUp', { altKey: true });
    expect(f.write).toHaveBeenCalledWith('\x1b[38;72;0;1;258;1_');
  });
});
