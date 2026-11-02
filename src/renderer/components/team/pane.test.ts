// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The pane only orchestrates the shell + team-view; stub the team view so the
// suite stays about the pane's own wiring (row 28: shell extraction).
vi.mock('./team-view.js', () => ({
  renderTeam: vi.fn(),
  hideTeamView: vi.fn(),
}));

import { renderTeam, hideTeamView } from './team-view.js';
import { instances, getTeamInstance } from './instance.js';
import {
  createTeamPane,
  attachTeamToContainer,
  showTeamPane,
  hideAllTeamPanes,
  destroyTeamPane,
} from './pane.js';

const team = {
  render: renderTeam as ReturnType<typeof vi.fn>,
  hideAll: hideTeamView as ReturnType<typeof vi.fn>,
};

beforeEach(() => {
  instances.clear();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('team pane (shared tab-pane shell)', () => {
  it('creates one hidden pane element per session, keyed by session id', () => {
    createTeamPane('s1', 'p1');
    const first = getTeamInstance('s1')!;
    expect(first.element.className).toBe('team-pane hidden');
    expect(first.element.dataset['sessionId']).toBe('s1');
    expect(first.projectId).toBe('p1');

    createTeamPane('s1', 'p1');
    expect(instances.size).toBe(1);
    expect(getTeamInstance('s1')!.element).toBe(first.element);
  });

  it('attaches to a container once, and only moves when the parent changes', () => {
    createTeamPane('s1', 'p1');
    const el = getTeamInstance('s1')!.element;
    const a = document.createElement('div');
    const b = document.createElement('div');

    attachTeamToContainer('s1', a);
    attachTeamToContainer('s1', a);
    expect(a.children).toHaveLength(1);

    attachTeamToContainer('s1', b);
    expect(a.children).toHaveLength(0);
    expect(el.parentElement).toBe(b);

    attachTeamToContainer('missing', a);
    expect(a.children).toHaveLength(0);
  });

  it('show() unhides, toggles split and re-renders the team view', () => {
    createTeamPane('s1', 'p1');
    const el = getTeamInstance('s1')!.element;

    showTeamPane('s1', true);
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.classList.contains('split')).toBe(true);
    expect(team.render).toHaveBeenCalledWith(el);

    showTeamPane('s1', false);
    expect(el.classList.contains('split')).toBe(false);

    team.render.mockClear();
    showTeamPane('missing', false);
    expect(team.render).not.toHaveBeenCalled();
  });

  it('hideAll() hides every pane and releases the team singleton', () => {
    createTeamPane('s1', 'p1');
    createTeamPane('s2', 'p1');
    showTeamPane('s1', false);

    hideAllTeamPanes();
    for (const instance of instances.values()) {
      expect(instance.element.classList.contains('hidden')).toBe(true);
    }
    expect(team.hideAll).toHaveBeenCalledTimes(1);
  });

  it('destroy() drops the registry entry and detaches the element', () => {
    createTeamPane('s1', 'p1');
    const container = document.createElement('div');
    attachTeamToContainer('s1', container);
    const el = getTeamInstance('s1')!.element;

    destroyTeamPane('s1');
    expect(instances.has('s1')).toBe(false);
    expect(el.parentElement).toBeNull();

    destroyTeamPane('missing');
  });
});
