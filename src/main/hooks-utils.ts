// PA-34: codex-hooks.ts and gemini-hooks.ts carried byte-identical copies of
// cleanHooks/isIdeHook plus the three hook-config types — drift-critical,
// since every hook fix had to be applied once per provider. Single home; the
// provider hook marker is the parameter. Superset note: gemini's HookHandler
// declared an optional `name`, codex's did not; the shared type keeps it.

export interface HookHandler {
  type: string;
  command: string;
  name?: string;
}

export interface HookMatcherEntry {
  matcher?: string;
  hooks: HookHandler[];
}

export type HooksConfig = Record<string, HookMatcherEntry[]>;

/** True when a hook entry is one of ours (identified by the provider's marker comment). */
export function isIdeHook(h: HookHandler, marker: string): boolean {
  return h.command?.includes(marker) ?? false;
}

/** Remove all IDE-owned hooks from a provider config, keeping user hooks untouched. */
export function cleanHooks(existing: HooksConfig, marker: string): HooksConfig {
  const cleaned: HooksConfig = {};
  for (const [event, matchers] of Object.entries(existing)) {
    const filteredMatchers = matchers
      .map((m) => ({
        ...m,
        hooks: (m.hooks ?? []).filter((h) => !isIdeHook(h, marker)),
      }))
      .filter((m) => m.hooks.length > 0);
    if (filteredMatchers.length > 0) {
      cleaned[event] = filteredMatchers;
    }
  }
  return cleaned;
}
