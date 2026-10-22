// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderConfig } from '../../../types.js';
import type { WidgetHost } from './widget-host.js';

vi.mock('../../../state.js', () => ({
  appState: {
    projects: [{ id: 'p1', path: '/repo/p1' }],
    preferences: {},
    profiles: [],
  },
}));
vi.mock('../../../provider-availability.js', () => ({
  getAvailableProviderMetas: () => [],
  getProviderAvailabilitySnapshot: () => ({}),
  loadProviderAvailability: vi.fn(async () => {}),
}));
vi.mock('../../../state/specialized-sessions.js', () => ({ resolveProfile: () => undefined }));
vi.mock('../../../open-file-reader.js', () => ({ openFileReaderChecked: vi.fn() }));
vi.mock('../../mcp-add-modal.js', () => ({ showMcpAddModal: vi.fn() }));
vi.mock('../../custom-select.js', () => ({ createCustomSelect: vi.fn() }));

import { createProviderToolsWidget } from './provider-tools-widget.js';

const getConfig = vi.fn();
let fireConfigChanged: () => void = () => {};

function stubProvider(): void {
  (window as unknown as { finevibe: unknown }).finevibe = {
    provider: {
      getConfig: (...args: unknown[]) => getConfig(...args),
      watchProject: vi.fn(),
      onConfigChanged: vi.fn((cb: () => void) => {
        fireConfigChanged = cb;
        return () => {};
      }),
    },
  };
}

/** One named MCP server, so the rendered body is identifiable by `label`. */
function config(label: string): ProviderConfig {
  return {
    mcpServers: [{ name: label, status: 'ok', scope: 'project' }],
    agents: [],
    skills: [],
    commands: [],
  } as unknown as ProviderConfig;
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  getConfig.mockReset();
  fireConfigChanged = () => {};
  stubProvider();
});

describe('provider-tools-widget config race (CI-12)', () => {
  it('a superseded config rejection leaves the live sections alone', async () => {
    const first = Promise.withResolvers<ProviderConfig>();
    const second = Promise.withResolvers<ProviderConfig>();
    getConfig.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const widget = createProviderToolsWidget({ projectId: 'p1' } as WidgetHost); // refresh #1 in flight
    widget.refresh(); // refresh #2 supersedes it (provider switch / config-changed)

    second.resolve(config('FRESH'));
    await flush();
    expect(widget.element.textContent).toContain('FRESH');

    first.reject(new Error('aborted by provider switch'));
    await flush();

    // CI-12: the stale rejection's catch ran `body.innerHTML = ''` before its
    // token check, so the late failure of an abandoned request blanked the
    // freshly rendered widget.
    expect(widget.element.textContent).toContain('FRESH');
    expect(widget.element.querySelector('.project-tab-tools-body')!.children.length).toBeGreaterThan(0);
  });

  it('the config-changed event refreshes and a live rejection still clears the body', async () => {
    const pending = Promise.withResolvers<ProviderConfig>();
    getConfig.mockReturnValueOnce(Promise.resolve(config('FIRST'))).mockReturnValueOnce(pending.promise);

    const widget = createProviderToolsWidget({ projectId: 'p1' } as WidgetHost);
    await flush();
    expect(widget.element.textContent).toContain('FIRST');

    fireConfigChanged();
    await flush();
    expect(getConfig).toHaveBeenCalledTimes(2);

    // The live generation's own failure still blanks the body: the guard gates
    // stale generations only.
    pending.reject(new Error('config dir unreadable'));
    await flush();
    expect(widget.element.querySelector('.project-tab-tools-body')!.children.length).toBe(0);
    expect(widget.element.textContent).not.toContain('FIRST');
  });
});
