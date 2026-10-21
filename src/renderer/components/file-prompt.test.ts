// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('./tab-bar/session-menu.js', () => ({ promptNewSession: vi.fn() }));
vi.mock('./terminal-pane.js', () => ({ setPendingPrompt: vi.fn() }));
vi.mock('./file-viewer.js', () => ({ getFileViewerInstance: vi.fn() }));
vi.mock('./file-reader.js', () => ({ getFileReaderInstance: vi.fn() }));

const mockState = vi.hoisted(() => ({
  activeProject: null as { id: string; sessions: unknown[] } | null,
  preferences: {},
  addPlanSession: vi.fn(() => ({ id: 's-ask' })),
}));
vi.mock('../state.js', () => ({ appState: mockState }));

// The composer's inline plan-mode checkbox is superseded: the quick send
// takes its value from the per-provider config (shared helper).
const resolvePlanModePreference = vi.hoisted(() => vi.fn(() => true));
vi.mock('../state/specialized-sessions.js', () => ({
  resolvePlanProvider: () => 'claude',
  resolvePlanModePreference,
}));

const { buildPrompt, initFilePrompt } = await import('./file-prompt.js');
const { getFileReaderInstance } = await import('./file-reader.js');
type PaneContext = Parameters<typeof buildPrompt>[0];

const basePane = { paneEl: {} as HTMLElement, bodyEl: {} as HTMLElement, sessionId: 's1' };

describe('buildPrompt', () => {
  it('formats a diff snippet from the file viewer', () => {
    const ctx: PaneContext = {
      ...basePane,
      kind: 'file-viewer',
      filePath: 'src/foo.ts',
      selectedText: '-  old();\n+  new();',
    };
    expect(buildPrompt(ctx, 'Explain why this changed')).toBe(
      'Regarding the following diff snippet from `src/foo.ts`:\n\n```diff\n-  old();\n+  new();\n```\n\nExplain why this changed',
    );
  });

  it('formats a single-line range from raw file reader', () => {
    const ctx: PaneContext = {
      ...basePane,
      kind: 'file-reader',
      viewMode: 'raw',
      filePath: 'src/foo.ts',
      lineStart: 12,
      lineEnd: 12,
      selectedText: 'const x = 1;',
    };
    expect(buildPrompt(ctx, 'rename x')).toBe(
      'Regarding line 12 in `src/foo.ts`:\n\n```\nconst x = 1;\n```\n\nrename x',
    );
  });

  it('formats a multi-line range from raw file reader', () => {
    const ctx: PaneContext = {
      ...basePane,
      kind: 'file-reader',
      viewMode: 'raw',
      filePath: 'src/foo.ts',
      lineStart: 10,
      lineEnd: 14,
      selectedText: 'line1\nline2',
    };
    expect(buildPrompt(ctx, 'refactor')).toBe(
      'Regarding lines 10-14 in `src/foo.ts`:\n\n```\nline1\nline2\n```\n\nrefactor',
    );
  });

  it('quotes selected markdown text from rendered file reader', () => {
    const ctx: PaneContext = {
      ...basePane,
      kind: 'file-reader',
      viewMode: 'rendered',
      filePath: 'README.md',
      selectedText: 'para one\npara two',
    };
    expect(buildPrompt(ctx, 'clarify')).toBe(
      'Regarding the following text in `README.md`:\n\n> para one\n> para two\n\nclarify',
    );
  });

  it('falls back when no line numbers are available in raw view', () => {
    const ctx: PaneContext = {
      ...basePane,
      kind: 'file-reader',
      viewMode: 'raw',
      filePath: 'src/bar.ts',
      selectedText: 'snippet',
    };
    expect(buildPrompt(ctx, 'do thing')).toBe(
      'Regarding the following text in `src/bar.ts`:\n\n```\nsnippet\n```\n\ndo thing',
    );
  });
});


describe('Ask AI composer send', () => {
  it('sends with the config-derived plan-mode value and renders no inline plan-mode row', async () => {
    document.body.innerHTML =
      '<div data-pane-kind="file-reader" data-session-id="s1"><div class="file-reader-body">' +
      '<span id="sel">const x = 1;</span></div></div>';
    vi.mocked(getFileReaderInstance).mockReturnValue({
      kind: 'text', viewMode: 'rendered', filePath: 'README.md',
    } as never);
    mockState.activeProject = { id: 'proj-1', sessions: [] };
    initFilePrompt();

    const span = document.getElementById('sel')!;
    const sel = window.getSelection()!;
    sel.setBaseAndExtent(span.firstChild!, 0, span.firstChild!, 12);
    // jsdom lacks Range rect APIs the bubble placement needs.
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 10, bottom: 20, left: 10, right: 60, width: 50, height: 10 }) as DOMRect;
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));

    const bubble = document.querySelector('.file-prompt-bubble') as HTMLButtonElement;
    expect(bubble.style.display).toBe('inline-flex');
    bubble.click();

    const composer = document.querySelector('.browser-inspect-panel')!;
    // The superseded inline checkbox row is gone from the composer.
    expect(composer.querySelectorAll('.inspect-attach-dims-row')).toHaveLength(0);

    const ta = composer.querySelector('.inspect-instruction-input') as HTMLTextAreaElement;
    ta.value = 'rename x';
    ta.dispatchEvent(new Event('input'));
    (composer.querySelector('.inspect-submit-btn') as HTMLButtonElement).click();

    expect(resolvePlanModePreference).toHaveBeenCalledWith(mockState.preferences, 'claude');
    expect(mockState.addPlanSession).toHaveBeenCalledWith(
      'proj-1', 'README.md: rename x', true, undefined, undefined, { activate: true },
    );
  });
});