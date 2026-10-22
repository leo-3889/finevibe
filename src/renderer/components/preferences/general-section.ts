import { appState } from '../../state.js';
import { createCustomSelect, type CustomSelectInstance, type SelectOption } from '../custom-select.js';
import { loadProviderAvailability, getProviderAvailabilitySnapshot } from '../../provider-availability.js';
import { t } from '../../i18n.js';
import type { CliProviderMeta, Locale, ProviderId } from '../../../shared/types.js';
import type { PreferencesContext, SectionController } from './section.js';
import { toggleRow } from './shared.js';
import { isPlanModeSupported, resolvePlanModePreference } from '../../state/specialized-sessions.js';

/**
 * Fix the select's value box (trigger) to the width of its longest option
 * label, so it matches the dropdown (which sizes to the widest item).
 */
function fixSelectWidthToLongestOption(select: CustomSelectInstance, options: SelectOption[]): void {
  const trigger = select.element.querySelector<HTMLElement>('.custom-select-trigger');
  if (!trigger || options.length === 0) return;

  const style = getComputedStyle(trigger);
  const sizer = document.createElement('span');
  sizer.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none;` +
    `font-size:${style.fontSize};font-family:${style.fontFamily};font-weight:${style.fontWeight};`;
  document.body.appendChild(sizer);

  let maxText = 0;
  for (const opt of options) {
    sizer.textContent = opt.label;
    maxText = Math.max(maxText, sizer.offsetWidth);
  }
  sizer.remove();

  // trigger: padding 10px x2, border 1px x2, arrow 4px + 8px left margin
  trigger.style.width = `${Math.ceil(maxText + 10 + 10 + 2 + 4 + 8)}px`;
}

export function createGeneralSection(ctx: PreferencesContext): SectionController {
  let providerSelect: CustomSelectInstance | null = null;
  let languageSelect: CustomSelectInstance | null = null;
  let soundCheckbox: HTMLInputElement | null = null;
  let notificationsCheckbox: HTMLInputElement | null = null;
  let historyCheckbox: HTMLInputElement | null = null;
  let insightsCheckbox: HTMLInputElement | null = null;
  let autoTitleCheckbox: HTMLInputElement | null = null;
  let confirmCloseCheckbox: HTMLInputElement | null = null;
  let copyOnSelectCheckbox: HTMLInputElement | null = null;
  let projectsFolderValue: string | null = null;
  let askAiFocusSelect: CustomSelectInstance | null = null;

  return {
    render(container) {
      // Language dropdown — sits at the top because the rest of this section's
      // labels re-translate when it changes.
      const languageRow = document.createElement('div');
      languageRow.className = 'modal-toggle-field';
      const languageLabel = document.createElement('label');
      languageLabel.htmlFor = 'pref-language';
      languageLabel.textContent = t('language.label');
      if (languageSelect) languageSelect.destroy();
      languageSelect = createCustomSelect(
        'pref-language',
        [
          { value: 'en', label: t('language.en') },
          { value: 'zh-CN', label: t('language.zh-CN') },
        ],
        appState.preferences.locale ?? 'en',
        // Locale change goes through setLocale so the listener in index.ts can
        // re-translate the modal in place — it does NOT need Confirm.
        (value) => appState.setLocale(value as Locale),
      );
      languageRow.appendChild(languageLabel);
      languageRow.appendChild(languageSelect.element);
      container.appendChild(languageRow);

      // Default provider dropdown
      const providerRow = document.createElement('div');
      providerRow.className = 'modal-toggle-field';

      const providerLabel = document.createElement('label');
      providerLabel.textContent = t('general.defaultCodingTool');

      const currentDefault = appState.preferences.defaultProvider ?? 'claude';
      const buildProviderOptions = (providers: CliProviderMeta[]): SelectOption[] =>
        providers.map(p => ({ value: p.id, label: p.displayName }));

      if (providerSelect) providerSelect.destroy();
      let snapshot = getProviderAvailabilitySnapshot();
      if (snapshot) {
        const options = buildProviderOptions(snapshot.providers);
        providerSelect = createCustomSelect('pref-default-provider', options, currentDefault, () => renderPlanModeRow());
        fixSelectWidthToLongestOption(providerSelect, options);
      } else {
        providerSelect = createCustomSelect('pref-default-provider', [{ value: currentDefault, label: t('general.loading') }], currentDefault, () => renderPlanModeRow());
        loadProviderAvailability().then(() => {
          if (!ctx.isActiveSection('general')) return;
          snapshot = getProviderAvailabilitySnapshot();
          if (snapshot) {
            if (providerSelect) providerSelect.destroy();
            const options = buildProviderOptions(snapshot.providers);
            providerSelect = createCustomSelect('pref-default-provider', options, currentDefault, () => renderPlanModeRow());
            fixSelectWidthToLongestOption(providerSelect, options);
            providerRow.querySelector('.custom-select')?.remove();
            providerRow.appendChild(providerSelect.element);
            renderPlanModeRow();
          }
        });
      }

      providerRow.appendChild(providerLabel);
      providerRow.appendChild(providerSelect.element);
      container.appendChild(providerRow);

      // The plan-mode section only steers the tool that the quick-send paths
      // resolve from `defaultProvider` (Ask AI / Inspect / Draw / Flow "Send to
      // AI", Kanban create, New-session modal seed), so the page shows a single
      // checkbox for the currently selected default coding tool — re-rendered
      // when the dropdown changes. An unsupported selected tool renders
      // disabled + tooltip. Rows persist on change (like the per-provider
      // default profiles), not on Save.
      const planModeSection = document.createElement('div');
      container.appendChild(planModeSection);
      renderPlanModeRow();

      function renderPlanModeRow(): void {
        planModeSection.innerHTML = '';
        const metas = getProviderAvailabilitySnapshot()?.providers ?? [];
        const meta = metas.find(m => m.id === providerSelect?.getValue());
        if (!meta) return;
        const heading = document.createElement('div');
        heading.className = 'preferences-subheading';
        heading.textContent = t('general.planModeHeading');
        planModeSection.appendChild(heading);
        const providerId = meta.id as ProviderId;
        const supported = isPlanModeSupported(providerId);
        const row = document.createElement('div');
        row.className = 'modal-toggle-field';
        if (!supported) {
          row.classList.add('disabled');
          row.title = t('tab.newSessionModal.planModeUnsupportedTooltip');
        }
        const label = document.createElement('label');
        label.htmlFor = `pref-plan-mode-${providerId}`;
        label.textContent = meta.displayName;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `pref-plan-mode-${providerId}`;
        checkbox.checked = resolvePlanModePreference(appState.preferences, providerId);
        checkbox.disabled = !supported;
        checkbox.addEventListener('change', () => {
          const map: Partial<Record<ProviderId, boolean>> = { ...appState.preferences.planModeDefaults };
          map[providerId] = checkbox.checked;
          appState.setPreference('planModeDefaults', map);
        });
        row.appendChild(label);
        row.appendChild(checkbox);
        planModeSection.appendChild(row);
      }

      const sound = toggleRow('pref-sound-on-waiting', t('general.playSoundWhenSessionFinishes'), appState.preferences.soundOnSessionWaiting);
      soundCheckbox = sound.checkbox;
      container.appendChild(sound.row);

      const notif = toggleRow('pref-notifications-desktop', t('general.desktopNotifications'), appState.preferences.notificationsDesktop);
      notificationsCheckbox = notif.checkbox;
      container.appendChild(notif.row);

      const history = toggleRow('pref-session-history', t('general.recordSessionHistory'), appState.preferences.sessionHistoryEnabled);
      historyCheckbox = history.checkbox;
      container.appendChild(history.row);

      const insights = toggleRow('pref-insights-enabled', t('general.showInsightAlerts'), appState.preferences.insightsEnabled);
      insightsCheckbox = insights.checkbox;
      container.appendChild(insights.row);

      const autoTitle = toggleRow('pref-auto-title', t('general.autoNameSessions'), appState.preferences.autoTitleEnabled);
      autoTitleCheckbox = autoTitle.checkbox;
      container.appendChild(autoTitle.row);

      const confirmClose = toggleRow('pref-confirm-close-working', t('general.confirmClosingActiveSession'), appState.preferences.confirmCloseWorkingSession);
      confirmCloseCheckbox = confirmClose.checkbox;
      container.appendChild(confirmClose.row);

      const copyOnSelect = toggleRow('pref-copy-on-select', t('general.copyOnSelect'), appState.preferences.copyOnSelect ?? false);
      copyOnSelectCheckbox = copyOnSelect.checkbox;
      container.appendChild(copyOnSelect.row);

      // Default projects folder: the root Add-project pre-fills as
      // `<folder>/<name>` and where a git-URL checkout lands. The chosen
      // folder reads as plain text under the label (no editable field); the
      // picker (the same fs.browseDirectory the modal uses) and Clear sit on
      // the right. Persists on Confirm like the toggles above.
      // Empty = unset (free-path behavior).
      const folderRow = document.createElement('div');
      folderRow.className = 'modal-toggle-field';
      const folderInfo = document.createElement('div');
      folderInfo.className = 'preferences-row-info';
      const folderLabel = document.createElement('label');
      folderLabel.textContent = t('general.defaultProjectsFolder');
      const folderValue = document.createElement('div');
      folderValue.className = 'preferences-row-value';
      folderInfo.appendChild(folderLabel);
      folderInfo.appendChild(folderValue);
      const folderBrowse = document.createElement('button');
      folderBrowse.type = 'button';
      folderBrowse.className = 'modal-field-btn';
      folderBrowse.textContent = t('sidebar.newProject.browseButton');
      const folderClear = document.createElement('button');
      folderClear.type = 'button';
      folderClear.className = 'modal-field-btn';
      folderClear.textContent = t('general.defaultProjectsFolderClear');
      folderBrowse.addEventListener('click', async () => {
        const dir = await window.finevibe.fs.browseDirectory();
        if (dir) {
          projectsFolderValue = dir;
          renderFolderValue();
        }
      });
      folderClear.addEventListener('click', () => {
        projectsFolderValue = '';
        renderFolderValue();
      });
      function renderFolderValue(): void {
        const value = projectsFolderValue ?? '';
        folderValue.textContent = value || t('general.defaultProjectsFolderPlaceholder');
        folderValue.className = value ? 'preferences-row-value' : 'preferences-row-value unset';
        folderClear.style.display = value ? '' : 'none';
      }
      projectsFolderValue = appState.preferences.defaultProjectsFolder ?? '';
      renderFolderValue();
      folderRow.appendChild(folderInfo);
      folderRow.appendChild(folderBrowse);
      folderRow.appendChild(folderClear);
      container.appendChild(folderRow);

      // Ask AI focus: an enum, so a custom-select (the repo bans native <select>).
      const askAiFocusRow = document.createElement('div');
      askAiFocusRow.className = 'modal-toggle-field';
      const askAiFocusLabel = document.createElement('label');
      askAiFocusLabel.htmlFor = 'pref-ask-ai-focus';
      askAiFocusLabel.textContent = t('general.askAiFocus');
      if (askAiFocusSelect) askAiFocusSelect.destroy();
      askAiFocusSelect = createCustomSelect(
        'pref-ask-ai-focus',
        [
          { value: 'switch', label: t('general.askAiFocusSwitch') },
          { value: 'stay', label: t('general.askAiFocusStay') },
        ],
        appState.preferences.askAiFocus ?? 'switch',
      );
      askAiFocusRow.appendChild(askAiFocusLabel);
      askAiFocusRow.appendChild(askAiFocusSelect.element);
      container.appendChild(askAiFocusRow);
    },

    save() {
      if (soundCheckbox) appState.setPreference('soundOnSessionWaiting', soundCheckbox.checked);
      if (notificationsCheckbox) appState.setPreference('notificationsDesktop', notificationsCheckbox.checked);
      if (historyCheckbox) appState.setPreference('sessionHistoryEnabled', historyCheckbox.checked);
      if (insightsCheckbox) appState.setPreference('insightsEnabled', insightsCheckbox.checked);
      if (autoTitleCheckbox) appState.setPreference('autoTitleEnabled', autoTitleCheckbox.checked);
      if (confirmCloseCheckbox) appState.setPreference('confirmCloseWorkingSession', confirmCloseCheckbox.checked);
      if (copyOnSelectCheckbox) appState.setPreference('copyOnSelect', copyOnSelectCheckbox.checked);
      if (providerSelect) appState.setPreference('defaultProvider', providerSelect.getValue() as ProviderId);
      if (askAiFocusSelect) appState.setPreference('askAiFocus', askAiFocusSelect.getValue() as 'switch' | 'stay');
      if (projectsFolderValue !== null) appState.setPreference('defaultProjectsFolder', projectsFolderValue.trim());
    },

    destroy() {
      if (providerSelect) providerSelect.destroy();
      providerSelect = null;
      if (languageSelect) languageSelect.destroy();
      languageSelect = null;
      if (askAiFocusSelect) askAiFocusSelect.destroy();
      askAiFocusSelect = null;
      projectsFolderValue = null;
    },
  };
}
