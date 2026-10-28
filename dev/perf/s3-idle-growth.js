'use strict';
// S3 idle-growth harness (docs/performance.md scenario S3: 1 h idle,
// growth < 5 MB/h). Plain node: spawns the BUILT app (`electron .` with a
// throwaway --user-data-dir so real userData is never touched), samples the
// whole process tree's RSS, and reports the least-squares slope in MB/h.
//
// Run: node dev/perf/s3-idle-growth.js [--quick] [--minutes=N]
//      [--interval=SEC] [--fail-threshold] [--threshold=MB] [--out DIR]
//
// METRIC idle_growth_mb_per_h=<slope>  (+ rss_start_mb / rss_end_mb / sample_count)
// Exit: 0 on success; 1 only with --fail-threshold when slope > threshold
// (default 5 MB/h, the S3 bound); 2 when the built app is missing.
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

// A6 temp discipline: per-run mkdtemp scratch, removed on exit/SIGINT/SIGTERM.
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
  // macOS/Linux best-effort fallback (ps -o rss= semantics).
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const kids = new Map();
  let rootKb = 0;
  const rows = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, rss] = m;
    rows.push({ pid: Number(pid), ppid: Number(ppid), rss: Number(rss) });
    if (!kids.has(Number(ppid))) kids.set(Number(ppid), []);
    kids.get(Number(ppid)).push(Number(pid));
    if (Number(pid) === appChild.pid) rootKb = Number(rss);
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
  void rootKb;
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
function slopePerHour(samples) {
  const n = samples.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    const x = s.t_s / 3600;
    sx += x; sy += s.rss_mb; sxx += x * x; sxy += x * s.rss_mb;
  }
  const d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const quick = process.argv.includes('--quick');
  const minutes = argNum('--minutes', quick ? 5 : 15);
  const intervalS = argNum('--interval', quick ? 15 : 30);
  const threshold = argNum('--threshold', 5);
  const failOnThreshold = process.argv.includes('--fail-threshold');
  const warmupMs = 60_000; // startup allocation is not idle growth (S3 = steady idle)

  console.log(`s3: spawning app; warmup ${warmupMs / 1000}s, then ${minutes} min @ ${intervalS}s`);
  appChild = spawnApp();
  await sleep(warmupMs);
  const t0 = Date.now();
  const samples = [];
  while (Date.now() - t0 < minutes * 60_000 && appChild) {
    const s = sampleTree();
    if (s) samples.push({ t_s: Math.round((Date.now() - t0) / 1000), ...s });
    await sleep(intervalS * 1000);
  }
  killApp();
  if (samples.length < 2) {
    console.error('FATAL: fewer than 2 RSS samples — app likely failed to start (check Electron/CI desktop session).');
    process.exit(2);
  }
  const slope = slopePerHour(samples);
  const dir = outDir();
  const csv = path.join(dir, 's3-samples.csv');
  fs.writeFileSync(csv, 't_s,rss_mb,procs\n' + samples.map((s) => `${s.t_s},${s.rss_mb},${s.procs}`).join('\n') + '\n');
  const json = path.join(dir, 's3-summary.json');
  fs.writeFileSync(json, JSON.stringify({ slope, threshold, samples }, null, 2));
  console.log(`RESULTS_CSV=${csv}`);
  console.log(`RESULTS_JSON=${json}`);
  console.log(`METRIC idle_growth_mb_per_h=${slope.toFixed(3)}`);
  console.log(`METRIC rss_start_mb=${samples[0].rss_mb.toFixed(3)}`);
  console.log(`METRIC rss_end_mb=${samples[samples.length - 1].rss_mb.toFixed(3)}`);
  console.log(`METRIC sample_count=${samples.length}`);
  console.log(`s3: S3 bound is < ${threshold} MB/h (docs/performance.md); --fail-threshold ${failOnThreshold ? 'ON' : 'OFF (CI default: signal, not gate)'}`);
  if (failOnThreshold && slope > threshold) {
    console.error(`s3: FAIL slope ${slope.toFixed(3)} MB/h > ${threshold}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
