import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { STATUS_DIR } from './hook-status';
import { statusCmd as mkStatusCmd, captureSessionIdCmd as mkCaptureSessionIdCmd, installEventScript, wrapPythonHookCmd, installHookScripts } from './hook-commands';
import { readJsonSafe } from './fs-utils';
import { cleanHooks, isIdeHook, type HookHandler, type HooksConfig } from './hooks-utils';
import type { InspectorEventType, SettingsValidationResult } from '../shared/types';
import { pyLiteral } from '../shared/python';

export const GEMINI_HOOK_MARKER = '# finevibe-hook';

const GEMINI_DIR = path.join(homedir(), '.gemini');
const SETTINGS_PATH = path.join(GEMINI_DIR, 'settings.json');

export const SESSION_ID_VAR = 'FINEVIBE_SESSION_ID';

const EXPECTED_HOOK_EVENTS = ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent', 'SessionEnd'];

// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

export function installGeminiHooks(): void {
  fs.mkdirSync(GEMINI_DIR, { recursive: true });

  // A corrupt settings.json must never be collapsed to hooks-only JSON —
  // the write below would silently drop model, auth and every other user
  // setting. Leave the file untouched; validation reports hooks as not
  // installed, which is the honest state.
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      settings = {};
    } else {
      console.warn(`gemini: ${SETTINGS_PATH} is not valid JSON; hooks not installed over a corrupt config`);
      return;
    }
  }
  const existingHooks: HooksConfig = (settings.hooks ?? {}) as HooksConfig;
  const cleaned = cleanHooks(existingHooks, GEMINI_HOOK_MARKER);

  installHookScripts();

  const statusCmd = (event: string, status: string) =>
    mkStatusCmd(event, status, SESSION_ID_VAR, GEMINI_HOOK_MARKER);

  const captureEventCmd = (hookEvent: string, eventType: string) => {
    const pyCode = `import sys,json,os,time
try:
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
for fld in ("session_id","cwd"):
 v=d.get(fld,"")
 if v:
  e[fld]=v
status_dir=${pyLiteral(STATUS_DIR)}
with open(os.path.join(status_dir,sid+".events"),"a") as f:
 f.write(json.dumps(e)+"\\n")
`;
    const scriptName = `gemini_event_${hookEvent}.py`;
    installEventScript(scriptName, pyCode);
    return wrapPythonHookCmd(scriptName, pyCode, GEMINI_HOOK_MARKER);
  };

  const captureSessionIdCmd = mkCaptureSessionIdCmd(SESSION_ID_VAR, GEMINI_HOOK_MARKER);

  // Status-changing events
  const ideEvents: Record<string, string> = {
    SessionStart: 'waiting',
    BeforeAgent: 'working',
    AfterTool: 'working',
    AfterAgent: 'completed',
    SessionEnd: 'completed',
  };

  const eventTypeMap: Record<string, InspectorEventType> = {
    SessionStart: 'session_start',
    BeforeAgent: 'user_prompt',
    AfterTool: 'tool_use',
    AfterAgent: 'stop',
    SessionEnd: 'stop',
  };

  for (const [event, status] of Object.entries(ideEvents)) {
    const existing = cleaned[event] ?? [];
    const hooks: HookHandler[] = [
      { type: 'command', command: statusCmd(event, status), name: 'finevibe-status' },
    ];
    if (event === 'SessionStart' || event === 'BeforeAgent') {
      hooks.push({ type: 'command', command: captureSessionIdCmd, name: 'finevibe-sessionid' });
    }
    hooks.push({ type: 'command', command: captureEventCmd(event, eventTypeMap[event]), name: 'finevibe-events' });
    existing.push({ matcher: '', hooks });
    cleaned[event] = existing;
  }

  const output = { ...settings, hooks: cleaned };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(output, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateGeminiHooks(): SettingsValidationResult {
  const settings = readJsonSafe(SETTINGS_PATH);
  const existingHooks: HooksConfig = (settings?.hooks ?? {}) as HooksConfig;
  const hookDetails: Record<string, boolean> = Object.fromEntries(EXPECTED_HOOK_EVENTS.map(e => [e, false]));
  let found = 0;

  for (const event of EXPECTED_HOOK_EVENTS) {
    const matchers = existingHooks[event];
    const installed = matchers?.some(m => m.hooks?.some(h => isIdeHook(h, GEMINI_HOOK_MARKER))) ?? false;
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

export function cleanupGeminiHooks(): void {
  const settings = readJsonSafe(SETTINGS_PATH);
  if (!settings) return;

  const existingHooks: HooksConfig = (settings.hooks ?? {}) as HooksConfig;
  const cleaned = cleanHooks(existingHooks, GEMINI_HOOK_MARKER);

  if (Object.keys(cleaned).length === 0) {
    delete (settings as Record<string, unknown>).hooks;
  } else {
    (settings as Record<string, unknown>).hooks = cleaned;
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}
