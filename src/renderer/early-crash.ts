// Early crash capture (audit row 16). `src/main/app-scheme.ts` injects a
// nonce-bearing inline script into the served index.html that registers
// 'error'/'unhandledrejection' listeners BEFORE the bundle module evaluates, so
// a crash during import evaluation — when the bundle's own wiring below has not
// run yet — is recorded into `window.__fvEarlyCrash` (capped at 5, mirroring
// the reportRendererError flood cap; a loop that throws every frame must not
// grow an array). The inline script carries the same text as
// `EARLY_CRASH_SCRIPT_SRC` in src/main/app-scheme.ts; its SHA-256 hash is
// allowlisted by both CSPs, so the nonce in the script tag is a defense in
// depth second factor.

export type EarlyCrashEntry = string;

declare global {
  interface Window {
    /** Written by the served-page inline pre-load handler; drained once at bundle start. */
    __fvEarlyCrash?: EarlyCrashEntry[];
  }
}

/** Take ownership of the pre-load entries: returns them and clears the array. */
export function drainEarlyCrashes(): EarlyCrashEntry[] {
  const entries = window.__fvEarlyCrash;
  if (!Array.isArray(entries) || entries.length === 0) return [];
  window.__fvEarlyCrash = [];
  return entries;
}
