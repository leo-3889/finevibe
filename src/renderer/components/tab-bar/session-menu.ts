import { appState, type SessionRecord } from '../../state.js';
import type { ProviderId, TeamMember } from '../../../shared/types.js';
import { showModal, closeModal, setModalError, FieldDef } from '../modal.js';
import { findInvalidEnvLines } from '../../../shared/env-vars.js';
import { showJoinDialog } from '../join-dialog.js';
import { loadProviderAvailability, getProviderAvailabilitySnapshot, getProviderCapabilities, getProviderDisplayName, getTeamCapableProviderIds } from '../../provider-availability.js';
import { providerProfileOptions } from '../../profile-utils.js';
import type { CustomSelectInstance } from '../custom-select.js';
import { hideTabContextMenu, setActiveContextMenu, positionMenu } from './menu.js';
import { t } from '../../i18n.js';
import { defaultSessionName, nextNumberFor, nextSessionNumber, MCP_INSPECTOR_NAME_KEY } from '../../state/session-naming.js';
import { setPendingPrompt } from '../terminal-pane.js';
import { resolvePinnedTeamProfile, type TeamChatOpts } from '../../state/team-state.js';

export function quickNewSession(): void {
  const project = appState.activeProject;
  if (!project) return;
  (document.activeElement as HTMLElement)?.blur?.();
  appState.addSession(project.id, defaultSessionName(project));
}

// "More" overflow menu. Deliberately excludes actions that have their own
// toolbar icon (Terminal, Browser) and the New/Custom Session actions
// (those live on the pill + its caret).
export function showMoreMenu(x: number, y: number): void {
  hideTabContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const addItem = (label: string, onClick: () => void): void => {
    const item = document.createElement('div');
    item.className = 'tab-context-menu-item';
    item.textContent = label;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      onClick();
    });
    menu.appendChild(item);
  };

  const addSeparator = (): void => {
    const sep = document.createElement('div');
    sep.className = 'tab-context-menu-separator';
    menu.appendChild(sep);
  };

  const swarmActive = appState.activeProject?.layout.mode === 'swarm';
  addItem(swarmActive ? t('tab.moreMenu.swarmLayoutActive') : t('tab.moreMenu.swarmLayout'), () => appState.toggleSwarm());
  addItem(t('tab.moreMenu.mcpInspector'), () => addMcpInspector());

  addSeparator();
  addItem(t('tab.moreMenu.joinRemoteSession'), () => showJoinDialog());

  document.body.appendChild(menu);
  setActiveContextMenu(menu);

  positionMenu(menu);
}

// The New Session modal forwards its name/args/env fields into a team-chat
// session; state.ts `startTeamChat` passes the opts through to
// `buildTeamChatSession`. Typed at the widened 4-arg signature (the 3-arg
// method is assignable to it) so the modal is ready the moment state.ts
// widens the parameter.
const startTeamChatWithOpts: (
  projectId: string,
  member: TeamMember,
  overrideProviderId?: ProviderId,
  opts?: TeamChatOpts,
) => SessionRecord | undefined = appState.startTeamChat.bind(appState);

export async function promptNewSession(onCreated?: (session: SessionRecord) => void, opts?: { activate?: boolean }): Promise<void> {
  const project = appState.activeProject;
  if (!project) return;

  const sessionNum = nextSessionNumber(project);

  let providerSnapshot = getProviderAvailabilitySnapshot();
  if (!providerSnapshot) {
    await loadProviderAvailability();
    providerSnapshot = getProviderAvailabilitySnapshot();
  }
  const providers = providerSnapshot?.providers ?? [];
  const availabilityMap = providerSnapshot?.availability ?? new Map();
  // The profile select instance, captured when the modal builds it so the
  // provider change can re-scope its options in place.
  let profileSelect: CustomSelectInstance | null = null;

  // Persona rows follow the provider gating (mirrors setProfileFieldProvider):
  // a provider without system-prompt injection can't run team personas, so
  // the persona + prompt rows hide together.
  function setPersonaFieldProvider(providerId: ProviderId): void {
    const wrapper = document.getElementById('modal-persona')?.closest('.modal-field') as HTMLElement | null;
    if (!wrapper) return;
    const promptWrapper = document.getElementById('modal-session-prompt')?.closest('.modal-field') as HTMLElement | null;
    const display = getTeamCapableProviderIds().has(providerId) ? '' : 'none';
    wrapper.style.display = display;
    if (promptWrapper) promptWrapper.style.display = display;
  }

  // A member pinned to a Profile runs on that Profile's provider at launch:
  // resolvePinnedTeamProfile wins over the modal's provider/profile picks
  // (same semantics as startTeamChat / the team chat controls). The selects
  // stay enabled (member-modal precedent, v1); the tooltip explains the
  // pin's override.
  function setPersonaFieldPin(memberId: string): void {
    const providerWrapper = document.getElementById('modal-provider')?.closest('.modal-field') as HTMLElement | null;
    if (!providerWrapper) return;
    const member = memberId ? appState.getTeamMemberById(memberId) : undefined;
    const pinned = member ? resolvePinnedTeamProfile(member, appState.profiles) : undefined;
    providerWrapper.title = pinned && member
      ? t('tab.newSessionModal.personaPinNote', { name: member.name, provider: getProviderDisplayName(pinned.providerId) })
      : '';
  }

  // Re-scope the Profile field of the open New Session modal to one coding
  // tool: show it only when the tool has profiles, and swap in that tool's
  // profiles (bare names). `selected` is kept when it belongs to the tool;
  // otherwise the selection falls back to "Default", since a profile from a
  // different tool no longer applies.
  function setProfileFieldProvider(providerId: ProviderId, selected = ''): void {
    const wrapper = document.getElementById('modal-profile')?.closest('.modal-field') as HTMLElement | null;
    if (!wrapper) return;
    const profiles = providerProfileOptions(providerId);
    wrapper.style.display = profiles.length > 0 ? '' : 'none';
    profileSelect?.setOptions([
      { value: '', label: t('sidebar.defaultProfileOption') },
      ...profiles,
    ], selected);
  }

  const sessionNamePlaceholder = t('tab.newSessionModal.namePlaceholder', { num: sessionNum });
  const teamMembers = appState.team.members;

  const fields: FieldDef[] = [
    { label: t('tab.newSessionModal.nameLabel'), id: 'session-name', placeholder: sessionNamePlaceholder, defaultValue: sessionNamePlaceholder },
  ];

  // Persona row — launches the session as a team-chat session for that
  // member (persona system prompt applied at spawn). Offered when the team
  // has members (mirrors anyProviderHasProfiles for the profile row); the
  // provider select's onSelectChange hides it for non-team-capable tools.
  // The custom-prompt row rides along below it: the user's first message to
  // the persona, delivered at spawn via setPendingPrompt — the persona's
  // system prompt is a separate slot, so no composition is needed.
  if (teamMembers.length > 0) {
    fields.push(
      {
        label: t('tab.newSessionModal.personaLabel'),
        id: 'persona',
        type: 'select',
        defaultValue: '',
        options: [
          { value: '', label: t('tab.newSessionModal.personaNone') },
          ...teamMembers.map((m) => ({ value: m.id, label: `${m.name} — ${m.role}` })),
        ],
        onSelectChange: (value) => setPersonaFieldPin(value),
      },
      {
        label: t('tab.newSessionModal.promptLabel'),
        id: 'session-prompt',
        type: 'textarea',
        placeholder: t('tab.newSessionModal.promptPlaceholder'),
        rows: 3,
      },
    );
  }

  fields.push(
    { label: t('tab.newSessionModal.argumentsLabel'), id: 'session-args', placeholder: t('tab.newSessionModal.argumentsPlaceholder'), defaultValue: project.defaultArgs ?? '' },
    {
      label: t('tab.newSessionModal.keepArgsLabel'),
      id: 'keep-args',
      type: 'checkbox',
      defaultValue: project.defaultArgs ? 'true' : undefined,
    },
    { label: t('tab.newSessionModal.envLabel'), id: 'session-env', type: 'textarea', placeholder: t('tab.newSessionModal.envPlaceholder'), defaultValue: project.defaultEnv ?? '' },
    {
      label: t('tab.newSessionModal.keepEnvLabel'),
      id: 'keep-env',
      type: 'checkbox',
      defaultValue: project.defaultEnv ? 'true' : undefined,
    },
  );

  const preferred = project.defaultProvider ?? appState.preferences.defaultProvider ?? 'claude';
  const effectiveProvider = (availabilityMap.get(preferred) ? preferred : providers.find(p => availabilityMap.get(p.id))?.id) ?? 'claude';
  if (providers.length > 1) {
    fields.unshift({
      label: t('tab.newSessionModal.providerLabel'),
      id: 'provider',
      type: 'select',
      defaultValue: effectiveProvider,
      onSelectChange: (value) => {
        setProfileFieldProvider(value as ProviderId);
        setPersonaFieldProvider(value as ProviderId);
      },
      options: providers.map(p => {
        const available = availabilityMap.get(p.id);
        return { value: p.id, label: available ? p.displayName : t('tab.newSessionModal.providerNotInstalled', { name: p.displayName }), disabled: !available };
      }),
    });
  }

  // Profile picker — scoped to the selected coding tool (bare names, no
  // provider suffix). Offered when any available provider has profiles; the
  // provider select's onSelectChange re-scopes the list and hides the field
  // when the tool has none.
  const anyProviderHasProfiles = providers.some((p) => providerProfileOptions(p.id as ProviderId).length > 0);
  const initialProfileValue = project.defaultProfileId ?? appState.preferences.defaultProfiles?.[effectiveProvider as ProviderId] ?? '';
  if (anyProviderHasProfiles) {
    fields.push({
      label: t('tab.newSessionModal.profileLabel'),
      id: 'profile',
      type: 'select',
      defaultValue: initialProfileValue,
      options: [
        { value: '', label: t('sidebar.defaultProfileOption') },
        ...providerProfileOptions(effectiveProvider as ProviderId),
      ],
      onSelectCreated: (select) => { profileSelect = select; },
    });
  }

  showModal(t('tab.newSessionModal.title'), fields, (values) => {
    const name = values['session-name']?.trim();
    if (!name) return;

    const envVars = values['session-env']?.trim() || undefined;
    if (envVars) {
      const invalid = findInvalidEnvLines(envVars);
      if (invalid.length > 0) {
        setModalError('session-env', t('tab.newSessionModal.envError', { line: invalid[0] }));
        return;
      }
    }

    const args = values['session-args']?.trim() || undefined;
    const keepArgs = values['keep-args'] === 'true';
    const keepEnv = values['keep-env'] === 'true';
    const providerId = (values['provider'] || 'claude') as ProviderId;
    const prompt = values['session-prompt']?.trim();

    // Persona path: `startTeamChat` resolves the team-chat backend, builds
    // the session with the member's systemPrompt (pendingSystemPrompt) and
    // the modal's name/args/env. Unlike board-card's "task must run"
    // fallback, the user explicitly picked a persona: a backend that can't
    // run personas is a hard error, surfaced on the persona row with the
    // modal still open — never a silent persona-less session.
    const personaId = values['persona']?.trim();
    if (personaId) {
      const member = appState.getTeamMemberById(personaId);
      const session = member
        ? startTeamChatWithOpts(project.id, member, providerId, {
            // The name field ships pre-filled with "Session {num}"; leaving
            // it at that default keeps the member-derived name
            // ("CMO - Session 2").
            name: name === sessionNamePlaceholder ? undefined : name,
            args,
            envVars,
          })
        : undefined;
      if (!session) {
        setModalError('persona', t('tab.newSessionModal.personaNotCapable', { name: getProviderDisplayName(providerId) }));
        return;
      }
      project.defaultArgs = keepArgs ? (args || undefined) : undefined;
      project.defaultEnv = keepEnv ? (envVars || undefined) : undefined;
      closeModal();
      if (prompt) setPendingPrompt(session.id, prompt);
      if (onCreated) onCreated(session);
      return;
    }

    closeModal();
    project.defaultArgs = keepArgs ? (args || undefined) : undefined;
    project.defaultEnv = keepEnv ? (envVars || undefined) : undefined;
    // Profiles only apply to profile-capable providers; ignore the field
    // for the rest.
    const profileId = getProviderCapabilities(providerId)?.profiles === true ? (values['profile'] || undefined) : undefined;
    const session = appState.addSession(project.id, name, args, providerId, profileId, envVars, opts);
    if (session) {
      // Plain path: the custom prompt (when the team rows are offered) is
      // the user's first message, converted to the PTY initialPrompt at
      // spawn — same mechanism as the Ask AI composer.
      if (prompt) setPendingPrompt(session.id, prompt);
      if (onCreated) onCreated(session);
    }
  });

  // Re-scope the profile list to the provider the dialog opened with,
  // keeping the project/global default when it belongs to that tool.
  setProfileFieldProvider(effectiveProvider as ProviderId, initialProfileValue);
  setPersonaFieldProvider(effectiveProvider as ProviderId);
}

function addMcpInspector(): void {
  const project = appState.activeProject;
  if (!project) return;

  const inspectorNum = nextNumberFor(MCP_INSPECTOR_NAME_KEY, project);
  appState.addMcpInspectorSession(project.id, t('tab.newMcpInspector.defaultName', { num: inspectorNum }));
}
