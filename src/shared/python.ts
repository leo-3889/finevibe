/**
 * Embed a JS value as a Python literal, for the hook scripts the providers
 * generate.
 *
 * Use this instead of a raw `r'...'` literal for anything path-shaped:
 * `JSON.stringify`'s escapes (`\\`, `\"`, `\uXXXX`) are all valid Python ones,
 * whereas a raw literal breaks on an apostrophe in the path — a Windows user
 * named O'Brien — and the resulting SyntaxError kills the entire hook script
 * silently. See the same note in `hook-status.ts`'s `buildStatusLinePython`.
 *
 * Lives here rather than in `hook-commands.ts` so provider suites that mock that
 * module don't have to stub a pure serializer.
 */
export function pyLiteral(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * stdin UTF-8 guard, embedded in every generated hook script that reads
 * stdin. Python <3.15 decodes `sys.stdin` with the locale/ANSI code page:
 * on Windows a hook payload containing non-ASCII (a path with an umlaut, an
 * emoji in a prompt) made `json.load(sys.stdin)` raise UnicodeDecodeError,
 * the script exited, and the capture (cost/context/title/session-id/
 * tool-failure) died silently. The guard re-opens stdin as UTF-8; the broad
 * except keeps it inert on interpreters lacking `reconfigure` (<3.7) or on
 * exotic stdin shapes. Paired with `-X utf8` on every Windows invocation.
 *
 * Lives here next to `pyLiteral` for the same reason: provider suites mock
 * `hook-commands` wholesale and must not have to stub this constant, and
 * `hook-status.ts` importing it from `hook-commands` would close an import
 * cycle for a pure string.
 */
export const STDIN_UTF8_GUARD =
  'try:\n' +
  '    sys.stdin.reconfigure(encoding="utf-8")\n' +
  'except Exception:\n' +
  '    pass\n';
