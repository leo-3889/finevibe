// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import {
  createInspectorPane,
  destroyInspectorPane,
  getInspectorInstance,
  disconnectInspector,
} from './mcp-inspector.js';

interface McpApi {
  connect: Mock;
  disconnect: Mock;
  listTools: Mock;
  listResources: Mock;
  listPrompts: Mock;
  callTool: Mock;
}

let mcp: McpApi;

function defer(): { promise: Promise<unknown>; resolve: (v: unknown) => void } {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

beforeEach(() => {
  mcp = {
    connect: vi.fn(async () => ({ success: true })),
    disconnect: vi.fn(async () => ({ success: true })),
    listTools: vi.fn(async () => ({ success: true, data: [] })),
    listResources: vi.fn(async () => ({ success: true, data: [] })),
    listPrompts: vi.fn(async () => ({ success: true, data: [] })),
    callTool: vi.fn(async () => ({ success: true, data: null })),
  };
  (globalThis as unknown as { window: { finevibe: { mcp: McpApi } } }).window.finevibe = { mcp };
  document.body.innerHTML = '';
});

function startConnect(sessionId: string): { done: () => void } {
  createInspectorPane(sessionId);
  const instance = getInspectorInstance(sessionId)!;
  document.body.appendChild(instance.element);
  const pane = instance.element;
  (pane.querySelector('.mcp-url-input') as HTMLInputElement).value = 'http://localhost:3000/mcp';
  const d = defer();
  mcp.connect.mockReturnValue(d.promise);
  (pane.querySelector('.mcp-connect-btn') as HTMLButtonElement).click();
  return { done: d.resolve };
}

describe('mcp-inspector lifecycle', () => {
  it('destroying the pane while connecting requests a disconnect', () => {
    startConnect('s1');
    expect(mcp.connect).toHaveBeenCalledWith('s1', 'http://localhost:3000/mcp');

    destroyInspectorPane('s1');

    expect(mcp.disconnect).toHaveBeenCalledWith('s1');
    expect(getInspectorInstance('s1')).toBeUndefined();
  });

  it('ignores a connect completion after the pane was destroyed', async () => {
    const { done } = startConnect('s1');
    destroyInspectorPane('s1');

    done({ success: true });
    await flush();

    expect(getInspectorInstance('s1')).toBeUndefined();
  });

  it('disconnectInspector requests a disconnect even while connecting', async () => {
    startConnect('s1');

    await disconnectInspector('s1');

    expect(mcp.disconnect).toHaveBeenCalledWith('s1');
    expect(getInspectorInstance('s1')?.connected).toBe(false);
  });
  it('a stale completion does not flip a recreated pane to connected', async () => {
    const { done } = startConnect('s1');
    destroyInspectorPane('s1');
    createInspectorPane('s1');
    const pane = getInspectorInstance('s1')!.element;
    document.body.appendChild(pane);

    done({ success: true });
    await flush();

    expect(getInspectorInstance('s1')?.connected).toBe(false);
    expect((pane.querySelector('.mcp-connect-btn') as HTMLButtonElement).textContent).toBe('Connect');
  });

  it('destroy then recreate the same id connects fresh', async () => {
    createInspectorPane('s1');
    destroyInspectorPane('s1');
    expect(mcp.disconnect).toHaveBeenCalledWith('s1');

    const { done } = startConnect('s1');
    done({ success: true });
    await flush();

    expect(getInspectorInstance('s1')?.connected).toBe(true);
  });
});

describe('mcp-inspector refreshLists (UI3-8)', () => {
  // The module-level `instances` map survives the beforeEach DOM reset, so this
  // suite uses its own session id: the tests above leave a connected 's1' behind.
  it('a pane destroyed while the lists load is never rendered into', async () => {
    createInspectorPane('s-refresh');
    const pane = getInspectorInstance('s-refresh')!.element;
    document.body.appendChild(pane);
    (pane.querySelector('.mcp-url-input') as HTMLInputElement).value = 'http://localhost:3000/mcp';

    const connect = defer();
    const lists = [defer(), defer(), defer()];
    mcp.connect.mockReturnValue(connect.promise);
    mcp.listTools.mockReturnValue(lists[0].promise);
    mcp.listResources.mockReturnValue(lists[1].promise);
    mcp.listPrompts.mockReturnValue(lists[2].promise);

    (pane.querySelector('.mcp-connect-btn') as HTMLButtonElement).click();
    connect.resolve({ success: true });
    await vi.waitFor(() => expect(mcp.listTools).toHaveBeenCalledWith('s-refresh'));

    const content = pane.querySelector('.mcp-inspector-content') as HTMLElement;
    destroyInspectorPane('s-refresh');
    const htmlAtDestroy = content.innerHTML;

    for (const l of lists) l.resolve({ success: true, data: [{ name: 'echo' }] });
    await vi.waitFor(() => expect(mcp.disconnect).toHaveBeenCalledWith('s-refresh'));
    await flush();

    // UI3-8: refreshLists used to write the dead pane's content and nav counts,
    // and doConnect then re-enabled the destroyed pane's Connect button.
    expect(content.innerHTML).toBe(htmlAtDestroy);
    expect(content.querySelector('.mcp-card')).toBeNull();
    expect(Array.from(pane.querySelectorAll('.mcp-nav-count')).map(c => c.textContent))
      .toEqual(['0', '0', '0']);
    expect((pane.querySelector('.mcp-connect-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('mcp-inspector late results (CI-13)', () => {
  // The card bodies are built per instance, so a result that lands after the
  // pane was destroyed (or after the same session id was re-opened with a fresh
  // instance) has to be dropped: writing it re-animates dead DOM and, on a
  // re-open, the late value has nothing to do with the live card.
  async function connectedCard(sessionId: string): Promise<HTMLElement> {
    createInspectorPane(sessionId);
    const pane = getInspectorInstance(sessionId)!.element;
    document.body.appendChild(pane);
    mcp.listTools.mockResolvedValue({ success: true, data: [{ name: 'echo' }] });
    (pane.querySelector('.mcp-url-input') as HTMLInputElement).value = 'http://localhost:3000/mcp';
    (pane.querySelector('.mcp-connect-btn') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(pane.querySelector('.mcp-card')).not.toBeNull());
    (pane.querySelector('.mcp-card-header') as HTMLElement).click();
    return pane;
  }

  it('drops a tool result that lands after the pane was destroyed', async () => {
    const pane = await connectedCard('s-call');
    const exec = pane.querySelector('.mcp-exec-btn') as HTMLButtonElement;
    const resultPre = pane.querySelector('.mcp-result') as HTMLElement;
    const call = defer();
    mcp.callTool.mockReturnValue(call.promise);

    exec.click();
    expect(resultPre.textContent).toBe('Loading...');

    destroyInspectorPane('s-call');
    call.resolve({ success: true, data: 'LATE' });
    await vi.waitFor(() => expect(mcp.callTool).toHaveBeenCalledWith('s-call', 'echo', {}));
    await flush();

    // CI-13: without the identity check the detached card's `<pre>` was
    // rewritten (and its button re-enabled) from a dead generation.
    expect(resultPre.textContent).toBe('Loading...');
    expect(exec.disabled).toBe(true);
    expect(resultPre.textContent).not.toContain('LATE');
  });

  it('drops the result for a re-created pane of the same session id', async () => {
    const pane = await connectedCard('s-reopen');
    const exec = pane.querySelector('.mcp-exec-btn') as HTMLButtonElement;
    const call = defer();
    mcp.callTool.mockReturnValue(call.promise);
    exec.click();

    destroyInspectorPane('s-reopen');
    createInspectorPane('s-reopen');
    const fresh = getInspectorInstance('s-reopen')!.element;
    document.body.appendChild(fresh);

    call.resolve({ success: true, data: 'LATE' });
    await flush();

    expect(fresh.querySelector('.mcp-result')).toBeNull();
    expect(pane.querySelector('.mcp-result')!.textContent).toBe('Loading...');
  });
});
