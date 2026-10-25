// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsWarningData } from '../../shared/types';

/**
 * SA-P1-2: the settings:warning banner fires for every hookStatus provider,
 * so (a) the Fix Settings CTA must reinstall the banner's provider — not
 * Claude's default — and (b) the copy names that provider, localized.
 */

const showBanner = vi.hoisted(() => vi.fn());
const removeBanner = vi.hoisted(() => vi.fn());
vi.mock('./alert-banner.js', () => ({
  showAlertBanner: showBanner,
  removeAlertBanner: removeBanner,
}));
vi.mock('./statusline-conflict-modal.js', () => ({
  showStatusLineConflictModal: vi.fn(() => Promise.resolve('replace' as const)),
}));

type WarningCb = (data: SettingsWarningData) => void;

const reinstall = vi.fn(async () => ({ success: true }));
let warningCb: WarningCb;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  warningCb = undefined as unknown as WarningCb;
  (window as unknown as { finevibe: unknown }).finevibe = {
    provider: {
      listProviders: async () => [
        { id: 'claude', displayName: 'Claude Code', binaryName: 'claude' },
        { id: 'codex', displayName: 'Codex CLI', binaryName: 'codex' },
      ],
    },
    settings: {
      onWarning: (cb: WarningCb) => { warningCb = cb; return () => {}; },
      onConflictDialog: () => () => {},
      respondConflictDialog: vi.fn(),
      reinstall,
      validate: vi.fn(),
      declineConflict: vi.fn(),
    },
  };
});

function warning(overrides: Partial<SettingsWarningData> = {}): SettingsWarningData {
  return {
    sessionId: 's1',
    providerId: 'codex',
    statusLine: 'finevibe',
    hooks: 'partial',
    configDir: '/profiles/work',
    projectPath: '/proj',
    ...overrides,
  };
}

describe('settings-guard-ui banner (SA-P1-2)', () => {
  it('threads the banner providerId + dirs to settings:reinstall', async () => {
    const { initSettingsGuard } = await import('./settings-guard-ui.js');
    const { loadProviderMetas } = await import('../provider-availability.js');
    await loadProviderMetas();
    initSettingsGuard();
    warningCb(warning());

    const banner = showBanner.mock.calls[0][0];
    const btn = { disabled: false, textContent: '' } as unknown as HTMLButtonElement;
    await banner.cta.onClick(btn);
    expect(reinstall).toHaveBeenCalledWith('codex', '/profiles/work', '/proj');
    expect(removeBanner).toHaveBeenCalled();
  });

  it('names the banner provider in the copy, not Claude', async () => {
    const { initSettingsGuard } = await import('./settings-guard-ui.js');
    const { loadProviderMetas } = await import('../provider-availability.js');
    await loadProviderMetas();
    initSettingsGuard();
    warningCb(warning());

    const banner = showBanner.mock.calls[0][0];
    expect(banner.message).toContain('Codex CLI');
    expect(banner.message).not.toContain('Claude');
  });

  it('translates the banner copy in zh-CN', async () => {
    const { setLocale } = await import('../i18n.js');
    setLocale('zh-CN');
    const { initSettingsGuard } = await import('./settings-guard-ui.js');
    const { loadProviderMetas } = await import('../provider-availability.js');
    await loadProviderMetas();
    initSettingsGuard();
    warningCb(warning());

    const banner = showBanner.mock.calls[0][0];
    expect(banner.message).toContain('Codex CLI');
    expect(banner.message).toContain('会话跟踪钩子');
    expect(banner.cta.label).toBe('修复设置');
  });
});
