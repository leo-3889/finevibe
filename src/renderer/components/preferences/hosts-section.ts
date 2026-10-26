// Settings → Hosts (multi-host Phase 1, plan §6). Host cards with live
// status, add/edit wizard (connection → auth → test/TOFU → enroll),
// per-card actions, and the UR-4 host-scoped coding-tools panel.
// The registry is main-owned: everything flows through window.finevibe.hosts.
// All DOM is built with createElement/textContent (no innerHTML).

import { t } from '../../i18n.js';
import { showModal, closeModal, setModalError, showConfirmDialog, type FieldDef } from '../modal.js';
import { createCustomSelect, type CustomSelectInstance } from '../custom-select.js';
import { openRemoteShellTab } from '../project-terminal.js';
import { getCachedProviderMetas, getProviderDisplayName } from '../../provider-availability.js';
import type { HostRecord } from '../../../shared/types.js';
import type { PreferencesContext, SectionController } from './section.js';

interface StepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createHostsSection(ctx: PreferencesContext): SectionController {
  let hosts: HostRecord[] = [];
  let secretsOk = true;
  let busy = false;
  let toolSelect: CustomSelectInstance | null = null;
  let statusUnsub: (() => void) | null = null;
  // Last per-card outcome (test/enroll steps), keyed by host id.
  const lastResult = new Map<string, StepResult[]>();

  function refreshBadge(): void {
    ctx.setSetupBadge(hosts.some((h) => h.enrollmentStatus === 'failed'));
  }

  async function load(): Promise<void> {
    hosts = await window.finevibe.hosts.list();
    refreshBadge();
  }

  function stepLine(parent: HTMLElement, step: string, ok: boolean, detail?: string): void {
    const row = el('div', `hosts-step ${ok ? 'ok' : 'fail'}`, `${ok ? '✓' : '✗'} ${t(`hosts.step.${step}`)}`);
    if (detail) row.appendChild(el('span', 'hosts-step-detail', ` — ${detail}`));
    parent.appendChild(row);
  }

  function buildCard(h: HostRecord): HTMLElement {
    const card = el('div', 'hosts-card');
    card.dataset.id = h.id;

    const head = el('div', 'hosts-card-head');
    const dot = el('span', `hosts-dot ${h.enrollmentStatus}`);
    dot.title = t(`hosts.status.${h.enrollmentStatus}`);
    head.appendChild(dot);
    head.appendChild(el('span', 'hosts-card-name', h.name));
    head.appendChild(el('span', 'hosts-card-target', `${h.user}@${h.host}:${h.port}`));
    head.appendChild(el('span', 'hosts-card-auth', h.authKind === 'key' ? '🔑' : '🔒'));
    card.appendChild(head);

    if (h.lastProbeAt) card.appendChild(el('div', 'hosts-card-probe', t('hosts.lastProbe', { at: h.lastProbeAt })));
    if (h.enrollmentDetail) card.appendChild(el('div', 'hosts-card-detail', h.enrollmentDetail));

    for (const s of lastResult.get(h.id) ?? []) stepLine(card, s.step, s.ok, s.detail);

    if (h.prerequisites) {
      const details = document.createElement('details');
      details.className = 'hosts-prereqs';
      const summary = el('summary', undefined, t('hosts.prereqs'));
      details.appendChild(summary);
      for (const [k, v] of Object.entries(h.prerequisites)) stepLine(details, k, v.ok === true, v.version);
      card.appendChild(details);
    }

    const actions = el('div', 'hosts-card-actions');
    const enrolled = h.enrollmentStatus === 'enrolled' || h.enrollmentStatus === 'partial';
    const addBtn = (act: string, label: string, disabled = false): void => {
      const btn = document.createElement('button');
      btn.className = 'btn-secondary btn-sm hosts-action';
      btn.textContent = t(label);
      btn.dataset.act = act;
      btn.dataset.id = h.id;
      btn.disabled = disabled;
      actions.appendChild(btn);
    };
    addBtn('test', 'hosts.test');
    addBtn('enroll', h.enrollmentStatus === 'draft' ? 'hosts.enroll' : 'hosts.reenroll');
    addBtn('shell', 'hosts.openShell', h.enrollmentStatus !== 'enrolled');
    addBtn('edit', 'hosts.edit');
    addBtn('remove', 'hosts.remove');
    if (enrolled && h.authKind === 'password') addBtn('forget', 'hosts.forgetPassword');
    card.appendChild(actions);
    return card;
  }

  function toolRow(parent: Node, name: string, ok: boolean, version?: string): void {
    const row = el('div', `hosts-tool-row ${ok ? 'ok' : 'fail'}`, ok ? '✓' : '✗');
    row.appendChild(el('span', 'hosts-tool-name', ` ${name}`));
    if (ok && version) row.appendChild(el('span', 'hosts-tool-version', ` ${version}`));
    if (!ok) row.appendChild(el('span', 'hosts-tool-missing', ` ${t('hosts.toolMissing')}`));
    parent.appendChild(row);
  }

  async function renderTools(hostId: string): Promise<void> {
    const list = document.getElementById('hosts-tools-list');
    if (!list) return;
    list.replaceChildren(el('div', 'hosts-tools-loading', t('hosts.toolsLoading')));
    const metas = getCachedProviderMetas();
    const rows: { name: string; ok: boolean; version?: string }[] = [];
    if (hostId === 'local') {
      for (const m of metas) rows.push({ name: getProviderDisplayName(m.id), ok: await window.finevibe.provider.checkBinary(m.id) });
    } else {
      const tools = await window.finevibe.hosts.tools(hostId);
      for (const m of metas) {
        const hit = tools?.[m.id];
        rows.push({ name: getProviderDisplayName(m.id), ok: hit?.ok === true, ...(hit?.version ? { version: hit.version } : {}) });
      }
    }
    if (!ctx.isActiveSection('hosts')) return;
    const frag = document.createDocumentFragment();
    for (const r of rows) toolRow(frag, r.name, r.ok, r.version);
    list.replaceChildren(frag);
  }

  async function runTest(id: string): Promise<void> {
    const res = await window.finevibe.hosts.test(id);
    const steps = [...res.steps];
    if (res.hostKeyChanged) steps.push({ step: 'host-key', ok: false, detail: t('hosts.hostKeyChanged') });
    lastResult.set(id, steps);
    if (res.newFingerprint) {
      const fp = res.newFingerprint;
      showConfirmDialog(t('hosts.fingerprintTitle'), t('hosts.fingerprintPrompt', { fingerprint: fp }), {
        confirmLabel: t('hosts.approveKey'),
        onConfirm: async () => {
          closeModal();
          await window.finevibe.hosts.approveHostKey(id, fp);
          await runEnroll(id);
        },
      });
    }
    if (ctx.isActiveSection('hosts')) ctx.rerenderSection('hosts');
  }

  async function runEnroll(id: string): Promise<void> {
    const res = await window.finevibe.hosts.enroll(id);
    lastResult.set(id, res.steps);
    // §4: after key-auth enrollment succeeds, offer to forget the password.
    const rec = hosts.find((h) => h.id === id);
    if (res.ok && res.steps.some((s) => s.step === 'forget-password') && rec?.authKind === 'password') {
      showConfirmDialog(t('hosts.forgetPassword'), t('hosts.forgetPasswordPrompt'), {
        confirmLabel: t('hosts.forgetPassword'),
        onConfirm: async () => {
          closeModal();
          await window.finevibe.hosts.forgetPassword(id);
        },
      });
    }
    await load();
    if (ctx.isActiveSection('hosts')) ctx.rerenderSection('hosts');
  }

  function wizard(existing: HostRecord | null): void {
    const fields: FieldDef[] = [
      { id: 'name', label: t('hosts.field.name'), type: 'text', defaultValue: existing?.name, maxLength: 64 },
      { id: 'user', label: t('hosts.field.user'), type: 'text', defaultValue: existing?.user },
      { id: 'host', label: t('hosts.field.host'), type: 'text', defaultValue: existing?.host },
      { id: 'port', label: t('hosts.field.port'), type: 'text', defaultValue: String(existing?.port ?? 22) },
      {
        id: 'authKind', label: t('hosts.field.authKind'), type: 'select',
        options: [
          { value: 'key', label: t('hosts.field.authKey') },
          { value: 'password', label: t('hosts.field.authPassword') },
        ],
        defaultValue: existing?.authKind ?? 'key',
      },
      { id: 'keyPath', label: t('hosts.field.keyPath'), type: 'text', defaultValue: existing?.privateKeyPath, placeholder: t('hosts.field.keyPathPlaceholder'), buttonLabel: t('hosts.field.browse'), onButtonClick: async (input) => {
        // Pick the key's directory and complete the file name by hand — the
        // app exposes a directory picker only (fs.browseDirectory).
        const picked = await window.finevibe.fs.browseDirectory();
        if (picked) input.value = picked;
      } },
      { id: 'secret', label: t('hosts.field.secret'), type: 'text', placeholder: t('hosts.field.secretPlaceholder') },
    ];
    showModal(t(existing ? 'hosts.editTitle' : 'hosts.addTitle'), fields, async (values) => {
      const port = parseInt(values.port || '22', 10);
      if (!values.name?.trim()) { setModalError('name', t('hosts.err.name')); return; }
      if (!values.user?.trim()) { setModalError('user', t('hosts.err.user')); return; }
      if (!values.host?.trim()) { setModalError('host', t('hosts.err.host')); return; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { setModalError('port', t('hosts.err.port')); return; }
      if (busy) return;
      busy = true;
      try {
        let record = existing;
        const authKind = values.authKind === 'password' ? 'password' : 'key';
        const keyPath = values.keyPath?.trim();
        if (existing) {
          record = await window.finevibe.hosts.update(existing.id, {
            name: values.name.trim(), user: values.user.trim(), host: values.host.trim(), port, authKind,
            ...(authKind === 'key' ? { privateKeyPath: keyPath || existing.privateKeyPath, managedKey: keyPath ? false : existing.managedKey } : {}),
          });
        } else {
          // Generated key when key-auth and the user supplied no key path.
          const seed = authKind === 'key' && !keyPath ? await window.finevibe.hosts.generateKey() : null;
          record = await window.finevibe.hosts.create({
            ...(seed ? { id: seed.id, privateKeyPath: seed.privateKeyPath, managedKey: true } : {}),
            ...(authKind === 'key' && !seed ? { privateKeyPath: keyPath, managedKey: false } : {}),
            name: values.name.trim(),
            user: values.user.trim(),
            host: values.host.trim(),
            port,
            authKind,
            enrollmentStatus: 'draft',
          });
        }
        if (values.secret?.trim()) {
          await window.finevibe.hosts.setSecret(record.id, authKind === 'password' ? 'password' : 'keypass', values.secret.trim());
        }
        closeModal();
        await load();
        if (ctx.isActiveSection('hosts')) ctx.rerenderSection('hosts');
        if (!existing) await runTest(record.id);
      } catch (err) {
        setModalError('host', err instanceof Error ? err.message : String(err));
      } finally {
        busy = false;
      }
    }, { confirmLabel: t(existing ? 'hosts.edit' : 'hosts.add') });
  }

  function onCardClick(ev: MouseEvent): void {
    const btn = (ev.target as HTMLElement).closest?.('button.hosts-action') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    const { act, id } = btn.dataset;
    if (!act || !id) return;
    const host = hosts.find((h) => h.id === id);
    void (async () => {
      try {
        if (act === 'test') await runTest(id);
        else if (act === 'enroll') await runEnroll(id);
        else if (act === 'forget') { await window.finevibe.hosts.forgetPassword(id); if (ctx.isActiveSection('hosts')) ctx.rerenderSection('hosts'); }
        else if (act === 'edit') wizard(host ?? null);
        else if (act === 'shell') {
          const ok = await openRemoteShellTab(id, host?.name ?? id);
          if (!ok) lastResult.set(id, [{ step: 'shell', ok: false, detail: t('hosts.shellNeedsProject') }]);
          if (ctx.isActiveSection('hosts')) ctx.rerenderSection('hosts');
        } else if (act === 'remove' && host) {
          const enrolled = host.enrollmentStatus === 'enrolled' || host.enrollmentStatus === 'partial';
          showConfirmDialog(t('hosts.remove'), t(enrolled ? 'hosts.confirmRemoveEnrolled' : 'hosts.confirmRemove', { name: host.name }), {
            confirmLabel: t('hosts.remove'),
            onConfirm: async () => {
              closeModal();
              if (enrolled) await window.finevibe.hosts.unenroll(id);
              await window.finevibe.hosts.delete(id);
              await load();
              if (ctx.isActiveSection('hosts')) ctx.rerenderSection('hosts');
            },
          });
        }
      } catch (err) {
        lastResult.set(id, [{ step: 'action', ok: false, detail: err instanceof Error ? err.message : String(err) }]);
        if (ctx.isActiveSection('hosts')) ctx.rerenderSection('hosts');
      }
    })();
  }

  function render(container: HTMLElement): void {
    toolSelect?.destroy();
    toolSelect = null;
    void (async () => {
      secretsOk = await window.finevibe.hosts.secretsAvailable();
      await load();
      if (!ctx.isActiveSection('hosts')) return;
      container.replaceChildren();
      container.appendChild(el('div', 'preferences-subheading', t('hosts.heading')));
      container.appendChild(el('div', 'preferences-section-desc', t('hosts.description')));
      if (!secretsOk) container.appendChild(el('div', 'hosts-r1-banner', t('hosts.r1Banner')));
      const list = el('div', 'hosts-list');
      if (hosts.length === 0) list.appendChild(el('div', 'hosts-empty', t('hosts.empty')));
      for (const h of hosts) list.appendChild(buildCard(h));
      list.addEventListener('click', onCardClick);
      container.appendChild(list);
      const addRow = el('div', 'hosts-add-row');
      const addBtn = el('button', 'btn-primary hosts-add-btn', t('hosts.add'));
      addBtn.addEventListener('click', () => wizard(null));
      addRow.appendChild(addBtn);
      container.appendChild(addRow);
      container.appendChild(el('div', 'preferences-subheading hosts-tools-heading', t('hosts.toolsHeading')));
      const picker = el('div', 'hosts-tools-picker');
      const selectEl = document.createElement('select');
      selectEl.id = 'hosts-tool-host';
      picker.appendChild(selectEl);
      container.appendChild(picker);
      const toolsList = el('div', 'hosts-tools-list');
      toolsList.id = 'hosts-tools-list';
      container.appendChild(toolsList);
      toolSelect = createCustomSelect('hosts-tool-host', [{ value: 'local', label: t('hosts.toolsLocal') }, ...hosts.map((h) => ({ value: h.id, label: h.name }))], 'local', (v) => void renderTools(String(v)));
      void renderTools('local');
    })();
    if (!statusUnsub) {
      statusUnsub = window.finevibe.hosts.onStatus(() => {
        void load().then(() => {
          if (ctx.isActiveSection('hosts')) ctx.rerenderSection('hosts');
        });
      });
    }
  }

  function destroy(): void {
    toolSelect?.destroy();
    toolSelect = null;
    statusUnsub?.();
    statusUnsub = null;
  }

  return { render, destroy };
}
