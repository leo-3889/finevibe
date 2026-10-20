// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { esc } from './dom-utils.js';

describe('esc', () => {
  it('serializes markup-significant text characters', () => {
    expect(esc('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });

  it('escapes double quotes — the DOM serializer alone never emits &quot; (P2-102)', () => {
    // Every attribute site interpolates esc() inside a quoted attribute
    // (git-panel title, active-sessions-panel data-project-id/data-session-id/
    // title, project-terminal data-shell-id). A raw `"` closed the attribute
    // and injected markup; the text serializer leaves quotes untouched, so
    // esc() must serialize them itself.
    expect(esc('x" onmouseover="alert(1)')).toBe('x&quot; onmouseover=&quot;alert(1)');
  });

  it('round-trips as a literal inside a quoted attribute', () => {
    const host = document.createElement('div');
    host.innerHTML = `<span title="${esc('a"b')}">t</span>`;
    const span = host.querySelector('span')!;
    expect(span.getAttribute('title')).toBe('a"b');
    expect(span.getAttribute('onmouseover')).toBeNull();
  });
});
