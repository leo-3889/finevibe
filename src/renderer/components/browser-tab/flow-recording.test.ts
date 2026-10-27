// @vitest-environment jsdom
// N-row close (FEATURE_LEDGER_2026-10-26 §6): flow recording/picker was
// UNTESTED. Pins the recording contract: numbered step rows with per-type
// rendering, the 100-step cap, toggle wiring (record button, disabled
// siblings, webview messages), and the built prompt format.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserTabInstance, FlowStep } from './types.js';

vi.mock('./selector-ui.js', () => ({
  buildSelectorOptions: (selectors: Array<{ value: string }>) => {
    const el = document.createElement('div');
    el.textContent = selectors.map((s) => s.value).join(',');
    return el;
  },
}));
const safeSend = vi.fn();
const sanitizeArgPrompt = vi.fn((s: string) => s);
vi.mock('./prompt-utils.js', () => ({ safeSend: (...a: unknown[]) => safeSend(...a), sanitizeArgPrompt: (s: string) => sanitizeArgPrompt(s) }));

import { renderFlowSteps, addFlowStep, toggleFlowMode, clearFlow, buildFlowPrompt } from './flow-recording.js';

function makeInstance(steps: FlowStep[] = []): BrowserTabInstance {
  const el = () => {
    const e = document.createElement('div');
    e.style = { display: '', removeProperty() {} } as never;
    e.classList = { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false } as never;
    e.appendChild = () => {};
    return e;
  };
  const input = document.createElement('input');
  return {
    flowStepsList: document.createElement('div'),
    flowSteps: steps,
    flowMode: false,
    recordBtn: Object.assign(document.createElement('button'), { textContent: '● Record' }),
    inspectBtn: Object.assign(document.createElement('button'), { disabled: false }),
    drawBtn: Object.assign(document.createElement('button'), { disabled: false }),
    flowPanel: el(),
    flowInputRow: el(),
    flowPanelLabel: el(),
    flowInstructionInput: input,
    webview: {} as never,
  } as unknown as BrowserTabInstance;
}

const clickStep: FlowStep = {
  type: 'click', tagName: 'button', textContent: 'Save', pageUrl: 'https://x.dev/a',
  selectors: [{ value: '#save' }, { value: 'button.cta' }],
  activeSelector: { value: '#save' },
} as FlowStep;
const navStep: FlowStep = { type: 'navigate', url: 'https://x.dev/b' } as FlowStep;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('flow-recording', () => {
  it('renders numbered rows per step type and removes via the × button', () => {
    const inst = makeInstance([clickStep, navStep]);
    renderFlowSteps(inst);
    const rows = inst.flowStepsList.querySelectorAll('.flow-step');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('1.');
    expect(rows[0].textContent).toContain('click');
    expect(rows[0].textContent).toContain('<button>');
    expect(rows[0].textContent).toContain('"Save"');
    expect(rows[0].querySelector('.flow-step-selectors')!.textContent).toBe('#save,button.cta');
    expect(rows[1].querySelector('.flow-step-url')!.textContent).toContain('https://x.dev/b');
    expect(inst.flowPanelLabel.textContent).toBe('Flow (2 steps)');

    rows[0].querySelector('.flow-step-remove')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(inst.flowSteps.length).toBe(1);
    expect(inst.flowSteps[0]).toBe(navStep);
  });

  it('addFlowStep caps the recording at 100 steps', () => {
    const inst = makeInstance(Array.from({ length: 100 }, (_, i) => ({ type: 'navigate', url: `u${i}` }) as FlowStep));
    addFlowStep(inst, navStep);
    expect(inst.flowSteps.length).toBe(100);
    expect(inst.flowSteps[99]).toEqual({ type: 'navigate', url: 'u99' });
  });

  it('toggleFlowMode wires the buttons and messages the webview both ways', () => {
    const inst = makeInstance();
    toggleFlowMode(inst);
    expect(inst.flowMode).toBe(true);
    expect(inst.recordBtn.textContent).toBe('■ Stop');
    expect(inst.inspectBtn.disabled).toBe(true);
    expect(inst.drawBtn.disabled).toBe(true);
    expect(safeSend).toHaveBeenCalledWith(inst.webview, 'enter-flow-mode');

    toggleFlowMode(inst);
    expect(inst.flowMode).toBe(false);
    expect(inst.recordBtn.textContent).toBe('● Record');
    expect(inst.inspectBtn.disabled).toBe(false);
    expect(safeSend).toHaveBeenCalledWith(inst.webview, 'exit-flow-mode');
  });

  it('buildFlowPrompt formats every step kind and requires an instruction', () => {
    const inst = makeInstance([clickStep, navStep]);
    expect(buildFlowPrompt(inst)).toBeNull(); // no instruction yet
    inst.flowInstructionInput.value = '  rerun it  ';
    const prompt = buildFlowPrompt(inst)!;
    expect(prompt).toContain('Recorded browser flow (2 steps):');
    expect(prompt).toContain("1. Click: <button> \"Save\" at https://x.dev/a\n   selector: '#save'");
    expect(prompt).toContain('2. Navigate to: https://x.dev/b');
    expect(prompt).toContain('Instructions: rerun it');
  });

  it('clearFlow empties steps and fires the input event; dismissFlow also exits mode', () => {
    const inst = makeInstance([navStep]);
    inst.flowMode = true;
    const onInput = vi.fn();
    inst.flowInstructionInput.addEventListener('input', onInput);
    clearFlow(inst);
    expect(inst.flowSteps).toEqual([]);
    expect(inst.flowInstructionInput.value).toBe('');
    expect(onInput).toHaveBeenCalled();

    const inst2 = makeInstance([navStep]);
    inst2.flowMode = true;
    import('./flow-recording.js').then(({ dismissFlow }) => {
      dismissFlow(inst2);
      expect(inst2.flowMode).toBe(false);
      expect(inst2.flowSteps).toEqual([]);
    });
  });
});
