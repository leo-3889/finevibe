import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGeneralSection } from './preferences/general-section.js';
import { shouldActivateAskAiSession } from '../ask-ai-focus.js';

describe('shouldActivateAskAiSession', () => {
  it('activates when the preference is absent (pre-setting installs keep the switch behavior)', () => {
    expect(shouldActivateAskAiSession({})).toBe(true);
  });

  it('activates for an explicit "switch"', () => {
    expect(shouldActivateAskAiSession({ askAiFocus: 'switch' })).toBe(true);
  });

  it('stays in the background only for "stay"', () => {
    expect(shouldActivateAskAiSession({ askAiFocus: 'stay' })).toBe(false);
  });

  it('treats a missing preferences object as the "switch" default', () => {
    expect(shouldActivateAskAiSession(undefined)).toBe(true);
    expect(shouldActivateAskAiSession(null)).toBe(true);
  });
});

// The General-section widget for the preference: a custom-select row that
// renders both options and persists the choice on save().
const mockState = vi.hoisted(() => ({
  preferences: {
    soundOnSessionWaiting: false,
    notificationsDesktop: false,
    debugMode: false,
    sessionHistoryEnabled: true,
    insightsEnabled: false,
    autoTitleEnabled: false,
    confirmCloseWorkingSession: true,
    askAiFocus: undefined as 'switch' | 'stay' | undefined,
  },
  on: vi.fn(() => () => {}),
  setPreference: vi.fn(),
  setLocale: vi.fn(),
}));

const selectState = vi.hoisted(() => {
  const instances = new Map<string, {
    element: Record<string, unknown>;
    options: Array<{ value: string; label: string }>;
    getValue: () => string;
    setValue: (value: string) => void;
    destroy: () => void;
  }>();
  return { instances, reset: () => instances.clear() };
});

function makeElement(tagName = 'div'): Record<string, any> {
  const children: Record<string, any>[] = [];
  const element: Record<string, any> = {
    tagName,
    children,
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    htmlFor: '',
    id: '',
    type: '',
    checked: false,
    appendChild(child: Record<string, any>) {
      child.parentElement = element;
      children.push(child);
      return child;
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return element;
}

vi.mock('../state.js', () => ({ appState: mockState }));
vi.mock('../provider-availability.js', () => ({
  loadProviderAvailability: vi.fn(async () => {}),
  getProviderAvailabilitySnapshot: vi.fn(() => ({ providers: [], availability: new Map() })),
}));
vi.mock('./custom-select.js', () => ({
  createCustomSelect: vi.fn((id: string, options: Array<{ value: string; label: string }>, initialValue?: string) => {
    let value = initialValue ?? options[0]?.value ?? '';
    const instance = {
      element: makeElement('div'),
      options,
      getValue: () => value,
      setValue(next: string) { value = next; },
      destroy() {},
    };
    selectState.instances.set(id, instance);
    return instance;
  }),
}));

const { createGeneralSection } = await import('./preferences/general-section.js');

describe('general section — Ask AI focus preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectState.reset();
    mockState.preferences.askAiFocus = undefined;
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeElement(tag),
      createTextNode: (text: string) => ({ textContent: text }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  function renderGeneralSection() {
    const section = createGeneralSection({ isActiveSection: () => true } as never);
    const container = makeElement('div');
    section.render!(container);
    return { section, container };
  }

  it('renders a select with both options, defaulting to "switch" when the preference is absent', () => {
    renderGeneralSection();
    const select = selectState.instances.get('pref-ask-ai-focus')!;
    expect(select).toBeDefined();
    expect(select.options.map((o) => o.value)).toEqual(['switch', 'stay']);
    expect(select.getValue()).toBe('switch');
  });

  it('renders the persisted "stay" value', () => {
    mockState.preferences.askAiFocus = 'stay';
    renderGeneralSection();
    expect(selectState.instances.get('pref-ask-ai-focus')!.getValue()).toBe('stay');
  });

  it('save() persists the chosen value', () => {
    const { section } = renderGeneralSection();
    selectState.instances.get('pref-ask-ai-focus')!.setValue('stay');
    section.save!();
    expect(mockState.setPreference).toHaveBeenCalledWith('askAiFocus', 'stay');
  });
});
