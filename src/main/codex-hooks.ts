import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { STATUS_DIR } from './hook-status';
import { statusCmd as mkStatusCmd, captureSessionIdCmd as mkCaptureSessionIdCmd, installEventScript, wrapPythonHookCmd, installHookScripts } from './hook-commands';
import { readFileSafe, readJsonSafe } from './fs-utils';
import { cleanHooks, isIdeHook, type HookHandler, type HooksConfig } from './hooks-utils';
import type { InspectorEventType, SettingsValidationResult } from '../shared/types';
import { pyLiteral, STDIN_UTF8_GUARD } from '../shared/python';

export const CODEX_HOOK_MARKER = '# finevibe-hook';

const CODEX_DIR = path.join(homedir(), '.codex');
const HOOKS_JSON_PATH = path.join(CODEX_DIR, 'hooks.json');
const CONFIG_TOML_PATH = path.join(CODEX_DIR, 'config.toml');

export const SESSION_ID_VAR = 'FINEVIBE_SESSION_ID';

const EXPECTED_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'];

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

function isCodexHooksFeatureEnabled(): boolean {
  const content = readFileSafe(CONFIG_TOML_PATH);
  if (!content) return false;

  let inFeatures = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (/^\[.+\]$/.test(trimmed)) {
      inFeatures = trimmed === '[features]';
      continue;
    }
    if (inFeatures && /^codex_hooks\s*=\s*true/.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function ensureCodexHooksFeatureFlag(): void {
  fs.mkdirSync(CODEX_DIR, { recursive: true });

  const content = readFileSafe(CONFIG_TOML_PATH);
  if (!content) {
    fs.writeFileSync(CONFIG_TOML_PATH, '[features]\ncodex_hooks = true\n');
    return;
  }

  if (isCodexHooksFeatureEnabled()) return;

  const lines = content.split('\n');
  let featuresSectionIdx = -1;
  let codexHooksLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '[features]') {
      featuresSectionIdx = i;
      continue;
    }
    if (featuresSectionIdx !== -1 && /^\[.+\]$/.test(trimmed)) {
      break; // entered next section
    }
    if (featuresSectionIdx !== -1 && /^codex_hooks\s*=/.test(trimmed)) {
      codexHooksLineIdx = i;
      break;
    }
  }

  if (codexHooksLineIdx === -1) {
    if (featuresSectionIdx === -1) {
      const trailing = content.endsWith('\n') ? '' : '\n';
      lines.push(`${trailing}[features]`, 'codex_hooks = true');
    } else {
      lines.splice(featuresSectionIdx + 1, 0, 'codex_hooks = true');
    }
  } else {
    lines[codexHooksLineIdx] = 'codex_hooks = true';
  }

  fs.writeFileSync(CONFIG_TOML_PATH, lines.join('\n'));
}

// Inverse of ensureCodexHooksFeatureFlag: `installCodexHooks` turns the
// feature on, so `cleanupCodexHooks` must turn it off — with FineVibe's
// hooks stripped, a lingering `codex_hooks = true` makes every remaining
// user hooks.json entry fire on each Codex run outside the app, and the
// user has no in-app way to switch the feature back off.
function removeCodexHooksFeatureFlag(): void {
  const content = readFileSafe(CONFIG_TOML_PATH);
  if (!content) return;

  const lines = content.split('\n');
  let featuresSectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[features]') {
      featuresSectionIdx = i;
      break;
    }
  }
  if (featuresSectionIdx === -1) return;

  let nextSectionIdx = lines.length;
  for (let i = featuresSectionIdx + 1; i < lines.length; i++) {
    if (/^\[.+\]$/.test(lines[i].trim())) {
      nextSectionIdx = i;
      break;
    }
  }

  const sectionBody = lines
    .slice(featuresSectionIdx + 1, nextSectionIdx)
    .filter((line) => !/^codex_hooks\s*=/.test(line.trim()));
  // Keep the header only while the section still holds real content
  // (keys or comments — comments are the user's, never stripped). When
  // codex_hooks was the section's only entry, drop the empty header too.
  const hasContent = sectionBody.some((line) => line.trim() !== '');

  const out = [
    ...lines.slice(0, featuresSectionIdx),
    ...(hasContent ? [lines[featuresSectionIdx], ...sectionBody] : []),
    ...lines.slice(nextSectionIdx),
  ];
  fs.writeFileSync(CONFIG_TOML_PATH, out.join('\n'));
}

// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

export function installCodexHooks(): void {
  ensureCodexHooksFeatureFlag();

  // P2-60/P1-18: `readJsonSafe` answers `null` for a missing, truncated and
  // unparseable hooks.json alike, and the write below persists what it reads
  // — collapsing a corrupt file into `{}` deletes every user-authored Codex
  // hook and every other top-level key, with nothing to recover them.
  // Mirror of the guard gemini-hooks.ts carries: only a missing file starts
  // fresh; a corrupt one aborts, leaving the file untouched, and validation
  // honestly reports the hooks as not installed.
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, 'utf-8'));
    // `[1,2]`, `"x"`, `null`: the write below spreads this into an object,
    // the same silent loss — treat a non-object as corrupt.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    raw = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      raw = {};
    } else {
      console.warn(`codex: ${HOOKS_JSON_PATH} is not valid JSON; hooks not installed over a corrupt config`);
      return;
    }
  }
  const existingHooks: HooksConfig = (raw.hooks ?? {}) as HooksConfig;
  const cleaned = cleanHooks(existingHooks, CODEX_HOOK_MARKER);

  installHookScripts();

  const statusCmd = (event: string, status: string) =>
    mkStatusCmd(event, status, SESSION_ID_VAR, CODEX_HOOK_MARKER);

  const captureSessionIdCmd = mkCaptureSessionIdCmd(SESSION_ID_VAR, CODEX_HOOK_MARKER);

  const captureEventCmd = (hookEvent: string, eventType: string) => {
    const pyCode = `import sys,json,os,time
${STDIN_UTF8_GUARD}try:
 d=json.load(sys.stdin)
except:
 sys.exit(0)
sid=os.environ.get("${SESSION_ID_VAR}","")
if not sid:
 sys.exit(0)
e={"type":"${eventType}","timestamp":int(time.time()*1000),"hookEvent":"${hookEvent}"}
tn=d.get("tool_name","")
if tn:
 e["tool_name"]=tn
ti=d.get("tool_input")
if ti:
 e["tool_input"]=ti
for fld in ("session_id","cwd","model","turn_id"):
 v=d.get(fld,"")
 if v:
  e[fld]=v
status_dir=${pyLiteral(STATUS_DIR)}
with open(os.path.join(status_dir,sid+".events"),"a") as f:
 f.write(json.dumps(e)+"\\n")
`;
    const scriptName = `codex_event_${hookEvent}.py`;
    installEventScript(scriptName, pyCode);
    return wrapPythonHookCmd(scriptName, pyCode, CODEX_HOOK_MARKER);
  };

  // Status-changing events
  const ideEvents: Record<string, string> = {
    SessionStart: 'waiting',
    UserPromptSubmit: 'working',
    PostToolUse: 'working',
    Stop: 'completed',
  };

  const eventTypeMap: Record<string, InspectorEventType> = {
    SessionStart: 'session_start',
    UserPromptSubmit: 'user_prompt',
    PostToolUse: 'tool_use',
    Stop: 'stop',
  };

  for (const [event, status] of Object.entries(ideEvents)) {
    const existing = cleaned[event] ?? [];
    const hooks: HookHandler[] = [{ type: 'command', command: statusCmd(event, status) }];
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
      hooks.push({ type: 'command', command: captureSessionIdCmd });
    }
    hooks.push({ type: 'command', command: captureEventCmd(event, eventTypeMap[event]) });
    existing.push({ matcher: '', hooks });
    cleaned[event] = existing;
  }

  // Inspector-only events
  const inspectorOnlyEvents: Record<string, InspectorEventType> = {
    PreToolUse: 'pre_tool_use',
  };

  for (const [event, eventType] of Object.entries(inspectorOnlyEvents)) {
    const existing = cleaned[event] ?? [];
    existing.push({
      matcher: '',
      hooks: [{ type: 'command', command: captureEventCmd(event, eventType) }],
    });
    cleaned[event] = existing;
  }

  const output = { ...raw, hooks: cleaned };
  fs.writeFileSync(HOOKS_JSON_PATH, `${JSON.stringify(output, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateCodexHooks(): SettingsValidationResult {
  if (!isCodexHooksFeatureEnabled()) {
    const hookDetails: Record<string, boolean> = Object.fromEntries(EXPECTED_HOOK_EVENTS.map(e => [e, false]));
    return { statusLine: 'finevibe', hooks: 'missing', hookDetails };
  }

  // Check hooks.json
  const raw = readJsonSafe(HOOKS_JSON_PATH);
  const existingHooks: HooksConfig = (raw?.hooks ?? {}) as HooksConfig;
  const hookDetails: Record<string, boolean> = Object.fromEntries(EXPECTED_HOOK_EVENTS.map(e => [e, false]));
  let found = 0;

  for (const event of EXPECTED_HOOK_EVENTS) {
    const matchers = existingHooks[event];
    const installed = matchers?.some(m => m.hooks?.some(h => isIdeHook(h, CODEX_HOOK_MARKER))) ?? false;
    hookDetails[event] = installed;
    if (installed) found++;
  }

  let hooks: SettingsValidationResult['hooks'] = 'missing';
  if (found === EXPECTED_HOOK_EVENTS.length) {
    hooks = 'complete';
  } else if (found > 0) {
    hooks = 'partial';
  }

  return { statusLine: 'finevibe', hooks, hookDetails };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanupCodexHooks(): void {
  // Strip the feature flag first: it lives in config.toml and must be
  // removed even when hooks.json is already gone (P2-61).
  removeCodexHooksFeatureFlag();

  const raw = readJsonSafe(HOOKS_JSON_PATH);
  if (!raw) return;

  const config = raw as Record<string, unknown>;
  const existingHooks: HooksConfig = (config.hooks ?? {}) as HooksConfig;
  const cleaned = cleanHooks(existingHooks, CODEX_HOOK_MARKER);

  if (Object.keys(cleaned).length === 0) {
    delete config.hooks;
  } else {
    config.hooks = cleaned;
  }

  fs.writeFileSync(HOOKS_JSON_PATH, `${JSON.stringify(config, null, 2)}\n`);
}
