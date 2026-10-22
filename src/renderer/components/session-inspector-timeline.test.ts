import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shortcuts.js', () => ({
  shortcutManager: { matchesAnyShortcut: () => false },
}));

vi.mock('./terminal-context-menu.js', () => ({
  showTerminalContextMenu: vi.fn(),
}));

vi.mock('../session-inspector-state.js', () => ({
  getEvents: vi.fn(),
  getCostDeltas: vi.fn(() => []),
}));

vi.mock('./session-inspector-state-ui.js', () => ({
  inspectorState: {
    inspectedSessionId: 'session-1',
    expandedRows: new Set<string>(),
    autoExpandedAgentGroups: new Set<string>(),
    autoScroll: false,
    programmaticScroll: false,
  },
}));

import { getEvents } from '../session-inspector-state.js';
import { renderTimeline, appendTimelineEvents, buildAgentModel } from './session-inspector-timeline.js';
import { inspectorState } from './session-inspector-state-ui.js';
import type { InspectorEvent } from '../../shared/types.js';

class FakeClassList {
  private values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token);
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  className = '';
  classList = new FakeClassList();
  textContent = '';
  private innerHtmlValue = '';
  scrollTop = 0;
  scrollHeight = 0;
  listeners = new Map<string, Array<() => void>>();

  constructor(public tagName: string) {}

  // Mirrors the DOM: assigning innerHTML detaches the previous children.
  get innerHTML(): string {
    return this.innerHtmlValue;
  }
  set innerHTML(value: string) {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.innerHtmlValue = value;
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(event: string, cb: () => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(cb);
    this.listeners.set(event, listeners);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    this.walk((node) => {
      if (className && node.className.split(/\s+/).includes(className)) matches.push(node);
    });
    return matches;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  private walk(cb: (node: FakeElement) => void): void {
    for (const child of this.children) {
      cb(child);
      child.walk(cb);
    }
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

describe('session-inspector timeline MCP badges', () => {
  beforeEach(() => {
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  it('renders an MCP badge and friendly label for Claude MCP tools', () => {
    vi.mocked(getEvents).mockReturnValue([
      {
        type: 'permission_denied',
        timestamp: 1000,
        hookEvent: 'PermissionDenied',
        tool_name: 'mcp__memory__create_entities',
        tool_input: { entities: ['a'] },
      },
    ]);

    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);

    const badges = (container as unknown as FakeElement)
      .querySelectorAll('.inspector-badge')
      .map((el) => el.textContent);
    const desc = (container as unknown as FakeElement).querySelector('.inspector-desc');

    expect(badges).toContain('Denied');
    expect(badges).toContain('MCP');
    expect(desc?.textContent).toBe('memory / create_entities');
  });

  it('does not add an MCP badge for regular tools', () => {
    vi.mocked(getEvents).mockReturnValue([
      {
        type: 'tool_use',
        timestamp: 1000,
        hookEvent: 'PostToolUse',
        tool_name: 'Bash',
      },
    ]);

    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);

    const badges = (container as unknown as FakeElement)
      .querySelectorAll('.inspector-badge')
      .map((el) => el.textContent);

    expect(badges).toContain('Tool');
    expect(badges).not.toContain('MCP');
  });
});

// Helper to create minimal InspectorEvent
function ev(type: InspectorEvent['type'], timestamp: number, extra?: Partial<InspectorEvent>): InspectorEvent {
  return { type, timestamp, hookEvent: type, ...extra };
}

describe('session-inspector timeline event descriptions', () => {
  beforeEach(() => {
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  /** Render one event and return its description text. */
  function descFor(event: InspectorEvent): string | undefined {
    vi.mocked(getEvents).mockReturnValue([event]);
    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);
    return (container as unknown as FakeElement).querySelector('.inspector-desc')?.textContent;
  }

  // Each of these previously read a field Claude Code never sends, so every row
  // fell through to its generic fallback string.
  it('renders ConfigChange from file_path, not the nonexistent config_key', () => {
    expect(descFor({
      type: 'config_change', timestamp: 1, hookEvent: 'ConfigChange',
      file_path: '/home/u/.claude/settings.json', source: 'user_settings',
    })).toBe('Config: /home/u/.claude/settings.json');
  });

  it('renders Elicitation from message, not the nonexistent question', () => {
    expect(descFor({
      type: 'elicitation', timestamp: 1, hookEvent: 'Elicitation',
      message: 'Pick a branch', mcp_server_name: 'git',
    })).toBe('Pick a branch');
  });

  it('falls back to the MCP server name when an elicitation has no message', () => {
    expect(descFor({
      type: 'elicitation', timestamp: 1, hookEvent: 'Elicitation', mcp_server_name: 'git',
    })).toBe('git');
  });

  it('renders ElicitationResult from action', () => {
    expect(descFor({
      type: 'elicitation_result', timestamp: 1, hookEvent: 'ElicitationResult', action: 'accept',
    })).toBe('Elicitation accept');
  });

  // The common `cwd` field is the directory the hook ran in — the value
  // *before* the change — so rendering it here was actively misleading.
  it('renders CwdChanged from new_cwd', () => {
    expect(descFor({
      type: 'cwd_changed', timestamp: 1, hookEvent: 'CwdChanged',
      new_cwd: '/repo/packages/api',
    })).toBe('/repo/packages/api');
  });

  it('renders FileChanged with its change kind', () => {
    expect(descFor({
      type: 'file_changed', timestamp: 1, hookEvent: 'FileChanged',
      file_path: '/repo/.env', event: 'modified',
    })).toBe('modified: /repo/.env');
  });

  it('renders Notification with its title', () => {
    expect(descFor({
      type: 'notification', timestamp: 1, hookEvent: 'Notification',
      title: 'Permission needed', message: 'Claude needs your permission',
      notification_type: 'permission_prompt',
    })).toBe('Permission needed: Claude needs your permission');
  });

  // TeammateIdle carries no agent_id or agent_type, so the agentLabel
  // fallback never resolved to anything useful.
  it('renders TeammateIdle from teammate_name', () => {
    expect(descFor({
      type: 'teammate_idle', timestamp: 1, hookEvent: 'TeammateIdle',
      teammate_name: 'reviewer',
    })).toBe('Teammate idle: reviewer');
  });

  it('renders SessionEnd with its reason', () => {
    expect(descFor({
      type: 'session_end', timestamp: 1, hookEvent: 'SessionEnd', reason: 'clear',
    })).toBe('Session ended: clear');
  });

  it('prefers a task subject over the raw task id', () => {
    expect(descFor({
      type: 'task_completed', timestamp: 1, hookEvent: 'TaskCompleted',
      task_id: 'task-001', task_subject: 'Ship the release',
    })).toBe('Task completed: Ship the release');
  });

  it('falls back to the generic label when a field is absent', () => {
    expect(descFor({ type: 'config_change', timestamp: 1, hookEvent: 'ConfigChange' }))
      .toBe('Config changed');
    expect(descFor({ type: 'cwd_changed', timestamp: 1, hookEvent: 'CwdChanged' }))
      .toBe('Working directory changed');
  });
});

describe('buildAgentModel', () => {
  it('pairs sequential agents correctly', () => {
    const events: InspectorEvent[] = [
      ev('subagent_start', 1000, { agent_id: 'A' }),
      ev('tool_use', 1100, { tool_name: 'Bash', agent_id: 'A' }),
      ev('subagent_stop', 1200, { agent_id: 'A' }),
      ev('subagent_start', 1300, { agent_id: 'B' }),
      ev('tool_use', 1400, { tool_name: 'Read', agent_id: 'B' }),
      ev('subagent_stop', 1500, { agent_id: 'B' }),
    ];
    const model = buildAgentModel(events, 0);

    expect(model.spans.get('A')!.startIdx).toBe(0);
    expect(model.spans.get('A')!.stopIdx).toBe(2);
    expect(model.spans.get('B')!.startIdx).toBe(3);
    expect(model.spans.get('B')!.stopIdx).toBe(5);

    // Both top-level
    expect(model.spans.get('A')!.parentAgentId).toBeNull();
    expect(model.spans.get('B')!.parentAgentId).toBeNull();

    // Event attribution
    expect(model.eventOwner.get(1)).toBe('A');
    expect(model.eventOwner.get(4)).toBe('B');
  });

  it('renders overlapping agents as siblings and trusts event agent_id ownership', () => {
    const events: InspectorEvent[] = [
      ev('subagent_start', 1000, { agent_id: 'A' }),
      ev('subagent_start', 1100, { agent_id: 'B' }),
      ev('tool_use', 1200, { tool_name: 'Bash', agent_id: 'A' }),
      ev('tool_use', 1300, { tool_name: 'Read', agent_id: 'B' }),
      ev('subagent_stop', 1400, { agent_id: 'A' }),
      ev('subagent_stop', 1500, { agent_id: 'B' }),
    ];
    const model = buildAgentModel(events, 0);

    expect(model.spans.get('A')!.parentAgentId).toBeNull();
    expect(model.spans.get('B')!.parentAgentId).toBeNull();

    expect(model.eventOwner.get(2)).toBe('A');
    expect(model.eventOwner.get(3)).toBe('B');
    expect(model.spans.get('A')!.childEventIndices).toEqual([2]);
    expect(model.spans.get('B')!.childEventIndices).toEqual([3]);
  });

  it('keeps events without agent_id at the top level even while agents are open', () => {
    const events: InspectorEvent[] = [
      ev('subagent_start', 1000, { agent_id: 'A' }),
      ev('subagent_start', 1100, { agent_id: 'B' }),
      ev('tool_use', 1200, { tool_name: 'Bash' }),
      ev('subagent_stop', 1300, { agent_id: 'B' }),
      ev('tool_use', 1400, { tool_name: 'Read', agent_id: 'A' }),
      ev('subagent_stop', 1500, { agent_id: 'A' }),
    ];
    const model = buildAgentModel(events, 0);

    expect(model.spans.get('A')!.parentAgentId).toBeNull();
    expect(model.spans.get('B')!.parentAgentId).toBeNull();
    expect(model.eventOwner.has(2)).toBe(false);
    expect(model.eventOwner.get(4)).toBe('A');
    expect(model.spans.get('A')!.childEventIndices).toEqual([4]);
    expect(model.spans.get('B')!.childEventIndices).toEqual([]);
  });

  it('handles running agents (no stop event)', () => {
    const events: InspectorEvent[] = [
      ev('subagent_start', 1000, { agent_id: 'A' }),
      ev('tool_use', 1100, { tool_name: 'Bash', agent_id: 'A' }),
    ];
    const model = buildAgentModel(events, 0);

    expect(model.spans.get('A')!.isRunning).toBe(true);
    expect(model.spans.get('A')!.stopIdx).toBe(events.length);
    expect(model.eventOwner.get(1)).toBe('A');
  });

  it('top-level events before any agent are not attributed', () => {
    const events: InspectorEvent[] = [
      ev('user_prompt', 900),
      ev('tool_use', 950, { tool_name: 'Read' }),
      ev('subagent_start', 1000, { agent_id: 'A' }),
      ev('subagent_stop', 1100, { agent_id: 'A' }),
    ];
    const model = buildAgentModel(events, 0);

    expect(model.eventOwner.has(0)).toBe(false);
    expect(model.eventOwner.has(1)).toBe(false);
  });

  it('attaches non-lifecycle agent events by their own agent_id', () => {
    const events: InspectorEvent[] = [
      ev('subagent_start', 1000, { agent_id: 'A' }),
      ev('subagent_start', 1100, { agent_id: 'B' }),
      ev('teammate_idle', 1200, { agent_id: 'A', agent_type: 'Explore' }),
      ev('notification', 1300, { message: 'top-level notice' }),
      ev('teammate_idle', 1400, { agent_id: 'B', agent_type: 'Plan' }),
      ev('subagent_stop', 1500, { agent_id: 'A' }),
      ev('subagent_stop', 1600, { agent_id: 'B' }),
    ];
    const model = buildAgentModel(events, 0);

    expect(model.eventOwner.get(2)).toBe('A');
    expect(model.eventOwner.has(3)).toBe(false);
    expect(model.eventOwner.get(4)).toBe('B');
    expect(model.spans.get('A')!.childEventIndices).toEqual([2]);
    expect(model.spans.get('B')!.childEventIndices).toEqual([4]);
  });

  it('stopIndices contains all stop event indices', () => {
    const events: InspectorEvent[] = [
      ev('subagent_start', 1000, { agent_id: 'A' }),
      ev('subagent_stop', 1100, { agent_id: 'A' }),
      ev('subagent_start', 1200, { agent_id: 'B' }),
      ev('subagent_stop', 1300, { agent_id: 'B' }),
    ];
    const model = buildAgentModel(events, 0);

    expect(model.stopIndices).toEqual(new Set([1, 3]));
  });
});

describe('renderTimeline agent grouping', () => {
  beforeEach(() => {
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    inspectorState.expandedRows.clear();
    inspectorState.autoExpandedAgentGroups.clear();
  });

  it('renders overlapping agents as sibling groups', () => {
    inspectorState.expandedRows.clear();
    inspectorState.expandedRows.add('agent-group:A');
    inspectorState.expandedRows.add('agent-group:B');

    vi.mocked(getEvents).mockReturnValue([
      ev('subagent_start', 1000, { agent_id: 'A', agent_type: 'Explore' }),
      ev('subagent_start', 1100, { agent_id: 'B', agent_type: 'Plan' }),
      ev('tool_use', 1200, { tool_name: 'Bash', agent_id: 'A' }),
      ev('subagent_stop', 1300, { agent_id: 'A' }),
      ev('subagent_stop', 1400, { agent_id: 'B' }),
    ]);

    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);

    const timeline = (container as unknown as FakeElement).querySelector('.inspector-timeline');
    const topGroups = timeline!.children.filter(
      (c) => c.className.includes('inspector-agent-group')
    );
    expect(topGroups.length).toBe(2);
    expect(topGroups[0].querySelectorAll('.inspector-agent-group')).toHaveLength(0);
    expect(topGroups[1].querySelectorAll('.inspector-agent-group')).toHaveLength(0);
  });

  it('renders only matching child events inside each expanded agent group', () => {
    inspectorState.expandedRows.add('agent-group:A');
    inspectorState.expandedRows.add('agent-group:B');

    vi.mocked(getEvents).mockReturnValue([
      ev('subagent_start', 1000, { agent_id: 'A', agent_type: 'Explore' }),
      ev('subagent_start', 1100, { agent_id: 'B', agent_type: 'Plan' }),
      ev('tool_use', 1200, { tool_name: 'Bash', agent_id: 'A' }),
      ev('tool_use', 1250, { tool_name: 'Read', agent_id: 'B' }),
      ev('notification', 1275, { message: 'top-level notice' }),
      ev('subagent_stop', 1300, { agent_id: 'B' }),
      ev('subagent_stop', 1400, { agent_id: 'A' }),
    ]);

    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);

    const timeline = (container as unknown as FakeElement).querySelector('.inspector-timeline');
    const topGroups = timeline!.children.filter(
      (c) => c.className.includes('inspector-agent-group')
    );
    expect(topGroups.length).toBe(2);

    const topLevelDescs = timeline!.children
      .flatMap((c) => c.querySelectorAll('.inspector-desc'))
      .map((el) => el.textContent);
    expect(topLevelDescs).toContain('top-level notice');

    const groupTexts = topGroups.map((group) =>
      group.querySelectorAll('.inspector-desc').map((row) => row.textContent).join(' | ')
    );
    expect(groupTexts[0]).toContain('Bash');
    expect(groupTexts[0]).not.toContain('Read');
    expect(groupTexts[1]).toContain('Read');
    expect(groupTexts[1]).not.toContain('Bash');
  });

  it('auto-expands a running agent group only once', () => {
    vi.mocked(getEvents).mockReturnValue([
      ev('subagent_start', 1000, { agent_id: 'A', agent_type: 'Explore' }),
      ev('tool_use', 1100, { tool_name: 'Bash', agent_id: 'A' }),
    ]);

    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);

    const firstGroup = (container as unknown as FakeElement).querySelector('.inspector-agent-group');
    expect(firstGroup?.querySelector('.inspector-agent-children')).not.toBeNull();
    expect(inspectorState.expandedRows.has('agent-group:A')).toBe(true);
    expect(inspectorState.autoExpandedAgentGroups.has('session-1:agent-group:A')).toBe(true);

    const header = firstGroup?.querySelector('.inspector-agent-header') as FakeElement;
    header.listeners.get('click')?.[0]?.();
    expect(inspectorState.expandedRows.has('agent-group:A')).toBe(false);

    vi.mocked(getEvents).mockReturnValue([
      ev('subagent_start', 1000, { agent_id: 'A', agent_type: 'Explore' }),
      ev('tool_use', 1100, { tool_name: 'Bash', agent_id: 'A' }),
      ev('tool_use', 1200, { tool_name: 'Read', agent_id: 'A' }),
    ]);

    const rerenderedContainer = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(rerenderedContainer);

    const rerenderedGroup = (rerenderedContainer as unknown as FakeElement).querySelector('.inspector-agent-group');
    expect(rerenderedGroup?.querySelector('.inspector-agent-children')).toBeNull();
    expect(inspectorState.expandedRows.has('agent-group:A')).toBe(false);
  });

  it('keeps a manually reopened running agent group open across rerenders', () => {
    inspectorState.autoExpandedAgentGroups.add('session-1:agent-group:A');

    vi.mocked(getEvents).mockReturnValue([
      ev('subagent_start', 1000, { agent_id: 'A', agent_type: 'Explore' }),
      ev('tool_use', 1100, { tool_name: 'Bash', agent_id: 'A' }),
    ]);

    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);

    const group = (container as unknown as FakeElement).querySelector('.inspector-agent-group');
    const header = group?.querySelector('.inspector-agent-header') as FakeElement;
    header.listeners.get('click')?.[0]?.();
    expect(inspectorState.expandedRows.has('agent-group:A')).toBe(true);

    vi.mocked(getEvents).mockReturnValue([
      ev('subagent_start', 1000, { agent_id: 'A', agent_type: 'Explore' }),
      ev('tool_use', 1100, { tool_name: 'Bash', agent_id: 'A' }),
      ev('tool_use', 1200, { tool_name: 'Read', agent_id: 'A' }),
    ]);

    const rerenderedContainer = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(rerenderedContainer);

    const rerenderedGroup = (rerenderedContainer as unknown as FakeElement).querySelector('.inspector-agent-group');
    expect(rerenderedGroup?.querySelector('.inspector-agent-children')).not.toBeNull();
    expect(inspectorState.expandedRows.has('agent-group:A')).toBe(true);
  });

  it('still auto-expands a different newly seen running agent', () => {
    inspectorState.autoExpandedAgentGroups.add('session-1:agent-group:A');

    vi.mocked(getEvents).mockReturnValue([
      ev('subagent_start', 1000, { agent_id: 'A', agent_type: 'Explore' }),
      ev('tool_use', 1100, { tool_name: 'Bash', agent_id: 'A' }),
      ev('subagent_start', 1200, { agent_id: 'B', agent_type: 'Plan' }),
      ev('tool_use', 1300, { tool_name: 'Read', agent_id: 'B' }),
    ]);

    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);

    const groups = (container as unknown as FakeElement).querySelectorAll('.inspector-agent-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.querySelector('.inspector-agent-children')).toBeNull();
    expect(groups[1]?.querySelector('.inspector-agent-children')).not.toBeNull();
    expect(inspectorState.expandedRows.has('agent-group:A')).toBe(false);
    expect(inspectorState.expandedRows.has('agent-group:B')).toBe(true);
    expect(inspectorState.autoExpandedAgentGroups.has('session-1:agent-group:B')).toBe(true);
  });
});

describe('PA-14 append-only reconcile', () => {
  beforeEach(() => {
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    inspectorState.expandedRows.clear();
    inspectorState.autoExpandedAgentGroups.clear();
  });

  it('appends rows for events that arrived since the last render, preserving row identity', () => {
    const events = [ev('session_start', 1000), ev('tool_use', 2000, { tool_name: 'Bash' })];
    vi.mocked(getEvents).mockReturnValue(events);
    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);
    const c = container as unknown as FakeElement;
    const rowsBefore = c.querySelectorAll('.inspector-timeline-row');
    expect(rowsBefore).toHaveLength(2);
    const firstRow = rowsBefore[0];

    events.push(ev('stop', 3000));
    expect(appendTimelineEvents(container)).toBe(true);

    const rowsAfter = c.querySelectorAll('.inspector-timeline-row');
    expect(rowsAfter).toHaveLength(3);
    expect(rowsAfter[0]).toBe(firstRow); // identity preserved — no wipe
    // The old tail row had no duration (no successor at render time); the
    // append fills in what a full rebuild would have shown.
    expect(rowsBefore[1].querySelector('.inspector-duration')!.textContent).not.toBe('');
  });

  it('appends children to a running agent group and closes the header on stop', () => {
    const events = [
      ev('session_start', 1000),
      ev('subagent_start', 2000, { agent_id: 'a1', agent_type: 'worker' }),
    ];
    vi.mocked(getEvents).mockReturnValue(events);
    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);
    const c = container as unknown as FakeElement;
    const group = c.querySelector('.inspector-agent-group')!;
    expect(group.classList.contains('inspector-agent-running')).toBe(true);

    events.push(ev('tool_use', 3000, { agent_id: 'a1', tool_name: 'Bash' }));
    expect(appendTimelineEvents(container)).toBe(true);
    // header + start row + one child
    expect(group.querySelectorAll('.inspector-timeline-row')).toHaveLength(3);

    events.push(ev('subagent_stop', 4000, { agent_id: 'a1' }));
    expect(appendTimelineEvents(container)).toBe(true);
    expect(group.classList.contains('inspector-agent-running')).toBe(false);
    expect(group.querySelector('.inspector-badge-agent')!.textContent).toBe('Agent');
    // header + start + child + stop
    expect(group.querySelectorAll('.inspector-timeline-row')).toHaveLength(4);
  });

  it('bails to a full rebuild when the event array is replaced (/clear)', () => {
    const events = [ev('session_start', 1000)];
    vi.mocked(getEvents).mockReturnValue(events);
    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);
    vi.mocked(getEvents).mockReturnValue([ev('session_start', 5000)]);
    expect(appendTimelineEvents(container)).toBe(false);
  });

  it('bails to a full rebuild when the event cap shifts the array in place', () => {
    const events = [ev('session_start', 1000), ev('tool_use', 2000)];
    vi.mocked(getEvents).mockReturnValue(events);
    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);
    events.shift(); // cap rotation: same length, window head moved
    events.push(ev('tool_use', 3000));
    expect(appendTimelineEvents(container)).toBe(false);
  });

  it('bails after the container content was wiped (tab switch)', () => {
    const events = [ev('session_start', 1000)];
    vi.mocked(getEvents).mockReturnValue(events);
    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);
    const c = container as unknown as FakeElement;
    c.innerHTML = ''; // stand-in for content.innerHTML = ''
    events.push(ev('tool_use', 2000));
    expect(appendTimelineEvents(container)).toBe(false);
  });

  // S4-01: trimWindow used to move startIdx without re-anchoring
  // firstWindowTs, so the first trim turned every later append into a
  // "cap shift" bail — a full 500-row rebuild on the next 200 ms tick,
  // the exact pathology PA-14 exists to prevent.
  it('keeps appending incrementally after the 500-row window trims', () => {
    const events = Array.from({ length: 501 }, (_, i) =>
      ev('tool_use', 1000 + i, { tool_name: 'Bash' }),
    );
    vi.mocked(getEvents).mockReturnValue(events);
    const container = new FakeElement('div') as unknown as HTMLElement;
    renderTimeline(container);
    const c = container as unknown as FakeElement;
    // 501 events, 500-row window: the banner appears, row 0 is not rendered.
    expect(c.querySelector('.inspector-load-more')).not.toBeNull();
    expect(c.querySelectorAll('.inspector-timeline-row')).toHaveLength(500);

    events.push(ev('tool_use', 1600, { tool_name: 'Read' }));
    expect(appendTimelineEvents(container)).toBe(true); // trims the head row
    expect(c.querySelectorAll('.inspector-timeline-row')).toHaveLength(500);

    const rowsAfterTrim = c.querySelectorAll('.inspector-timeline-row');
    events.push(ev('tool_use', 1700, { tool_name: 'Write' }));
    // Pre-fix this returned false: startIdx had moved past the stale
    // firstWindowTs, so the append looked like an in-place cap shift.
    expect(appendTimelineEvents(container)).toBe(true);
    const rowsAfterSecond = c.querySelectorAll('.inspector-timeline-row');
    expect(rowsAfterSecond).toHaveLength(500);
    // Row identity preserved across trim+append — incremental, no wipe.
    expect(rowsAfterSecond[0]).toBe(rowsAfterTrim[1]);
  });
});
