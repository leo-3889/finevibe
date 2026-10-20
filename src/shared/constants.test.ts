import { describe, expect, it } from 'vitest';
import { SPAWN_REJECTED_EXIT_REASON, isSpawnRejectedExitReason } from './constants';

/**
 * The renderer's one decision point for `pty:exit`: the sentinel keeps the
 * pane (the reason is already printed in it), every other reason takes the
 * normal teardown — archive the row (crash badge) and notify. So the payload
 * strings main actually sends must classify exactly as the renderer expects.
 */
describe('isSpawnRejectedExitReason (pty:exit contract)', () => {
  it('keeps the pane for the sentinel spawnPty writes', () => {
    expect(isSpawnRejectedExitReason(SPAWN_REJECTED_EXIT_REASON)).toBe(true);
  });

  it('treats a real exit code 1 as a process exit (archive + crash notification)', () => {
    expect(isSpawnRejectedExitReason('exited with code 1')).toBe(false);
  });

  it('treats a transcript crash reason as a process exit', () => {
    expect(isSpawnRejectedExitReason('unhandled_rejection')).toBe(false);
  });

  it('treats a clean exit (no reason) as a process exit', () => {
    expect(isSpawnRejectedExitReason(undefined)).toBe(false);
  });
});
