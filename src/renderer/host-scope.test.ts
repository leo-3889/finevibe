// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { projectsForHost, hostChipHtml } from './host-scope.js';
import type { ProjectRecord } from '../shared/types.js';

const project = (id: string, hostId?: string): ProjectRecord =>
  ({ id, name: id, sessions: [], ...(hostId ? { hostId } : {}) }) as unknown as ProjectRecord;

describe('projectsForHost (parent §11 project-list filter)', () => {
  const projects = [project('a'), project('b', 'local'), project('c', 'h1'), project('d', 'h2')];

  it('absent activeHostId shows every local project (pre-Phase-2 behavior)', () => {
    expect(projectsForHost(projects, undefined).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it("'local' matches the load-normalized local projects identically", () => {
    expect(projectsForHost(projects, 'local').map((p) => p.id)).toEqual(['a', 'b']);
  });

  it("a remote tab shows only that host's projects", () => {
    expect(projectsForHost(projects, 'h1').map((p) => p.id)).toEqual(['c']);
  });

  it('an unknown host tab shows nothing (removed hosts fall back at the tab row)', () => {
    expect(projectsForHost(projects, 'gone')).toEqual([]);
  });
});

describe('hostChipHtml (plan §5 chip / §7 style-attribute gate)', () => {
  it('renders the validated hex inline with an escaped title', () => {
    const html = hostChipHtml('#4c9aff', 'zen');
    expect(html).toBe('<span class="host-chip" style="background:#4c9aff" title="zen"></span>');
    expect(hostChipHtml('#4c9aff', 'a"b')).toContain('title="a&quot;b"');
  });

  it('renders nothing for Local/undefined and rejects non-hex payloads', () => {
    expect(hostChipHtml('', 'Local')).toBe('');
    expect(hostChipHtml(undefined, 'Local')).toBe('');
    expect(hostChipHtml('red;background:url(x)', 'x')).toBe('');
    expect(hostChipHtml('#f00', 'x')).toBe('');
  });
});
