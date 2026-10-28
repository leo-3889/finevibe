'use strict';
// F3 Pi session scan-tick harness (docs/performance.md F3: Pi/OMP watcher
// scan cost in the running app unmeasured). Plain node: builds a fixture
// userData tree with 200 pi session dirs (per-launch dirs under
// <userData>/pi-sessions, filenames <ISO ts ':' '.'->'-'>_<uuid>.jsonl per
// src/main/pi-compatible-session-watcher.ts:95-110), spawns the BUILT app
// with --user-data-dir pointed at the fixture, samples tree RSS, and times
// a filesystem-side replica of one scan tick over the 200 dirs.
//
// Run: node dev/perf/f3-pi-tick.js [--quick] [--sessions=N] [--reps=M] [--out DIR]
//
// METRIC pi_tick_p50_ms  METRIC rss_mb  METRIC pi_session_dirs
// NOTE (honest limits, see dev/perf/README.md): the in-app scan tick is
// registration-gated (scanForNewSessions early-returns with 0 watched
// sessions, pi-compatible-session-watcher.ts:235; the 2 s poll at :392).
// Main-side tick wall-time is NOT externally observable (no sidecar is
// touched per tick; NTFS does not update last-access), so pi_tick_p50_ms is
// [estimated] from a filesystem-side replica of the tick's real syscalls:
// per-dir readdir + newest-file header read (open + 8 KiB + JSON.parse of
// the first line).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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
const USERDATA = path.join(SCRATCH, 'userdata');
const SESSIONS_BASE = path.join(USERDATA, 'pi-sessions');
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

const pad2 = (n) => String(n).padStart(2, '0');
/** Launch-style session dir: <ISO ts> with ':' and '.' rewritten as '-',
 *  plus a uuid; one transcript file inside. */
function writeSessionDir(i, d = new Date()) {
  const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}-${pad2(d.getMilliseconds())}Z`;
  const dir = path.join(SESSIONS_BASE, `session-${pad2(Math.floor(i / 100))}${pad2(i % 100)}`);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const lines = [JSON.stringify({ type: 'session', id, cwd: SCRATCH, version: 1 })];
  for (let k = 0; k < 15; k++) lines.push(JSON.stringify({ type: 'message', id, n: k, text: 'x'.repeat(200) }));
  fs.writeFileSync(path.join(dir, `${iso}_${id}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

function spawnApp() {
  const args = ['.', '--user-data-dir', USERDATA];
  if (process.env.CI) args.push('--no-sandbox');
  const child = spawn(electronBin(), args, {
    cwd: APP_ROOT,
    env: { ...process.env },
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
    return { rss_mb: Number(m[1]), procs: Number(m[2]) };
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
  return { rss_mb: sumKb / 1024, procs: count };
}

/** Filesystem-side replica of ONE full-sweep tick with N registered
 *  sessions: per session dir, readdirSync + header read (open + 8 KiB +
 *  JSON.parse first line) of the newest transcript — the syscalls
 *  refreshHistory + readSessionHeaderSync perform. */
function replicaTickOnce() {
  const t0 = process.hrtime.bigint();
  for (const d of fs.readdirSync(SESSIONS_BASE)) {
    const dir = path.join(SESSIONS_BASE, d);
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort().reverse();
    if (names.length === 0) continue;
    const fd = fs.openSync(path.join(dir, names[0]), 'r');
    try {
      const buf = Buffer.alloc(8192);
      const rd = fs.readSync(fd, buf, 0, 8192, 0);
      try { JSON.parse(buf.subarray(0, rd).toString('utf-8').split('\n', 1)[0]); } catch { /* header gate: unparseable head is skipped, like the app */ }
    } finally {
      fs.closeSync(fd);
    }
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
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
  const nSessions = argNum('--sessions', 200);
  const reps = argNum('--reps', quick ? 8 : 25);
  const warmupMs = quick ? 12_000 : 15_000;
  const rssSamples = quick ? 2 : 3;
  const rssInterval = 8_000;

  const t = Date.now() - 2 * 60 * 60_000;
  for (let i = 0; i < nSessions; i++) writeSessionDir(i, new Date(t + i * 30_000));
  console.log(`f3: fixture ${nSessions} pi session dirs under ${SESSIONS_BASE}; spawning app with --user-data-dir`);

  appChild = spawnApp();
  await sleep(warmupMs);
  const rss = [];
  for (let i = 0; i < rssSamples && appChild; i++) {
    const s = sampleTree();
    if (s) rss.push(s);
    await sleep(rssInterval);
  }
  killApp();

  // Replica ticks after teardown: the app is idle on the fixture, so the
  // FS cache is warm like it is for a registered-tab sweep.
  const tickMs = [];
  for (let i = 0; i < reps; i++) tickMs.push(replicaTickOnce());

  if (tickMs.length < 1) {
    console.error('FATAL: replica ticks unavailable.');
    process.exit(2);
  }
  if (rss.length < 1) console.log('NOTE f3: app window closed before RSS sampling; rss_mb omitted this run (window-closed/CI desktop limitation, not a fixture failure).');
  const dir = outDir();
  const csv = path.join(dir, 'f3-samples.csv');
  fs.writeFileSync(csv, 'phase,value\n'
    + rss.map((s, i) => `rss_mb,${s.rss_mb}`).join('\n') + '\n'
    + tickMs.map((ms, i) => `tick_replica_ms,${ms.toFixed(3)}`).join('\n') + '\n');
  const json = path.join(dir, 'f3-summary.json');
  fs.writeFileSync(json, JSON.stringify({ rss, tickMs, nSessions }, null, 2));
  console.log(`RESULTS_CSV=${csv}`);
  console.log(`RESULTS_JSON=${json}`);
  console.log(`METRIC pi_tick_p50_ms=${median(tickMs).toFixed(2)}`);
  if (rss.length > 0) console.log(`METRIC rss_mb=${median(rss.map((s) => s.rss_mb)).toFixed(3)}`);
  console.log(`METRIC pi_session_dirs=${nSessions}`);
  console.log('NOTE f3: [estimated] pi_tick_p50_ms is a filesystem-side replica of the scan tick (in-app tick is registration-gated, pi-compatible-session-watcher.ts:235/392, and main-side wall-time is not externally observable — no sidecar cadence exists to sample).');
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
