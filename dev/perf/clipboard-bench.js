// P0 clipboard measurement harness (todos/clipboard-paste-latency-plan.md §7 P0-1).
// Electron main + hidden window; times every clipboard:readForPaste sub-op
// (src/main/ipc-handlers.ts:833-853) per scenario, p50/max over >=11 passes.
// Run: npx electron dev/perf/clipboard-bench.js [--smoke]
'use strict';
const { app, BrowserWindow, clipboard, nativeImage } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = os.tmpdir();
const PS = process.platform === 'win32' ? 'powershell.exe' : 'powershell';
const PASSES = 11;
const RESULTS_JSON = path.join(TMP, 'clipbench-results.json');
const PASTE_DIR = path.join(TMP, 'vibeyard-paste');
const FILES_DIR = path.join(TMP, 'clipbench-files');
const HTML_FILE = path.join(TMP, 'clipbench-rich.html');

if (process.argv.includes('--smoke')) {
  console.log('clipboard-bench smoke');
  console.log(JSON.stringify(process.versions, null, 2));
  console.log('electron=' + process.versions.electron);
  app.exit(0);
} else {
  app.disableHardwareAcceleration();
  app
    .whenReady()
    .then(main)
    .catch((err) => {
      console.error('clipboard-bench failed:', err);
      app.exit(1);
    });
}

function runPs(script, timeoutMs = 120000) {
  const file = path.join(TMP, 'clipbench-setup.ps1');
  fs.writeFileSync(file, script, 'utf8');
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error('ps setup failed status=' + r.status + ' err=' + (r.stderr || '').slice(0, 400));
  }
  return (r.stdout || '').trim();
}

const CLIP_PSH = `
Add-Type -Namespace W -Name U32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(System.IntPtr hWndNewOwner);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool CloseClipboard();
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool EmptyClipboard();
'@
if (-not [W.U32]::OpenClipboard([IntPtr]::Zero)) { throw ("OpenClipboard failed win32=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
[void][W.U32]::EmptyClipboard()
[void][W.U32]::CloseClipboard()
`;

// Raw Win32 clipboard write (GlobalAlloc + SetClipboardData, owner=NULL): the
// data survives the setup process exiting, unlike WinForms delayed rendering.
const RAW_CLIP = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RawClip {
  [DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EmptyClipboard();
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetClipboardData(uint fmt, IntPtr hMem);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseClipboard();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint RegisterClipboardFormatW(string name);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
  public static bool Set(string fmtName, byte[] data) {
    uint fmt = fmtName == "CF_HDROP" ? 15u : RegisterClipboardFormatW(fmtName);
    if (fmt == 0) throw new Exception("register failed " + fmtName);
    if (!OpenClipboard(IntPtr.Zero)) throw new Exception("open " + Marshal.GetLastWin32Error());
    EmptyClipboard();
    IntPtr h = GlobalAlloc(0x42, (UIntPtr)data.Length);
    IntPtr p = GlobalLock(h);
    Marshal.Copy(data, 0, p, data.Length);
    GlobalUnlock(h);
    if (SetClipboardData(fmt, h) == IntPtr.Zero) { CloseClipboard(); throw new Exception("setdata " + Marshal.GetLastWin32Error()); }
    return CloseClipboard();
  }
  public static bool Set2(string f1, byte[] d1, string f2, byte[] d2) {
    uint fmt1 = f1 == "CF_HDROP" ? 15u : RegisterClipboardFormatW(f1);
    uint fmt2 = f2 == "CF_HDROP" ? 15u : RegisterClipboardFormatW(f2);
    if (fmt1 == 0 || fmt2 == 0) throw new Exception("register failed");
    if (!OpenClipboard(IntPtr.Zero)) throw new Exception("open " + Marshal.GetLastWin32Error());
    EmptyClipboard();
    IntPtr h1 = GlobalAlloc(0x42, (UIntPtr)d1.Length);
    Marshal.Copy(d1, 0, GlobalLock(h1), d1.Length); GlobalUnlock(h1);
    if (SetClipboardData(fmt1, h1) == IntPtr.Zero) { CloseClipboard(); throw new Exception("setdata1 " + Marshal.GetLastWin32Error()); }
    IntPtr h2 = GlobalAlloc(0x42, (UIntPtr)d2.Length);
    Marshal.Copy(d2, 0, GlobalLock(h2), d2.Length); GlobalUnlock(h2);
    if (SetClipboardData(fmt2, h2) == IntPtr.Zero) { CloseClipboard(); throw new Exception("setdata2 " + Marshal.GetLastWin32Error()); }
    return CloseClipboard();
  }
}
'@
`;

function makeImages() {
  runPs(`
Add-Type -AssemblyName System.Drawing
foreach ($spec in @(@(1920,1080), @(2560,1440))) {
  $w = $spec[0]; $h = $spec[1]
  $out = Join-Path $env:TEMP ("clipbench-img-" + $w + "x" + $h + ".png")
  if (-not (Test-Path $out)) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 8, 40, 120), [System.Drawing.Color]::FromArgb(255, 250, 160, 40), 45)
    $g.FillRectangle($brush, $rect)
    for ($i = 0; $i -lt 60; $i++) {
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, ($i * 4) % 255, ($i * 9) % 255, ($i * 13) % 255), 3)
      $g.DrawLine($pen, ($i * 37) % $w, 0, ($i * 91) % $w, $h)
      $pen.Dispose()
    }
    $g.Dispose()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
  Write-Output $out
}
`);
}

function setup(scenario) {
  switch (scenario) {
    case 'empty':
      return runPs(CLIP_PSH);
    case 'text-40B':
      return runPs(CLIP_PSH + "\nSet-Clipboard -Value ('P0-clipboard-bench-' + ('x' * 22))");
    case 'text-100KB':
      return runPs(CLIP_PSH + "\nSet-Clipboard -Value ('0123456789abcdef' * 6400)");
    case 'text-1MB':
      return runPs(CLIP_PSH + "\nSet-Clipboard -Value (('lorem ipsum dolor sit amet ' * 39000) + 'END')");
    case 'file-list': {
      fs.mkdirSync(FILES_DIR, { recursive: true });
      const files = [];
      for (let i = 1; i <= 3; i++) {
        const f = path.join(FILES_DIR, 'clipbench-file-' + i + '.txt');
        fs.writeFileSync(f, 'clipbench file ' + i + '\n');
        files.push(f);
      }
      return runPs(
        RAW_CLIP + '\n' +
          '$names = @(' + files.map((f) => "'" + f.replace(/'/g, "''") + "'").join(',') + ')\n' +
          '$joined = ($names -join "`0") + "`0`0"\n' +
          '$nameBytes = [System.Text.Encoding]::Unicode.GetBytes($joined)\n' +
          '$hdr = [byte[]](20,0,0,0, 0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0)\n' +
          '$bytes = New-Object byte[] ($hdr.Length + $nameBytes.Length)\n' +
          '[Array]::Copy($hdr, 0, $bytes, 0, $hdr.Length)\n' +
          '[Array]::Copy($nameBytes, 0, $bytes, $hdr.Length, $nameBytes.Length)\n' +
          '[void][RawClip]::Set2("CF_HDROP", $bytes, "FileNameW", $nameBytes)\n',
      );
    }
    case 'rich-html': {
      const rows = Array.from({ length: 40 }, (_, i) => '<tr><td>row ' + i + '</td><td>value ' + i + '</td></tr>').join('\n');
      fs.writeFileSync(
        HTML_FILE,
        '<h1>P0 clipboard bench</h1><table border="1">\n' + rows + '\n</table><p>rich html scenario ' + 'lorem ipsum '.repeat(200) + '</p>',
        'utf8',
      );
      return runPs(
        RAW_CLIP + '\n' +
          "$html = Get-Content -Raw -LiteralPath '" + HTML_FILE.replace(/'/g, "''") + "'\n" +
          '$enc = New-Object System.Text.UTF8Encoding($false)\n' +
          '$pre = "<html><body><!--StartFragment-->"\n' +
          '$post = "<!--EndFragment--></body></html>"\n' +
          '$full = $pre + $html + $post\n' +
          '$hdrLen = 98\n' +
          '$startF = $hdrLen + $enc.GetByteCount($pre)\n' +
          '$endF = $startF + $enc.GetByteCount($html)\n' +
          '$endH = $hdrLen + $enc.GetByteCount($full)\n' +
          '$hdr = "Version:0.9`r`nStartHTML:{0:D8}`r`nEndHTML:{1:D8}`r`nStartFragment:{2:D8}`r`nEndFragment:{3:D8}`r`n" -f $hdrLen, $endH, $startF, $endF\n' +
          '$blob = $hdr + $full\n' +
          '[void][RawClip]::Set("HTML Format", $enc.GetBytes($blob))\n',
      );
    }
    case 'image-1080p':
    case 'image-1440p': {
      const dim = scenario === 'image-1080p' ? [1920, 1080] : [2560, 1440];
      return runPs(
        CLIP_PSH +
          "\nAdd-Type -AssemblyName System.Drawing\nAdd-Type -AssemblyName System.Windows.Forms\n" +
          "$png = Join-Path $env:TEMP 'clipbench-img-" + dim[0] + 'x' + dim[1] + ".png'\n" +
          '$img = [System.Drawing.Image]::FromFile($png)\n' +
          '[System.Windows.Forms.Clipboard]::SetImage($img)\n' +
          '$img.Dispose()\n' +
          '[System.Windows.Forms.Clipboard]::Flush()\n',
      );
    }
    default:
      throw new Error('unknown scenario ' + scenario);
  }
}

const SCENARIOS = ['empty', 'text-40B', 'text-100KB', 'text-1MB', 'rich-html', 'file-list', 'image-1080p', 'image-1440p'];
const SUB_OPS = ['availableFormats', 'readText', 'readBuffer:FileNameW', 'readBuffer:CF_HDROP', 'readBuffer:NSFilenamesPboardType', 'read:text/uri-list', 'readImage', 'toPNG', 'writePastedFile', 'readHTML', 'handler-total'];

function med(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function max(arr) {
  return arr.length ? Math.max(...arr) : 0;
}

async function onePass() {
  const t = {};
  let t0 = process.hrtime.bigint();
  const mark = (name, from) => {
    const now = process.hrtime.bigint();
    t[name] = Number(now - from) / 1e6;
    return now;
  };
  const formats = clipboard.availableFormats();
  t0 = mark('availableFormats', t0);
  const text = clipboard.readText();
  t0 = mark('readText', t0);
  const paths = [];
  try {
    const b = clipboard.readBuffer('FileNameW');
    t0 = mark('readBuffer:FileNameW', t0);
    for (const n of b.toString('utf16le').split('\0')) if (n) paths.push(n);
  } catch {
    t0 = mark('readBuffer:FileNameW', t0);
  }
  try {
    const b = clipboard.readBuffer('CF_HDROP');
    t0 = mark('readBuffer:CF_HDROP', t0);
    if (b.length >= 16 && paths.length === 0) {
      const off = b.readUInt32LE(0);
      const wide = b.readUInt32LE(12) !== 0;
      const body = b.subarray(Math.min(off, b.length));
      for (const n of (wide ? body.toString('utf16le') : body.toString('latin1')).split('\0')) if (n) paths.push(n);
    }
  } catch {
    t0 = mark('readBuffer:CF_HDROP', t0);
  }
  try {
    clipboard.readBuffer('NSFilenamesPboardType');
    t0 = mark('readBuffer:NSFilenamesPboardType', t0);
  } catch {
    t0 = mark('readBuffer:NSFilenamesPboardType', t0);
  }
  try {
    clipboard.read('text/uri-list');
    t0 = mark('read:text/uri-list', t0);
  } catch {
    t0 = mark('read:text/uri-list', t0);
  }
  let imagePath = null;
  const hasImage = formats.some((f) => f.toLowerCase().startsWith('image/'));
  if (paths.length === 0 && hasImage) {
    try {
      const image = clipboard.readImage();
      t0 = mark('readImage', t0);
      if (!image.isEmpty()) {
        const png = image.toPNG();
        t0 = mark('toPNG', t0);
        fs.mkdirSync(PASTE_DIR, { recursive: true });
        const fp = path.join(PASTE_DIR, 'paste-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10) + '.png');
        await fs.promises.writeFile(fp, png);
        t0 = mark('writePastedFile', t0);
        imagePath = fp;
      }
    } catch {
      /* mirror handler: image read failures are swallowed */
    }
  }
  const html = text.trim() === '' ? clipboard.readHTML().trim() : '';
  mark('readHTML', t0);
  const total = (t.availableFormats + t.readText + (t['readBuffer:FileNameW'] || 0) +
    (t['readBuffer:CF_HDROP'] || 0) + (t['readBuffer:NSFilenamesPboardType'] || 0) +
    (t['read:text/uri-list'] || 0) + (t.readImage || 0) + (t.toPNG || 0) +
    (t.writePastedFile || 0) + (t.readHTML || 0));
  t['handler-total'] = total;
  return { t, formats, textLen: text.length, files: paths.length, htmlLen: html.length, imagePath };
}

async function main() {
  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: false } });
  makeImages();
  const results = { meta: { platform: process.platform, electron: process.versions.electron, node: process.versions.node, passes: PASSES, ts: new Date().toISOString() }, scenarios: {} };
  for (const scenario of SCENARIOS) {
    setup(scenario);
    const samples = {};
    for (const op of SUB_OPS) samples[op] = [];
    let probe = null;
    for (let i = 0; i < PASSES; i++) {
      const r = await onePass();
      probe = r;
      for (const op of SUB_OPS) if (r.t[op] !== undefined) samples[op].push(r.t[op]);
    }
    results.scenarios[scenario] = {
      observed: { formats: probe.formats, textLen: probe.textLen, files: probe.files, htmlLen: probe.htmlLen, imagePath: probe.imagePath },
      ops: Object.fromEntries(SUB_OPS.filter((op) => samples[op].length).map((op) => [op, { p50: +med(samples[op]).toFixed(3), max: +max(samples[op]).toFixed(3), n: samples[op].length }])),
    };
    console.log('scenario ' + scenario + ': formats=' + probe.formats.join(',') + ' textLen=' + probe.textLen + ' files=' + probe.files + ' htmlLen=' + probe.htmlLen);
  }
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(results, null, 2));
  console.log('\nRESULTS_JSON=' + RESULTS_JSON);
  const w = [26, 10, 10];
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\np50/max ms over ' + PASSES + ' passes');
  for (const scenario of SCENARIOS) {
    console.log('\n=== ' + scenario + ' ===');
    console.log(pad('sub-op', w[0]) + pad('p50 ms', w[1]) + pad('max ms', w[2]));
    for (const op of SUB_OPS) {
      const s = results.scenarios[scenario].ops[op];
      if (s) console.log(pad(op, w[0]) + pad(s.p50, w[1]) + pad(s.max, w[2]));
    }
  }
  app.exit(0);
}
