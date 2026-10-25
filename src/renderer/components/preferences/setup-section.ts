import { hasProviderIssue, type ProviderStatus } from '../setup-checks.js';
import type { ProviderId, SettingsValidationResult } from '../../../shared/types.js';
import { t } from '../../i18n.js';
import type { PreferencesContext, SectionController } from './section.js';

function renderCheckItem(parent: HTMLElement, opts: {
  label: string;
  description: string;
  ok: boolean;
  statusText: string;
  helpText?: string;
  /** SA-P2-1: neutral amber tier — a deliberate user choice, not an error. */
  kept?: boolean;
  onFix?: () => Promise<void>;
}) {
  const row = document.createElement('div');
  row.className = 'setup-check-row';

  const icon = document.createElement('span');
  icon.className = opts.kept ? 'setup-check-icon kept' : opts.ok ? 'setup-check-icon ok' : 'setup-check-icon error';
  icon.textContent = opts.ok || opts.kept ? t('setup.iconOk') : t('setup.iconFail');

  const info = document.createElement('div');
  info.className = 'setup-check-info';

  const title = document.createElement('div');
  title.className = 'setup-check-label';
  title.textContent = opts.label;

  const desc = document.createElement('div');
  desc.className = 'setup-check-desc';
  desc.textContent = opts.description;

  info.appendChild(title);
  info.appendChild(desc);

  if (!opts.ok && opts.helpText) {
    const help = document.createElement('div');
    help.className = 'setup-check-help';
    help.textContent = opts.helpText;
    info.appendChild(help);
  }

  const status = document.createElement('div');
  status.className = opts.kept ? 'setup-check-status kept' : opts.ok ? 'setup-check-status ok' : 'setup-check-status error';
  status.textContent = opts.statusText;

  row.appendChild(icon);
  row.appendChild(info);
  row.appendChild(status);

  const { onFix } = opts;
  if (onFix) {
    const btn = document.createElement('button');
    btn.className = 'setup-fix-btn';
    btn.textContent = t('setup.fixButton');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = t('setup.fixingButton');
      try {
        await onFix();
      } catch {
        btn.disabled = false;
        btn.textContent = t('setup.fixButton');
      }
    });
    row.appendChild(btn);
  }

  parent.appendChild(row);
}

function renderProviderHeader(parent: HTMLElement, displayName: string) {
  const header = document.createElement('div');
  header.className = 'setup-provider-header';
  header.textContent = displayName;
  parent.appendChild(header);
}

async function fetchProviderStatuses(ctx: PreferencesContext): Promise<ProviderStatus[]> {
  const providers = await window.finevibe.provider.listProviders();
  const activeProject = ctx.getActiveProject();
  return Promise.all(
    providers.map(meta => {
      // Project-scope provider (Copilot) with no project open: a user-scope
      // validation is structurally always 'missing' (hooks live per-project),
      // so skip the IPC and mark the row neutral.
      const projectScoped = meta.capabilities.hookScope === 'project';
      const hooksNeutral = projectScoped && !activeProject;
      const validation: Promise<SettingsValidationResult> = hooksNeutral
        ? Promise.resolve({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} })
        : window.finevibe.settings.validate(
            meta.id,
            projectScoped ? activeProject?.path : undefined,
          );
      return Promise.all([validation, window.finevibe.provider.checkBinary(meta.id)]).then(
        ([validation, binaryOk]) => ({ meta, validation, binaryOk, hooksNeutral }),
      );
    }),
  );
}

/** On-open badge check — independent of rendering the Setup section. */
export async function updateSetupBadge(ctx: PreferencesContext): Promise<void> {
  const results = await fetchProviderStatuses(ctx);
  ctx.setSetupBadge(results.some(hasProviderIssue));
}

export function createSetupSection(ctx: PreferencesContext): SectionController {
  async function fixAndRerender(providerId?: ProviderId, projectPath?: string) {
    await window.finevibe.settings.reinstall(providerId, undefined, projectPath);
    ctx.rerenderSection('setup');
  }

  return {
    async render(container) {
      const section = document.createElement('div');
      section.className = 'setup-section';

      const loading = document.createElement('div');
      loading.className = 'setup-loading';
      loading.textContent = t('setup.checking');
      section.appendChild(loading);
      container.appendChild(section);

      const results = await fetchProviderStatuses(ctx);

      if (!ctx.isActiveSection('setup')) return;

      ctx.setSetupBadge(results.some(hasProviderIssue));

      section.innerHTML = '';

      for (const { meta, validation, binaryOk, hooksNeutral } of results) {
        renderProviderHeader(section, meta.displayName);

        renderCheckItem(section, {
          label: meta.displayName,
          description: t('setup.binaryDescription', { binaryName: meta.binaryName }),
          ok: binaryOk,
          statusText: binaryOk ? t('setup.installed') : t('setup.notFound'),
          helpText: binaryOk ? undefined : t('setup.binaryNotFoundHelp', { binaryName: meta.binaryName }),
        });

        if (!binaryOk) continue;

        const { capabilities } = meta;

        if (capabilities.costTracking || capabilities.contextWindow) {
          // SA-P2-1: a Kept foreign statusLine renders the neutral amber tier
          // with no Fix CTA — Fix would perform the Replace the user declined.
          const kept = validation.statusLine === 'foreign' && validation.userKeptStatusLine === true;
          const slOk = validation.statusLine === 'finevibe';
          let slStatus = t('setup.statusLineConfigured');
          if (validation.statusLine === 'missing') slStatus = t('setup.statusLineMissing');
          else if (kept) slStatus = t('setup.statusLineKept');
          else if (validation.statusLine === 'foreign') slStatus = t('setup.statusLineForeign');

          renderCheckItem(section, {
            label: t('setup.statusLineLabel'),
            description: t('setup.statusLineDescription'),
            ok: slOk,
            kept,
            statusText: slStatus,
            onFix: slOk || kept ? undefined : () => fixAndRerender(meta.id),
          });
        }

        if (capabilities.hookStatus) {
          const projectScoped = meta.capabilities.hookScope === 'project';
          const activeProject = ctx.getActiveProject();
          const hooksOk = hooksNeutral || validation.hooks === 'complete';
          if (hooksNeutral) {
            // No project open for a project-scope provider: neutral tier, no
            // Fix — there is no project to install into from here.
            renderCheckItem(section, {
              label: t('setup.hooksLabel'),
              description: t('setup.hooksProjectScopedDesc'),
              ok: true,
              kept: true,
              statusText: t('setup.hooksProjectScoped'),
            });
          } else {
            let hooksStatus = t('setup.hooksComplete');
            if (validation.hooks === 'missing')
              hooksStatus =
                projectScoped && activeProject
                  ? t('setup.hooksMissingProject', { project: activeProject.name })
                  : t('setup.hooksMissing');
            else if (validation.hooks === 'partial') hooksStatus = t('setup.hooksPartial');

            renderCheckItem(section, {
              label: t('setup.hooksLabel'),
              description: t('setup.hooksDescription'),
              ok: hooksOk,
              statusText: hooksStatus,
              onFix: hooksOk
                ? undefined
                : () => fixAndRerender(meta.id, projectScoped ? activeProject?.path : undefined),
            });
          }

          const hookList = document.createElement('div');
          hookList.className = 'setup-hook-details';
          for (const [event, installed] of Object.entries(validation.hookDetails)) {
            const item = document.createElement('div');
            item.className = 'setup-hook-item';
            const icon = document.createElement('span');
            icon.className = installed ? 'setup-check-icon ok' : 'setup-check-icon error';
            icon.textContent = installed ? t('setup.iconOk') : t('setup.iconFail');
            const name = document.createElement('span');
            name.className = 'setup-hook-name';
            name.textContent = event;
            item.appendChild(icon);
            item.appendChild(name);
            hookList.appendChild(item);
          }
          section.appendChild(hookList);

          if (capabilities.costTracking && validation.statusLine !== 'finevibe' && !hooksOk) {
            const fixAllRow = document.createElement('div');
            fixAllRow.className = 'setup-fix-all-row';

            const fixAllBtn = document.createElement('button');
            fixAllBtn.className = 'setup-fix-btn';
            fixAllBtn.textContent = t('setup.fixAllButton');
            fixAllBtn.addEventListener('click', async () => {
              fixAllBtn.disabled = true;
              fixAllBtn.textContent = t('setup.fixingButton');
              try {
                await fixAndRerender(meta.id);
              } catch {
                fixAllBtn.disabled = false;
                fixAllBtn.textContent = t('setup.fixAllButton');
              }
            });

            fixAllRow.appendChild(fixAllBtn);
            section.appendChild(fixAllRow);
          }
        }
      }
    },
  };
}
