import { t } from '../../i18n.js';
import type { PreferencesContext, SectionController } from './section.js';

/**
 * A5 storage section: the in-app answer to "what is FineVibe eating on
 * disk". Lists the userData subtree sizes the main-side bounded scan
 * (`storage:scan`, src/main/ipc-handlers.ts) reports, offers the
 * cache-only clear (`storage:clear` — sessions/Partitions are structurally
 * out of its allowlist, see clearSafeCaches), and surfaces the A3
 * legacy-retirement audit log read-only (`storage:retirement`).
 */

const MB = 1024 * 1024;

/** Human MB formatting — the report is MB-granular by design; a subtree
 *  below 0.1 MB reads as "0.0 MB", which is the honest answer there. */
export function formatMB(bytes: number): string {
  const mb = bytes / MB;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** Display name per scan-subtree name (the scan's own vocabulary). */
const SUBTREE_LABEL_KEYS: Record<string, string> = {
  'pi-sessions': 'storage.subPi',
  'omp-sessions': 'storage.subOmp',
  'Partitions': 'storage.subPartitions',
  'Cache': 'storage.subCache',
  'misc': 'storage.subMisc',
};

const RETIREMENT_LABEL_KEYS: Record<string, string> = {
  removed: 'storage.outcomeRemoved',
  kept: 'storage.outcomeKept',
  unverified: 'storage.outcomeUnverified',
  error: 'storage.outcomeError',
};

export function createStorageSection(ctx: PreferencesContext): SectionController {
  let listEl: HTMLDivElement | null = null;
  let statusEl: HTMLSpanElement | null = null;
  let clearBtn: HTMLButtonElement | null = null;
  let retirementEl: HTMLDivElement | null = null;

  function renderScan(scan: { entries: Array<{ name: string; bytes: number }>; truncated: boolean } | null): void {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!scan) {
      const row = document.createElement('div');
      row.className = 'setup-check-status';
      row.textContent = t('storage.scanning');
      listEl.appendChild(row);
      return;
    }
    for (const entry of scan.entries) {
      const row = document.createElement('div');
      row.className = 'modal-toggle-field storage-usage-row';
      const label = document.createElement('span');
      label.textContent = t(SUBTREE_LABEL_KEYS[entry.name] ?? 'storage.subMisc');
      const value = document.createElement('span');
      value.className = 'storage-usage-bytes';
      value.textContent = formatMB(entry.bytes);
      row.appendChild(label);
      row.appendChild(value);
      listEl.appendChild(row);
    }
    if (scan.truncated) {
      const note = document.createElement('div');
      note.className = 'setup-check-status';
      note.textContent = t('storage.truncated');
      listEl.appendChild(note);
    }
  }

  async function refreshScan(): Promise<void> {
    if (!ctx.isActiveSection('storage')) return;
    renderScan(null);
    try {
      const scan = await window.finevibe.storage.scan();
      if (ctx.isActiveSection('storage')) renderScan(scan);
    } catch {
      if (ctx.isActiveSection('storage')) {
        renderScan({ entries: [], truncated: false });
        if (statusEl) statusEl.textContent = t('storage.scanFailed');
      }
    }
  }

  async function refreshRetirement(): Promise<void> {
    if (!retirementEl || !ctx.isActiveSection('storage')) return;
    try {
      const entries = await window.finevibe.storage.retirement();
      if (!ctx.isActiveSection('storage')) return;
      retirementEl.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'setup-check-status';
      if (entries.length === 0) {
        row.textContent = t('storage.retirementNone');
      } else {
        const last = entries[entries.length - 1]!;
        row.textContent = t('storage.retirementEntry', {
          from: last.from,
          outcome: t(RETIREMENT_LABEL_KEYS[last.outcome] ?? 'storage.outcomeError'),
        });
      }
      retirementEl.appendChild(row);
    } catch {
      // The audit log is decoration; its failure never blocks the report.
    }
  }

  return {
    render(container) {
      const usageHeading = document.createElement('div');
      usageHeading.className = 'preferences-subheading';
      usageHeading.textContent = t('storage.usageHeading');
      container.appendChild(usageHeading);

      listEl = document.createElement('div');
      container.appendChild(listEl);

      const clearRow = document.createElement('div');
      clearRow.className = 'about-update-row';

      clearBtn = document.createElement('button');
      clearBtn.className = 'setup-fix-btn';
      clearBtn.textContent = t('storage.clearButton');

      statusEl = document.createElement('span');
      statusEl.className = 'setup-check-status';

      clearBtn.addEventListener('click', () => {
        const btn = clearBtn;
        if (!btn) return;
        // The confirm copy states the allowlist in user words; the real
        // guarantee is main-side (clearSafeCaches), this is informed
        // consent, not a safety boundary.
        if (!confirm(t('storage.clearConfirm'))) return;
        btn.disabled = true;
        if (statusEl) statusEl.textContent = t('storage.clearing');
        void window.finevibe.storage.clear().then(
          () => {
            if (statusEl) statusEl.textContent = t('storage.cleared');
            void refreshScan();
          },
          () => {
            if (statusEl) statusEl.textContent = t('storage.clearFailed');
            if (clearBtn) clearBtn.disabled = false;
          },
        );
      });

      clearRow.appendChild(clearBtn);
      clearRow.appendChild(statusEl);
      container.appendChild(clearRow);

      const retirementHeading = document.createElement('div');
      retirementHeading.className = 'preferences-subheading';
      retirementHeading.textContent = t('storage.retirementHeading');
      container.appendChild(retirementHeading);

      retirementEl = document.createElement('div');
      container.appendChild(retirementEl);

      void refreshScan();
      void refreshRetirement();
    },

    destroy() {
      listEl = null;
      statusEl = null;
      clearBtn = null;
      retirementEl = null;
    },
  };
}
