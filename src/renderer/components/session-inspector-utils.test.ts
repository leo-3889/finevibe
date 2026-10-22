// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../shortcuts.js', () => ({
  shortcutManager: { matchesAnyShortcut: () => false },
}));

vi.mock('./terminal-context-menu.js', () => ({
  showTerminalContextMenu: vi.fn(),
}));

import { createToolInputEl, isMcpToolEvent, parseMcpToolName } from './session-inspector-utils.js';

describe('parseMcpToolName', () => {
  it('parses Claude MCP tool names into server and tool labels', () => {
    expect(parseMcpToolName('mcp__memory__create_entities')).toEqual({
      rawToolName: 'mcp__memory__create_entities',
      server: 'memory',
      tool: 'create_entities',
      displayLabel: 'memory / create_entities',
    });
  });

  it('returns null for non-MCP or malformed tool names', () => {
    expect(parseMcpToolName('Bash')).toBeNull();
    expect(parseMcpToolName('mcp__memory')).toBeNull();
    expect(parseMcpToolName('mcp____tool')).toBeNull();
  });
});

describe('isMcpToolEvent', () => {
  it('only marks documented Claude tool hook event types as MCP tool events', () => {
    expect(isMcpToolEvent({ type: 'pre_tool_use', tool_name: 'mcp__github__search_repositories' })).toBe(true);
    expect(isMcpToolEvent({ type: 'permission_request', tool_name: 'mcp__github__search_repositories' })).toBe(true);
    expect(isMcpToolEvent({ type: 'permission_denied', tool_name: 'mcp__github__search_repositories' })).toBe(true);
    expect(isMcpToolEvent({ type: 'session_start', tool_name: 'mcp__github__search_repositories' })).toBe(false);
    expect(isMcpToolEvent({ type: 'tool_use', tool_name: 'Bash' })).toBe(false);
  });
});

// C5R-09: the 2000-char preview slice must not end mid astral-plane pair —
// the lone high surrogate renders as U+FFFD (the intent chunkByUtf8Bytes
// documents for the byte-slicing path).
describe('createToolInputEl truncation', () => {
  it('drops a high surrogate split at the 2000-char boundary', () => {
    // JSON.stringify adds quotes: 1 + 1998 pad + high surrogate at index 1999.
    const el = createToolInputEl('x'.repeat(1998) + '\u{1F600}');
    const text = el.textContent ?? '';
    expect(text.length).toBeLessThanOrEqual(2000 + 4);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text.endsWith('\n...')).toBe(true);
  });

  it('leaves short inputs untouched', () => {
    const el = createToolInputEl({ a: 1 });
    expect(el.textContent).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});
