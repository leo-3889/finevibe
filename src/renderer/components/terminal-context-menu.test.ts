// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showTerminalContextMenu, hideTerminalContextMenu } from './terminal-context-menu.js';

function makeMockTerminal(hasSelection = false, selection = '') {
  return {
    hasSelection: vi.fn(() => hasSelection),
    getSelection: vi.fn(() => selection),
    selectAll: vi.fn(),
    focus: vi.fn(),
  } as any;
}

describe('terminal-context-menu', () => {
  let writeToPty: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeToPty = vi.fn();
  });

  afterEach(() => {
    hideTerminalContextMenu();
  });

  it('renders menu with three items', () => {
    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);

    const menu = document.querySelector('.tab-context-menu') as HTMLElement;
    expect(menu).toBeTruthy();

    const items = menu.querySelectorAll('.tab-context-menu-item');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Copy');
    expect(items[1].textContent).toContain('Paste');
    expect(items[2].textContent).toContain('Select All');
  });

  it('positions menu at given coordinates', () => {
    const terminal = makeMockTerminal();
    showTerminalContextMenu(200, 300, terminal, writeToPty);

    const menu = document.querySelector('.tab-context-menu') as HTMLElement;
    expect(menu.style.left).toBe('200px');
    expect(menu.style.top).toBe('300px');
  });

  it('disables Copy when no selection', () => {
    const terminal = makeMockTerminal(false);
    showTerminalContextMenu(100, 100, terminal, writeToPty);

    const items = document.querySelectorAll('.tab-context-menu-item');
    expect(items[0].classList.contains('disabled')).toBe(true);
  });

  it('enables Copy when selection exists', () => {
    const terminal = makeMockTerminal(true, 'selected text');
    showTerminalContextMenu(100, 100, terminal, writeToPty);

    const items = document.querySelectorAll('.tab-context-menu-item');
    expect(items[0].classList.contains('disabled')).toBe(false);
  });

  it('hideTerminalContextMenu removes menu from DOM', () => {
    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);
    expect(document.querySelector('.tab-context-menu')).toBeTruthy();

    hideTerminalContextMenu();
    expect(document.querySelector('.tab-context-menu')).toBeNull();
  });

  it('calling show twice replaces the first menu', () => {
    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);
    showTerminalContextMenu(200, 200, terminal, writeToPty);

    const menus = document.querySelectorAll('.tab-context-menu');
    expect(menus).toHaveLength(1);
    expect((menus[0] as HTMLElement).style.left).toBe('200px');
  });

  it('Escape key dismisses the menu', () => {
    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);
    expect(document.querySelector('.tab-context-menu')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.tab-context-menu')).toBeNull();
  });

  it('click outside dismisses the menu', () => {
    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);
    expect(document.querySelector('.tab-context-menu')).toBeTruthy();

    document.dispatchEvent(new MouseEvent('click'));
    expect(document.querySelector('.tab-context-menu')).toBeNull();
  });

  it('Select All calls terminal.selectAll()', () => {
    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);

    const items = document.querySelectorAll('.tab-context-menu-item');
    (items[2] as HTMLElement).click();
    expect(terminal.selectAll).toHaveBeenCalled();
  });

  // Copies route through the main process, not navigator.clipboard, so exactly
  // one plain-text flavor reaches the OS clipboard (#160).
  it('Copy click writes selection through the main-process clipboard', () => {
    const mockWrite = vi.fn().mockResolvedValue(undefined);
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: mockWriteText, readText: vi.fn() } });
    (window as any).vibeyard = { clipboard: { write: mockWrite } };

    const terminal = makeMockTerminal(true, 'hello world');
    showTerminalContextMenu(100, 100, terminal, writeToPty);

    const items = document.querySelectorAll('.tab-context-menu-item');
    (items[0] as HTMLElement).click();

    expect(mockWrite).toHaveBeenCalledWith('hello world', 'explicit');
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  // The click is not a keystroke, so no paste event exists: the read goes to main,
  // which also materialises a clipboard image as an attachment path.
  it('Paste click writes the main-process clipboard text to the PTY', async () => {
    const mockReadForPaste = vi.fn().mockResolvedValue({
      text: 'pasted text', html: '', files: [], imagePath: null, hasContent: true,
    });
    (window as any).vibeyard = { clipboard: { write: vi.fn(), readForPaste: mockReadForPaste, saveImage: vi.fn() } };

    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);

    const items = document.querySelectorAll('.tab-context-menu-item');
    (items[1] as HTMLElement).click();

    expect(mockReadForPaste).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(writeToPty).toHaveBeenCalledWith('pasted text');
    });
  });

  it('Paste click writes a clipboard image as an attachment path', async () => {
    const mockReadForPaste = vi.fn().mockResolvedValue({
      text: '', html: '', files: [], imagePath: '/tmp/vibeyard-paste/paste-3.png', hasContent: true,
    });
    (window as any).vibeyard = { clipboard: { write: vi.fn(), readForPaste: mockReadForPaste, saveImage: vi.fn() } };

    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);

    const items = document.querySelectorAll('.tab-context-menu-item');
    (items[1] as HTMLElement).click();

    await vi.waitFor(() => {
      expect(writeToPty).toHaveBeenCalledWith('/tmp/vibeyard-paste/paste-3.png ');
    });
  });

  // Files copied in a file manager arrive as a list main reads; the menu injects
  // their paths exactly as a drop would, shell-quoted (`quoteShellPath`). jsdom's
  // `navigator.platform` is empty, so the PTY shell is treated as POSIX here:
  // single quotes. The Windows double-quote branch is covered in terminal-utils.
  it('Paste click writes a clipboard file list as attachment paths', async () => {
    const mockReadForPaste = vi.fn().mockResolvedValue({
      text: '', html: '', files: ['C:\\repo\\report.pdf', 'C:\\repo\\data.csv'], imagePath: null, hasContent: true,
    });
    (window as any).vibeyard = { clipboard: { write: vi.fn(), readForPaste: mockReadForPaste, saveImage: vi.fn() } };

    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);

    const items = document.querySelectorAll('.tab-context-menu-item');
    (items[1] as HTMLElement).click();

    await vi.waitFor(() => {
      expect(writeToPty).toHaveBeenCalledWith("'C:\\repo\\report.pdf' 'C:\\repo\\data.csv' ");
    });
  });

  it('restores focus to the terminal after an action', () => {
    const terminal = makeMockTerminal();
    showTerminalContextMenu(100, 100, terminal, writeToPty);

    const items = document.querySelectorAll('.tab-context-menu-item');
    (items[1] as HTMLElement).click(); // Paste
    expect(terminal.focus).toHaveBeenCalled();
  });
});
