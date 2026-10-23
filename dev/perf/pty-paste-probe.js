// P0 PTY paste probe (plan §7 P0-4). Plain node + node-pty, no Electron.
// Leg A: ConPTY per-byte records — child = byte echo, write \x1b[200~ + N + \x1b[201~,
//        measure write-returns ms, drain ms, chunk count/sizes, bytes in vs out.
// Leg B: omp child under pty — write→first chunk, write→chunk containing marker.
'use strict';
const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// A6 temp discipline: every scratch artifact lives in a per-run mkdtemp dir,
// removed on exit and on SIGINT/SIGTERM. Results stay in the scratch dir and
// are printed as an absolute path, never committed into the repo.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-bench-'));
const cleanupScratch = () => {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanupScratch);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanupScratch(); process.exit(1); });
const ECHO_JS = path.join(SCRATCH, 'echo.js');
fs.writeFileSync(ECHO_JS, "process.stdin.pipe(process.stdout);\n");
const SHELL = process.env.COMSPEC || 'bash.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

function makePayload(n, markerFn) {
  // 'a'-filled with a unique tail marker every 4KB so drain can be verified.
  const parts = [];
  let sent = 0;
  let i = 0;
  while (sent < n) {
    const take = Math.min(4096, n - sent);
    sent += take;
    i++;
    const marker = markerFn(i);
    parts.push('a'.repeat(Math.max(0, take - marker.length)) + marker);
  }
  const body = parts.join('').slice(0, n);
  return body;
}

async function legA() {
  console.log('\n=== Leg A: ConPTY byte-echo drain (node-pty ' + require('node-pty/package.json').version + ') ===');
  console.log('shell=' + SHELL + ' echo=' + ECHO_JS);
  const rows = [];
  for (const n of [1024, 10240, 102400, 1048576]) {
    const row = { n, status: 'timeout', writeMs: -1, drainMs: -1, chunks: 0, minChunk: 0, medChunk: 0, maxChunk: 0, bytesIn: 0, bytesSent: 0 };
    const term = pty.spawn(SHELL, [], { name: 'xterm-256color', cols: 120, rows: 30, cwd: SCRATCH, env: process.env });
    try {
      const payload = makePayload(n, (i) => 'MK' + String(i).padStart(4, '0') + 'TAIL');
      const frames = '\x1b[200~' + payload + '\x1b[201~';
      row.bytesSent = Buffer.byteLength(frames);
      const t0 = process.hrtime.bigint();
      const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
      let echoReady = false;
      let pasteAt = -1;
      let firstAt = -1;
      let lastAt = -1;
      let bytes = 0;
      const sizes = [];
      term.onData((d) => {
        const t = now();
        if (pasteAt < 0) {
          // Pre-paste stream: shell banner + echo program start. Watch for the
          // marker tail echoed back means the echo child is live once we paste.
          if (/MK0001TAIL|MK0000TAIL/.test(d)) echoReady = true;
          return;
        }
        const b = Buffer.byteLength(d);
        if (firstAt < 0) firstAt = t;
        bytes += b;
        sizes.push(b);
        lastAt = t;
      });
      term.write('node "' + ECHO_JS + '"\r');
      // Settle: 2.5s for the shell to launch node and enter pipe mode.
      const settleEnd = Date.now() + 2500;
      while (Date.now() < settleEnd) await sleep(100);
      const tw = process.hrtime.bigint();
      term.write(frames);
      row.writeMs = +((Number(process.hrtime.bigint() - tw) / 1e6).toFixed(2));
      pasteAt = now();
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        if (bytes >= row.bytesSent) break;
        await sleep(25);
      }
      row.chunks = sizes.length;
      row.bytesIn = bytes;
      row.minChunk = sizes.length ? Math.min(...sizes) : 0;
      row.medChunk = median(sizes);
      row.maxChunk = sizes.length ? Math.max(...sizes) : 0;
      row.drainMs = +(lastAt - firstAt).toFixed(1);
      row.status = bytes >= row.bytesSent ? 'complete' : 'partial';
      void echoReady;
    } catch (e) {
      row.status = 'error: ' + e.message;
    } finally {
      try { term.kill(); } catch {}
    }
    rows.push(row);
    console.log('legA row ' + JSON.stringify(row));
    await sleep(300);
  }
  return rows;
}

async function legB() {
  console.log('\n=== Leg B: omp child under pty (R3) ===');
  const where = spawnSync('where', ['omp'], { encoding: 'utf8', shell: true });
  const ompPath = ((where.stdout || '').split(/\r?\n/).find((l) => l.trim()) || 'C:\\Users\\Alex\\.bun\\bin\\omp.exe').trim();
  console.log('omp=' + ompPath);
  const rows = [];
  for (const n of [1024, 10240]) {
    const row = { n, status: 'timeout', firstFrameMs: -1, writeToFirstChunkMs: -1, writeToMarkerMs: -1, chunksAfterPaste: 0 };
    const term = pty.spawn(ompPath, [], { name: 'xterm-256color', cols: 120, rows: 30, cwd: SCRATCH, env: process.env });
    try {
      const marker = 'ZQ' + n + 'MK';
      const payload = makePayload(n, (i) => marker + i + 'END');
      const frames = '\x1b[200~' + payload + '\x1b[201~';
      const t0 = process.hrtime.bigint();
      const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
      let firstFrameAt = -1;
      let pasteAt = -1;
      let firstChunkAt = -1;
      let markerAt = -1;
      let chunks = 0;
      term.onData((d) => {
        const t = now();
        if (firstFrameAt < 0) firstFrameAt = t;
        if (pasteAt >= 0) {
          chunks++;
          if (firstChunkAt < 0) firstChunkAt = t;
          if (markerAt < 0 && d.includes(marker)) markerAt = t;
        }
      });
      await sleep(3000); // settle: first frame + UI init
      row.firstFrameMs = +firstFrameAt.toFixed(1);
      pasteAt = now();
      term.write(frames);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (markerAt >= 0) break;
        await sleep(100);
      }
      row.writeToFirstChunkMs = firstChunkAt >= 0 ? +(firstChunkAt - pasteAt).toFixed(1) : -1;
      row.writeToMarkerMs = markerAt >= 0 ? +(markerAt - pasteAt).toFixed(1) : -1;
      row.chunksAfterPaste = chunks;
      row.status = markerAt >= 0 ? 'ok' : firstChunkAt >= 0 ? 'first-chunk-no-marker' : 'timeout';
    } catch (e) {
      row.status = 'error: ' + e.message;
    } finally {
      try { term.kill(); } catch {}
    }
    rows.push(row);
    console.log('legB row ' + JSON.stringify(row));
    await sleep(300);
  }
  return rows;
}

(async () => {
  const a = await legA().catch((e) => { console.log('Leg A fatal: ' + e.message); return []; });
  const b = await legB().catch((e) => { console.log('Leg B fatal: ' + e.message); return []; });
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\nLeg A table:');
  console.log(pad('N', 9) + pad('write ms', 10) + pad('drain ms', 10) + pad('chunks', 8) + pad('min', 7) + pad('med', 8) + pad('max', 8) + pad('in', 10) + pad('sent', 10) + 'status');
  for (const r of a) console.log(pad(r.n, 9) + pad(r.writeMs, 10) + pad(r.drainMs, 10) + pad(r.chunks, 8) + pad(r.minChunk, 7) + pad(r.medChunk, 8) + pad(r.maxChunk, 8) + pad(r.bytesIn, 10) + pad(r.bytesSent, 10) + r.status);
  console.log('\nLeg B table:');
  console.log(pad('N', 8) + pad('status', 24) + pad('first frame', 13) + pad('write→1st', 11) + pad('write→marker', 14) + 'chunks');
  for (const r of b) console.log(pad(r.n, 8) + pad(r.status, 24) + pad(r.firstFrameMs, 13) + pad(r.writeToFirstChunkMs, 11) + pad(r.writeToMarkerMs, 14) + r.chunksAfterPaste);
  const out = path.join(SCRATCH, 'results.json');
  fs.writeFileSync(out, JSON.stringify({ shell: SHELL, omp: ompPathForJson(), node: process.version, nodePty: require('node-pty/package.json').version, legA: a, legB: b }, null, 2));
  console.log('\nPTY_PROBE_JSON=' + out);
  process.exit(0);
})();

function ompPathForJson() {
  try {
    const w = spawnSync('where', ['omp'], { encoding: 'utf8', shell: true });
    return ((w.stdout || '').split(/\r?\n/).find((l) => l.trim()) || '').trim();
  } catch { return ''; }
}
