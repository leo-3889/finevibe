'use strict';
// PO-06 watcher-cost harness (docs/performance.md PO-06: watcher RSS/handle
// cost in the RUNNING app has never been measured). Plain node: spawns the
// BUILT app with a throwaway --user-data-dir, samples total tree RSS + the
// main process Windows handle count.
//
// Run: node dev/perf/po06-watcher-cost.js [--quick] [--warmup=MS]
//      [--samples=N] [--interval=SEC] [--out DIR]
//
// METRIC rss_mb=<median>  METRIC watcher_handles=<median>  METRIC tree_procs
// NOTE PO-06: observational baseline only. The handle/RSS DELTA produced by
// registering projects requires in-app registration (renderer IPC, not
// reachable from an external harness) — second registered-projects run is a
// follow-up. Main-process event-loop lag is not externally reachable either
// (needs --inspect inside the app; deliberately not enabled here).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(APP_ROOT, 'dist', 'main', 'main', 'main.js');
if (!fs.existsSync(MAIN_ENTRY)) {
  console.error('FATAL: dist/main/main/main.js missing — run `npm run build` first; this harness spawns the compiled app, not sources.');
  process.exit(2);
}
function electronBin() {
  try {
    const p = require('electron');
    if (typeof p === 'string') return p;
  } catch { /* fall through */ }
  console.error('FATAL: electron dev dependency not resolvable — run `npm install` first.');
  process.exit(2);
}

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-bench-'));
const PS1 = path.join(SCRATCH, 'tree-rss.ps1');
let appChild = null;
function killApp() {
  const c = appChild;
  appChild = null;
  if (!c) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      c.kill('SIGTERM');
    }
  } catch { /* best effort */ }
}
const cleanupScratch = () => {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', () => { killApp(); cleanupScratch(); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killApp(); cleanupScratch(); process.exit(1); });

function spawnApp(extraEnv) {
  const userData = path.join(SCRATCH, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const args = ['.', '--user-data-dir', userData];
  if (process.env.CI) args.push('--no-sandbox');
  const child = spawn(electronBin(), args, {
    cwd: APP_ROOT,
    env: { ...process.env, ...(extraEnv || {}) },
    stdio: 'ignore',
  });
  child.on('exit', (code) => {
    if (appChild !== child) return; // harness-initiated kill, not an early exit
    console.error(`NOTE app process exited early (code=${code}); samples stop here.`);
    appChild = null;
  });
  return child;
}

fs.writeFileSync(PS1, [
  'param([int]$Root)',
  '$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,HandleCount',
  '$byId=@{}; $kids=@{}',
  'foreach($p in $procs){ $id=[int]$p.ProcessId; $byId[$id]=$p; $pp=[int]$p.ParentProcessId; if(-not $kids[$pp]){$kids[$pp]=@()}; $kids[$pp]+=$id }',
  '$queue=New-Object System.Collections.Generic.Queue[int]; $queue.Enqueue($Root)',
  '$sum=0; $count=0; $handles=-1',
  'while($queue.Count){ $id=$queue.Dequeue()',
  '  if($byId.ContainsKey($id)){ $sum+=[int64]$byId[$id].WorkingSetSize; $count++; if($id -eq $Root){ $handles=[int]$byId[$id].HandleCount } }',
  '  if($kids.ContainsKey($id)){ foreach($k in $kids[$id]){ $queue.Enqueue($k) } } }',
  "'{0}|{1}|{2}' -f [math]::Round($sum/1MB,3), $count, $handles",
].join('\n'));

function sampleTree() {
  if (!appChild) return null;
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Root', String(appChild.pid)],
      { encoding: 'utf8', timeout: 30000 });
    const line = (r.stdout || '').trim().split(/\r?\n/).pop();
    const m = /^([\d.]+)\|(\d+)\|(-?\d+)$/.exec(line || '');
    if (!m) return null;
    return { rss_mb: Number(m[1]), procs: Number(m[2]), handles: Number(m[3]) };
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const kids = new Map();
  const rows = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) });
    if (!kids.has(Number(m[2]))) kids.set(Number(m[2]), []);
    kids.get(Number(m[2])).push(Number(m[1]));
  }
  const queue = [appChild.pid];
  let sumKb = 0;
  let count = 0;
  while (queue.length) {
    const id = queue.pop();
    const row = rows.find((x) => x.pid === id);
    if (row) { sumKb += row.rss; count++; }
    for (const k of kids.get(id) || []) queue.push(k);
  }
  let handles = -1;
  if (process.platform === 'linux') {
    try { handles = fs.readdirSync(path.join('/proc', String(appChild.pid), 'fd')).length; } catch { /* n/a */ }
  }
  return { rss_mb: sumKb / 1024, procs: count, handles };
}

function argNum(flag, def) {
  const a = process.argv.find((s) => s.startsWith(flag + '='));
  return a ? Number(a.split('=')[1]) : def;
}
function outDir() {
  const i = process.argv.indexOf('--out');
  const out = i >= 0 ? process.argv[i + 1]
    : (process.argv.find((s) => s.startsWith('--out=')) || '').split('=')[1];
  const dir = out ? path.resolve(APP_ROOT, out) : path.join(SCRATCH, 'bench');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const quick = process.argv.includes('--quick');
  const warmupMs = argNum('--warmup', quick ? 15_000 : 30_000);
  const nSamples = argNum('--samples', quick ? 3 : 6);
  const intervalS = argNum('--interval', quick ? 5 : 10);

  console.log(`po06: spawning app; warmup ${warmupMs / 1000}s, then ${nSamples} samples @ ${intervalS}s`);
  appChild = spawnApp();
  await sleep(warmupMs);
  const samples = [];
  for (let i = 0; i < nSamples && appChild; i++) {
    const s = sampleTree();
    if (s) samples.push({ t_s: i * intervalS, ...s });
    await sleep(intervalS * 1000);
  }
  killApp();
  if (samples.length < 2) {
    console.error('FATAL: fewer than 2 samples — app likely failed to start (check Electron/CI desktop session).');
    process.exit(2);
  }
  const dir = outDir();
  const csv = path.join(dir, 'po06-samples.csv');
  fs.writeFileSync(csv, 't_s,rss_mb,procs,handles\n'
    + samples.map((s) => `${s.t_s},${s.rss_mb},${s.procs},${s.handles}`).join('\n') + '\n');
  const json = path.join(dir, 'po06-summary.json');
  fs.writeFileSync(json, JSON.stringify({ samples }, null, 2));
  console.log(`RESULTS_CSV=${csv}`);
  console.log(`RESULTS_JSON=${json}`);
  console.log(`METRIC rss_mb=${median(samples.map((s) => s.rss_mb)).toFixed(3)}`);
  console.log(`METRIC watcher_handles=${median(samples.map((s) => s.handles)).toFixed(0)}`);
  console.log(`METRIC tree_procs=${samples[samples.length - 1].procs}`);
  console.log('NOTE PO-06: observational no-project baseline; registered-projects handle delta + main-thread event-loop lag need an in-app (--inspect) run — see dev/perf/README.md.');
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
