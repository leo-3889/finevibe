import { appState } from '../../state.js';
import { isMac } from '../../platform.js';
import { createCustomSelect, type CustomSelectInstance } from '../custom-select.js';
import { showModal, closeModal, setModalError, showConfirmDialog } from '../modal.js';
import type { PreferencesContext, SectionController } from './section.js';

export function createProfilesSection(ctx: PreferencesContext): SectionController {
  let profileDefaultSelect: CustomSelectInstance | null = null;
  // Cached keychain-isolation status (macOS), fetched once per render and reused
  // by the Add Profile guard so it doesn't re-probe the keychain via IPC.
  let cachedKeychainStatus: Awaited<ReturnType<typeof window.vibeyard.profiles.keychainStatus>> | null = null;

  function render(container: HTMLElement) {
    if (profileDefaultSelect) { profileDefaultSelect.destroy(); profileDefaultSelect = null; }

    const heading = document.createElement('div');
    heading.className = 'preferences-subheading';
    heading.textContent = 'Claude profiles';
    container.appendChild(heading);

    const desc = document.createElement('div');
    desc.className = 'preferences-section-desc';
    desc.textContent = 'Each profile runs Claude Code against its own config directory (CLAUDE_CONFIG_DIR), isolating login, settings, and history — handy for separate work and personal licenses. After creating a profile, start a session with it and run /login once to sign in.';
    container.appendChild(desc);

    // macOS-only guardrail notice: per-profile login isolation depends on Claude
    // Code namespacing its keychain entry per config dir. Older builds share one
    // entry, so logins would bleed across profiles. Surface the status inline.
    if (isMac) {
      const warnSlot = document.createElement('div');
      container.appendChild(warnSlot);
      void window.vibeyard.profiles.keychainStatus().then((res) => {
        cachedKeychainStatus = res;
        if (res.status === 'supported') return;
        const warn = document.createElement('div');
        warn.className = res.status === 'unsupported' ? 'profiles-keychain-warning' : 'profiles-keychain-warning info';
        warn.textContent = res.status === 'unsupported'
          ? `This version of Claude Code${res.version ? ` (${res.version})` : ''} stores every login under a single macOS keychain entry, so profiles can't keep accounts separate. Update Claude Code to create and use profiles.`
          : `Vibeyard can't yet confirm this Claude Code build isolates profile logins in the macOS keychain. Sign in to a profile once and isolation will be verified automatically.`;
        warnSlot.appendChild(warn);
      }).catch(() => { /* status check is best-effort */ });
    }

    const profiles = appState.profiles.filter((p) => p.providerId === 'claude');

    // Default profile selector (global fallback)
    const defaultRow = document.createElement('div');
    defaultRow.className = 'modal-toggle-field';
    const defaultLabel = document.createElement('label');
    defaultLabel.textContent = 'Default profile';
    profileDefaultSelect = createCustomSelect(
      'pref-default-profile',
      [{ value: '', label: 'Default (~/.claude)' }, ...profiles.map((p) => ({ value: p.id, label: p.name }))],
      appState.preferences.defaultProfileId ?? '',
      (value) => appState.setPreference('defaultProfileId', value || undefined),
    );
    defaultRow.appendChild(defaultLabel);
    defaultRow.appendChild(profileDefaultSelect.element);
    container.appendChild(defaultRow);

    // Profile list
    const list = document.createElement('div');
    list.className = 'profiles-list';
    if (profiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'profiles-empty';
      empty.textContent = 'No profiles yet.';
      list.appendChild(empty);
    } else {
      for (const profile of profiles) {
        const row = document.createElement('div');
        row.className = 'profile-row';

        const info = document.createElement('div');
        info.className = 'profile-row-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'profile-row-name';
        nameEl.textContent = profile.name;
        const tag = document.createElement('span');
        tag.className = 'profile-row-tag';
        tag.textContent = profile.managed ? 'managed' : 'custom';
        nameEl.appendChild(tag);
        const pathEl = document.createElement('div');
        pathEl.className = 'profile-row-path';
        pathEl.textContent = profile.configDir;
        info.appendChild(nameEl);
        info.appendChild(pathEl);

        const actions = document.createElement('div');
        actions.className = 'profile-row-actions';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-secondary btn-sm';
        editBtn.textContent = 'Rename';
        editBtn.addEventListener('click', () => promptEditProfile(profile.id, profile.name));
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-secondary btn-sm danger';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => {
          showConfirmDialog(
            'Delete profile',
            `Delete profile "${profile.name}"? Sessions and projects using it fall back to the default config dir. The config directory on disk is not removed.`,
            {
              confirmLabel: 'Delete',
              onConfirm: () => {
                appState.removeProfile(profile.id);
                ctx.rerenderSection('profiles');
              },
            },
          );
        });
        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);

        row.appendChild(info);
        row.appendChild(actions);
        list.appendChild(row);
      }
    }
    container.appendChild(list);

    const addRow = document.createElement('div');
    addRow.className = 'profiles-add-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-primary';
    addBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 5v14M5 12h14"/></svg><span>Add Profile</span>';
    addBtn.addEventListener('click', promptAddProfile);
    addRow.appendChild(addBtn);
    container.appendChild(addRow);
  }

  function promptAddProfile() {
    showModal('Add Profile', [
      { label: 'Name', id: 'profile-name', placeholder: 'e.g. Work' },
      { label: 'Custom config path (optional)', id: 'profile-path', placeholder: 'Leave blank for a managed directory' },
    ], async (values) => {
      const name = values['profile-name']?.trim();
      if (!name) { setModalError('profile-name', 'Name is required'); return; }
      // Block creation when this Claude build can't isolate profile logins on
      // macOS — otherwise the new profile would silently share the default
      // account's keychain login.
      if (isMac) {
        const { status, version } = cachedKeychainStatus ?? await window.vibeyard.profiles.keychainStatus();
        if (status === 'unsupported') {
          setModalError('profile-name', `Claude Code${version ? ` ${version}` : ''} can't isolate profile logins on macOS — update Claude Code first.`);
          return;
        }
      }
      const customPath = values['profile-path']?.trim() || undefined;
      try {
        await appState.addProfile({ name, providerId: 'claude', customPath });
      } catch (err) {
        setModalError('profile-path', `Could not create config directory: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      closeModal();
      ctx.rerenderSection('profiles');
    });
  }

  function promptEditProfile(id: string, currentName: string) {
    showModal('Rename Profile', [
      { label: 'Name', id: 'profile-name', defaultValue: currentName },
    ], (values) => {
      const name = values['profile-name']?.trim();
      if (!name) { setModalError('profile-name', 'Name is required'); return; }
      appState.updateProfile(id, { name });
      closeModal();
      ctx.rerenderSection('profiles');
    });
  }

  return {
    render,
    destroy() {
      if (profileDefaultSelect) { profileDefaultSelect.destroy(); profileDefaultSelect = null; }
    },
  };
}
