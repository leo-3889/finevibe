// Joining a child segment onto a path the renderer only knows as a string.
// The renderer has no Node `path`, and the hardcoded `/` this replaces
// produced `E:\AI/Brillance` on Windows: main resolves it verbatim, so the
// mixed spelling was persisted into the project record. Pure JS, no Node
// APIs — same rule as `shared/platform.ts`.

/**
 * `parent` + `child` with the separator the parent's own spelling asks for.
 *
 * A trailing separator on the parent and a leading one on the child are
 * trimmed so the join never doubles; a separator-only parent (`/`) is kept as
 * the root it is. A drive parent (`E:`) always gets `\` — `E:` + `AI` joined
 * without a separator is `E:AI`, which on Windows is cwd-relative, not
 * `E:\AI`. Otherwise: backslash for a parent that uses only backslashes,
 * slash for a parent that uses only slashes, and for a mixed parent the last
 * separator style it used, defaulting to `/`.
 */
export function joinChildPath(parent: string, child: string): string {
  const head = parent.trim();
  if (!head) return child;
  // A leading separator on the child is the join, not part of the segment.
  const tail = child.trim().replace(/^[\\/]+/, '');
  if (!tail) return head;

  let base = head.replace(/[\\/]+$/, '');
  if (!base) base = head.slice(0, 1); // separator-only parent: keep its root

  const baseIsRoot = base.endsWith('/') || base.endsWith('\\');
  const sep = baseIsRoot ? '' : separatorFor(base);
  return base + sep + tail;
}

function separatorFor(parent: string): string {
  // A drive path is Windows-spelled whatever its tail separator style.
  if (/^[A-Za-z]:/.test(parent)) return '\\';
  const backslash = parent.lastIndexOf('\\');
  const slash = parent.lastIndexOf('/');
  if (backslash >= 0 && slash < 0) return '\\';
  if (slash >= 0 && backslash < 0) return '/';
  return backslash > slash ? '\\' : '/';
}
