import { appState } from '../state.js';
import { LEAD_CHARTER_MAX_BYTES, type ProjectLead, type ProjectRecord, type ProviderId, type TeamMember } from '../../shared/types.js';
import { providerProfileOptions } from '../profile-utils.js';
import { getCachedProviderMetas } from '../provider-availability.js';
import { t } from '../i18n.js';
import { showModal, closeModal, setModalError } from './modal.js';
import type { CustomSelectInstance } from './custom-select.js';

/** UTF-8 size of the charter (the 4 KiB budget is bytes: it rides argv later). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Pickable personas: the user's team members plus the curated bundle
 * (`personas/*.md`, fetched into the team picker's cache), deduped by id so a
 * persona added to the team is not offered twice.
 */
function personaChoices(): { value: string; label: string }[] {
  const bundled = appState.team.predefinedCache?.suggestions ?? [];
  const byId = new Map<string, TeamMember>();
  for (const member of [...appState.getTeamMembers(), ...bundled]) byId.set(member.id, member);
  return [...byId.values()].map(m => ({ value: m.id, label: m.name }));
}

/** Defaults for new sessions; existing sessions retain their pinned identity. */
export function promptProjectSettings(project: ProjectRecord): void {
  let profileSelect: CustomSelectInstance | undefined;
  const effectiveProvider = (value: string) => (value || appState.preferences.defaultProvider || 'claude') as ProviderId;
  const profileOptions = (value: string) => [
    { value: '', label: t('sidebar.defaultProfileOption') },
    ...providerProfileOptions(effectiveProvider(value), project.hostId),
  ];
  const personas = personaChoices();
  showModal(t('sidebar.projectSettings.title'), [
    {
      label: t('tab.newSessionModal.providerLabel'),
      id: 'provider',
      type: 'select',
      defaultValue: project.defaultProvider ?? '',
      options: [
        { value: '', label: t('sidebar.defaultProfileOption') },
        ...getCachedProviderMetas().map(p => ({ value: p.id, label: p.displayName })),
      ],
      onSelectChange: value => profileSelect?.setOptions(profileOptions(value), ''),
    },
    {
      label: t('sidebar.projectSettings.defaultProfileLabel'),
      id: 'profile',
      type: 'select',
      defaultValue: project.defaultProfileId ?? '',
      options: profileOptions(project.defaultProvider ?? ''),
      onSelectCreated: select => { profileSelect = select; },
    },
    // Lead card (team-lead-persona-plan M1). Every row is a no-op until the
    // toggle is on: with no `lead` on the record nothing here writes one.
    {
      label: t('sidebar.projectSettings.leadEnabledLabel'),
      id: 'lead-enabled',
      type: 'checkbox',
      defaultValue: project.lead?.enabled ? 'true' : '',
    },
    {
      label: t('sidebar.projectSettings.leadPersonaLabel'),
      id: 'lead-persona',
      type: 'select',
      defaultValue: project.lead?.personaId ?? '',
      options: [{ value: '', label: t('sidebar.projectSettings.leadPersonaNone') }, ...personas],
    },
    {
      label: t('sidebar.projectSettings.leadNameLabel'),
      id: 'lead-name',
      type: 'text',
      placeholder: t('sidebar.projectSettings.leadNamePlaceholder'),
      defaultValue: project.lead?.name ?? '',
    },
    {
      label: t('sidebar.projectSettings.leadCharterLabel'),
      id: 'lead-charter',
      type: 'textarea',
      placeholder: t('sidebar.projectSettings.leadCharterPlaceholder'),
      rows: 5,
      // Cheap character ceiling; the byte-length check on Save is the real cap.
      maxLength: LEAD_CHARTER_MAX_BYTES,
      defaultValue: project.lead?.charter ?? '',
    },
  ], (values) => {
    // The byte cap is checked BEFORE any write: a refusal must not persist the
    // other fields edited in the same dialog pass (partial-save defect).
    const charter = values['lead-charter'] ?? '';
    if (byteLength(charter) > LEAD_CHARTER_MAX_BYTES) {
      setModalError('lead-charter', t('sidebar.projectSettings.leadCharterTooLong', {
        size: byteLength(charter),
        max: LEAD_CHARTER_MAX_BYTES,
      }));
      return;
    }
    appState.setProjectCodingDefaults(project.id, (values['provider'] || undefined) as ProviderId | undefined, values['profile'] || undefined);

    const enabled = values['lead-enabled'] === 'true';
    const name = (values['lead-name'] ?? '').trim();
    const personaId = values['lead-persona'] || undefined;
    if (!enabled && !project.lead && !name && !charter.trim()) {
      // Nothing lead-related was touched on a project that never had a lead:
      // write no key at all (the absent feature stays byte-identical).
      closeModal();
      return;
    }
    const lead: ProjectLead = {
      personaId,
      name: name || personas.find(p => p.value === personaId)?.label || t('sidebar.projectSettings.leadNameDefault'),
      charter,
      enabled,
    };
    // M2's review gate is untouched here: an existing mode survives an edit.
    if (project.lead?.reviewMode) lead.reviewMode = project.lead.reviewMode;
    appState.setProjectLead(project.id, lead);
    closeModal();
  }, { confirmLabel: 'Save' });
}
