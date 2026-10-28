'use strict';
// F2 Codex watcher spike harness (docs/performance.md F2: codex rollout
// scan cost — decompression peaks, scan wall-time — has never been measured
// in the running app). Plain node: builds a fixture `~/.codex/sessions`
// tree (rollout-<ts>-<id>.jsonl[.zst], session_meta first line per
// src/main/codex-session-watcher.ts), spawns the BUILT app with HOME and
// USERPROFILE redirected into the scratch fixture (os.homedir() reads
// USERPROFILE on Windows, HOME on POSIX) so the watcher arms on the fixture,
// then samples tree RSS across 10 poll cycles while new rollouts land.
//
// Run: node dev/perf/f2-codex-spike.js [--quick] [--cycles=N] [--out DIR]
//
// METRIC codex_spike_mb=<peak-baseline>  METRIC codex_scan_replica_p50_ms
// METRIC rollouts_total  (+ rss_peak_mb)
// NOTE (honest limits, see dev/perf/README.md):
//  - In-app scans are gated on a pending Codex tab (scanRollouts early-
//    returns at codex-session-watcher.ts:275; the 2 s poll at :514). An
//    external harness cannot register a tab, so the app-side RSS spike is a
//    LOWER bound: the watcher arms its fs.watch handle on the fixture and
//    receives events, while the scan body stays idle.
//  - codex_scan_replica_p50_ms is a filesystem-side replica of one scan
//    (name-pruned newest-first tree walk + 64 KB session_meta head read per
//    rollout) timed in plain node — labelled [estimated]; it is what one
//    scan tick costs, not what the app measured.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
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

const HOME_FIXTURE = path.join(SCRATCH, 'home');
const SESSIONS_ROOT = path.join(HOME_FIXTURE, '.codex', 'sessions');
const PROJ_FIXTURE = path.join(SCRATCH, 'proj');
const pad2 = (n) => String(n).padStart(2, '0');
function todayParts(d = new Date()) {
  return [String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate())];
}
function dayDir(d = new Date()) {
  const [y, m, dd] = todayParts(d);
  return path.join(SESSIONS_ROOT, y, m, dd);
}
function tsSegment(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}
/** One rollout: session_meta first line (type/payload.id/payload.cwd per
 *  parseMetaLine), a few payload lines, ~4 KB so head reads are real. */
function writeRollout(d = new Date(), compressed = false) {
  const dir = dayDir(d);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const lines = [JSON.stringify({ type: 'session_meta', payload: { id, cwd: PROJ_FIXTURE, timestamp: d.toISOString() } })];
  for (let i = 0; i < 24; i++) lines.push(JSON.stringify({ type: 'event', payload: { kind: 'exec', text: 'x'.repeat(120), n: i } }));
  const base = path.join(dir, `rollout-${tsSegment(d)}-${id}.jsonl`);
  const text = lines.join('\n') + '\n';
  if (compressed && typeof zlib.zstdCompressSync === 'function') {
    fs.writeFileSync(base + '.zst', zlib.zstdCompressSync(Buffer.from(text, 'utf-8')));
    return base + '.zst';
  }
  fs.writeFileSync(base, text, 'utf-8');
  return base;
}

function spawnApp() {
  fs.mkdirSync(HOME_FIXTURE, { recursive: true });
  fs.mkdirSync(PROJ_FIXTURE, { recursive: true });
  const userData = path.join(SCRATCH, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const args = ['.', '--user-data-dir', userData];
  if (process.env.CI) args.push('--no-sandbox');
  const child = spawn(electronBin(), args, {
    cwd: APP_ROOT,
    env: { ...process.env, HOME: HOME_FIXTURE, USERPROFILE: HOME_FIXTURE },
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

/** Filesystem-side replica of ONE scanRollouts() tick (pending=1, today):
 *  newest-first YYYY/MM/DD walk pruned by name to >= minDate, then per
 *  rollout readHead(64 KB) + JSON.parse of the session_meta line — the exact
 *  meta path in codex-session-watcher.ts (readSessionMeta/parseMetaLine). */
function replicaScanOnce(minDateParts) {
  const t0 = process.hrtime.bigint();
  const [minY, minM, minD] = minDateParts;
  let metas = 0;
  for (const y of fs.readdirSync(SESSIONS_ROOT).sort().reverse()) {
    if (y < minY) continue;
    const yDir = path.join(SESSIONS_ROOT, y);
    for (const m of fs.readdirSync(yDir).sort().reverse()) {
      if (y === minY && m < minM) continue;
      const mDir = path.join(yDir, m);
      for (const d of fs.readdirSync(mDir).sort().reverse()) {
        if (y === minY && m === minM && d < minD) continue;
        const dDir = path.join(mDir, d);
        for (const f of fs.readdirSync(dDir).sort()) {
          const full = path.join(dDir, f);
          const base = f.endsWith('.zst') ? f.slice(0, -4) : f;
          if (!base.startsWith('rollout-') || !base.endsWith('.jsonl')) continue;
          const buf = Buffer.alloc(64 * 1024);
          const fd = fs.openSync(full, 'r');
          let text;
          try {
            text = buf.subarray(0, fs.readSync(fd, buf, 0, 64 * 1024, 0)).toString('utf-8');
          } finally {
            fs.closeSync(fd);
          }
          if (f.endsWith('.zst') && typeof zlib.zstdDecompressSync === 'function') {
            try { text = zlib.zstdDecompressSync(fs.readFileSync(full)).toString('utf-8'); } catch { /* mid-frame */ }
          }
          const first = text.split('\n', 1)[0];
          try { JSON.parse(first); metas++; } catch { /* unparseable meta */ }
        }
      }
    }
  }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, metas };
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
function p50(values) { return median(values); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const quick = process.argv.includes('--quick');
  const cycles = argNum('--cycles', quick ? 4 : 10);
  const warmupMs = quick ? 12_000 : 20_000;

  // Fixture: 10 seeded rollouts today (2 as .jsonl.zst when zstd is
  // available — Node >= 23.8), mimicking the real layout 1:1.
  fs.mkdirSync(PROJ_FIXTURE, { recursive: true });
  const seeded = [];
  const t = Date.now() - 60 * 60_000;
  for (let i = 0; i < 10; i++) seeded.push(writeRollout(new Date(t + i * 60_000), i >= 8));
  console.log(`f2: fixture ${seeded.length} rollouts (2 .zst=${typeof zlib.zstdCompressSync === 'function'}); spawning app with HOME/USERPROFILE -> ${HOME_FIXTURE}`);

  appChild = spawnApp();
  await sleep(warmupMs);
  const baselineSamples = [];
  for (let i = 0; i < 3 && appChild; i++) {
    const s = sampleTree();
    if (s) baselineSamples.push(s);
    await sleep(5000);
  }
  const baseline = median(baselineSamples.map((s) => s.rss_mb));

  const cycleSamples = [];
  let landed = 0;
  for (let c = 0; c < cycles && appChild; c++) {
    writeRollout(); // lands a new rollout -> fs.watch event in the app
    landed++;
    await sleep(2500); // 2 s poll cadence + margin
    const s = sampleTree();
    if (s) cycleSamples.push({ cycle: c + 1, ...s });
  }
  killApp();
  const appMeasured = baselineSamples.length >= 2 && cycleSamples.length >= 1;
  if (!appMeasured) console.log('NOTE f2: app window closed before RSS phases; codex_spike_mb/rss_peak_mb omitted this run (window-closed/CI desktop limitation, not a fixture failure).');

  // Replica ticks after teardown: 10 timed scans over the grown fixture.
  const reps = quick ? 5 : 10;
  const repMs = [];
  for (let i = 0; i < reps; i++) repMs.push(replicaScanOnce(todayParts(new Date(t))).ms);

  const peak = cycleSamples.length ? Math.max(...cycleSamples.map((s) => s.rss_mb)) : 0;
  const total = seeded.length + landed;
  const dir = outDir();
  const csv = path.join(dir, 'f2-samples.csv');
  fs.writeFileSync(csv, 'phase,t_s,rss_mb\n'
    + baselineSamples.map((s, i) => `baseline,${i * 5},${s.rss_mb}`).join('\n') + '\n'
    + cycleSamples.map((s) => `cycle,${s.cycle},${s.rss_mb}`).join('\n') + '\n');
  const json = path.join(dir, 'f2-summary.json');
  fs.writeFileSync(json, JSON.stringify({ baseline, peak, replicaMs: repMs }, null, 2));
  console.log(`RESULTS_CSV=${csv}`);
  console.log(`RESULTS_JSON=${json}`);
  if (appMeasured) {
    console.log(`METRIC codex_spike_mb=${(peak - baseline).toFixed(3)}`);
    console.log(`METRIC rss_peak_mb=${peak.toFixed(3)}`);
  }
  console.log(`METRIC codex_scan_replica_p50_ms=${p50(repMs).toFixed(2)}`);
  console.log(`METRIC rollouts_total=${total}`);
  console.log('NOTE f2: [estimated] scan cost is the filesystem-side replica (app scans are gated on a pending Codex tab, codex-session-watcher.ts:275/514 — not reachable from an external harness); codex_spike_mb is a lower bound with 0 pending tabs.');
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
