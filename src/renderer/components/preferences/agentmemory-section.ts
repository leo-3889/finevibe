import { appState } from '../../state.js';
import { t } from '../../i18n.js';
import type { PreferencesContext, SectionController } from './section.js';
import { toggleRow } from './shared.js';
import type { AgentmemoryStatus } from '../../../shared/types.js';

/** Console (Viewer) URL; the status probe also carries it, this is the pre-probe fallback. */
const CONSOLE_URL = 'http://localhost:3113';

/**
 * agentmemory section (Model A). A toggle controls whether FineVibe starts the
 * shared engine at launch; the status line reflects a live probe and offers a
 * manual "start engine" action and an "open console" link. FineVibe never stops
 * the engine — it is shared by every agent CLI.
 */
export function createAgentmemorySection(ctx: PreferencesContext): SectionController {
  let autoStartCheckbox: HTMLInputElement | null = null;
  let statusEl: HTMLSpanElement | null = null;
  let startBtn: HTMLButtonElement | null = null;

  function renderStatus(status: AgentmemoryStatus | null): void {
    if (!statusEl) return;
    if (!status) {
      statusEl.className = 'setup-check-status';
      statusEl.textContent = t('agentmemory.probing');
      return;
    }
    if (status.running) {
      const bits = [t('agentmemory.running')];
      if (status.serviceVersion) bits.push(`agentmemory v${status.serviceVersion}`);
      if (status.engineVersions && status.engineVersions.length) bits.push(`iii ${status.engineVersions.join(', ')}`);
      statusEl.className = 'setup-check-status ok';
      statusEl.textContent = bits.join('  ·  ');
    } else {
      statusEl.className = 'setup-check-status error';
      statusEl.textContent = t('agentmemory.stopped');
    }
  }

  async function refresh(): Promise<void> {
    if (!ctx.isActiveSection('agentmemory')) return;
    renderStatus(null);
    try {
      const status = await window.finevibe.agentmemory.status();
      if (ctx.isActiveSection('agentmemory')) renderStatus(status);
    } catch {
      if (ctx.isActiveSection('agentmemory')) renderStatus({ running: false, consoleUrl: CONSOLE_URL });
    }
  }

  return {
    render(container) {
      const auto = toggleRow(
        'pref-agentmemory-autostart',
        t('agentmemory.autoStart'),
        appState.preferences.agentmemoryAutoStart ?? true,
      );
      autoStartCheckbox = auto.checkbox;
      container.appendChild(auto.row);

      const statusRow = document.createElement('div');
      statusRow.className = 'about-update-row';

      statusEl = document.createElement('span');
      statusEl.className = 'setup-check-status';
      renderStatus(null);

      startBtn = document.createElement('button');
      startBtn.className = 'setup-fix-btn';
      startBtn.textContent = t('agentmemory.startButton');
      startBtn.addEventListener('click', () => {
        const btn = startBtn;
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = t('agentmemory.starting');
        void window.finevibe.agentmemory.start().then(
          () => refresh(),
          () => {
            if (startBtn) {
              startBtn.disabled = false;
              startBtn.textContent = t('agentmemory.startButton');
            }
          },
        );
      });

      const consoleLink = document.createElement('a');
      consoleLink.className = 'about-link';
      consoleLink.href = '#';
      consoleLink.textContent = t('agentmemory.openConsole');
      consoleLink.addEventListener('click', (e) => {
        e.preventDefault();
        void window.finevibe.app.openExternal(CONSOLE_URL);
      });

      statusRow.append(statusEl, startBtn, consoleLink);
      container.appendChild(statusRow);

      void refresh();
    },

    save() {
      if (autoStartCheckbox) appState.setPreference('agentmemoryAutoStart', autoStartCheckbox.checked);
    },
  };
}
