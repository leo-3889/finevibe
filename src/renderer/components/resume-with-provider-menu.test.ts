import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliProviderMeta, ProviderId } from '../../shared/types.js';

const getProviderAvailabilitySnapshot = vi.fn();

vi.mock('../provider-availability.js', () => ({
  getProviderAvailabilitySnapshot,
}));

class FakeElement {
  className = '';
  textContent = '';
  listeners = new Map<string, Array<(event: { stopPropagation: () => void }) => void>>();

  addEventListener(event: string, cb: (event: { stopPropagation: () => void }) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(cb);
    this.listeners.set(event, existing);
  }

  dispatchClick(): void {
    const event = { stopPropagation: vi.fn() };
    for (const cb of this.listeners.get('click') ?? []) cb(event);
  }
}

class FakeDocument {
  createElement(_tagName: string): FakeElement {
    return new FakeElement();
  }
}

function provider(id: ProviderId, displayName: string): CliProviderMeta {
  return {
    id,
    displayName,
    capabilities: { hooks: true } as CliProviderMeta['capabilities'],
  } as CliProviderMeta;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal('document', new FakeDocument());
  getProviderAvailabilitySnapshot.mockReset();
});

describe('buildResumeWithProviderItems', () => {
  it('renders a separator and one clickable item for each available alternative provider', async () => {
    getProviderAvailabilitySnapshot.mockReturnValue({
      providers: [
        provider('claude', 'Claude Code'),
        provider('codex', 'Codex CLI'),
        provider('gemini', 'Gemini CLI'),
      ],
      availability: new Map<ProviderId, boolean>([
        ['claude', true],
        ['codex', true],
        ['gemini', false],
      ]),
    });

    const { buildResumeWithProviderItems } = await import('./resume-with-provider-menu.js');
    const onPick = vi.fn();
    const items = buildResumeWithProviderItems('claude', onPick);

    expect(items).toHaveLength(2);
    expect(items[0].className).toBe('tab-context-menu-separator');
    expect(items[1].className).toBe('tab-context-menu-item');
    expect(items[1].textContent).toBe('Resume with Codex CLI');

    (items[1] as unknown as FakeElement).dispatchClick();
    expect(onPick).toHaveBeenCalledWith('codex');
  });

  it('omits unavailable providers entirely', async () => {
    getProviderAvailabilitySnapshot.mockReturnValue({
      providers: [
        provider('claude', 'Claude Code'),
        provider('codex', 'Codex CLI'),
      ],
      availability: new Map<ProviderId, boolean>([
        ['claude', true],
        ['codex', false],
      ]),
    });

    const { buildResumeWithProviderItems } = await import('./resume-with-provider-menu.js');
    const items = buildResumeWithProviderItems('claude', vi.fn());

    expect(items).toEqual([]);
  });

  it('returns no items when availability has not loaded yet', async () => {
    getProviderAvailabilitySnapshot.mockReturnValue(null);

    const { buildResumeWithProviderItems } = await import('./resume-with-provider-menu.js');
    const items = buildResumeWithProviderItems('claude', vi.fn());

    expect(items).toEqual([]);
  });
});
