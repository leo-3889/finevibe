import type { TopFile } from '../../../../shared/types.js';
import { appState } from '../../../state.js';
import { formatTokens } from '../../../session-cost.js';
import type { WidgetFactory } from './widget-host.js';
import { resolveTopFilesConfig, type TopFilesConfig } from './top-files-types.js';

export const createTopFilesWidget: WidgetFactory = (host) => {
  const root = document.createElement('div');
  root.className = 'widget-top-files';

  const body = document.createElement('div');
  body.className = 'widget-top-files-body';
  root.appendChild(body);

  let renderToken = 0;

  function setStatus(message: string, kind: 'loading' | 'empty'): void {
    const el = document.createElement('div');
    el.className = kind === 'loading' ? 'widget-top-files-loading' : 'widget-top-files-empty';
    el.textContent = message;
    body.replaceChildren(el);
  }

  function renderRows(files: TopFile[]): void {
    if (files.length === 0) {
      setStatus('No countable text files found.', 'empty');
      return;
    }
    const list = document.createElement('div');
    list.className = 'widget-top-files-list';
    for (const file of files) {
      list.appendChild(buildRow(file));
    }
    body.replaceChildren(list);
  }

  function buildRow(file: TopFile): HTMLElement {
    const row = document.createElement('div');
    row.className = 'widget-top-files-row';
    row.title = `${file.path} — ${file.tokens.toLocaleString()} tokens`;

    const name = document.createElement('div');
    name.className = 'widget-top-files-row-path';
    name.textContent = file.path;
    row.appendChild(name);

    const tokens = document.createElement('div');
    tokens.className = 'widget-top-files-row-tokens';
    tokens.textContent = `~ ${formatTokens(file.tokens)}`;
    row.appendChild(tokens);

    row.addEventListener('click', () => {
      appState.addFileReaderSession(host.projectId, file.path);
    });

    return row;
  }

  async function loadAndRender(): Promise<void> {
    const token = ++renderToken;
    const project = appState.projects.find((p) => p.id === host.projectId);
    if (!project) {
      setStatus('Project not found.', 'empty');
      return;
    }

    const { limit } = resolveTopFilesConfig(host.getConfig<Partial<TopFilesConfig>>());
    setStatus('Scanning project files…', 'loading');

    try {
      const result = await window.vibeyard.fs.topFilesByTokens(project.path, limit);
      if (token !== renderToken) return;
      if (!result.ok) {
        setStatus('Could not scan project files.', 'empty');
        return;
      }
      renderRows(result.files);
    } catch {
      if (token !== renderToken) return;
      setStatus('Could not scan project files.', 'empty');
    }
  }

  void loadAndRender();

  return {
    element: root,
    destroy() {
      // Invalidate any in-flight loadAndRender so it short-circuits before touching the detached DOM.
      renderToken++;
    },
    refresh() {
      void loadAndRender();
    },
  };
};
