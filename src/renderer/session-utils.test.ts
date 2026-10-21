import { describe, it, expect } from 'vitest';
import { isCliSession } from './session-utils';
import type { SessionRecord } from '../shared/types';

type SessionType = NonNullable<SessionRecord['type']>;

describe('isCliSession', () => {
  it('returns true when type is undefined (regular CLI session)', () => {
    expect(isCliSession({ type: undefined })).toBe(true);
    expect(isCliSession({})).toBe(true);
  });

  it.each<SessionType>([
    'mcp-inspector',
    'diff-viewer',
    'file-reader',
    'remote-terminal',
    'browser-tab',
    'project-tab',
    'kanban',
  ])('returns false for special pane type %s', (type) => {
    expect(isCliSession({ type })).toBe(false);
  });
});
