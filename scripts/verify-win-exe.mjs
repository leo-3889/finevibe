#!/usr/bin/env node
// Fail-closed guard for Windows packaging identity. Proves an artifact carries
// the FineVibe icon AND FineVibe version resources. Works on both shipped
// artifacts: the app exe (PE32+, stamped by scripts/edit-win-exe.mjs /
// electron-builder's rcedit pass) and the NSIS Setup stub (32-bit PE32, whose
// icon + version info makensis embeds from build/icon.ico at build time).
// The historical defect: a build run with --config.win.signAndEditExecutable=false
// ships a renamed electron.exe showing the default Electron icon. That exe is
// NOT iconless — it carries Electron's own atom icon — so presence checks pass;
// the discriminators are (1) the VS_VERSION_INFO strings electron-builder/rcedit
// stamp (an unedited exe says "Electron"), and (2) the icon pixels: the FineVibe
// tile is near-black, the Electron atom averages light. Both are checked directly
// against the PE resource directory (no Windows API, no deps).
// A second mode takes the UNPACKED APP DIR instead of an exe and audits the
// native modules packed inside it (row 74) plus the asar's app entry points:
// see verifyPackedNative / verifyPackedAsarEntries below.
// Usage: node scripts/verify-win-exe.mjs [path-to-exe|path-to-unpacked-dir]
//        (default exe: out/win-unpacked/FineVibe.exe)
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? path.join(root, 'out', 'win-unpacked', 'FineVibe.exe');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;
// Same thresholds as the CI guard step in release.yml (build-windows).
const MAX_MEAN_RGB = 65; // opaque-pixel mean; FineVibe=56.6, Electron=73.4
const EXPECTED_PRODUCT_NAME = 'FineVibe';
// App entry points that must be listed in resources/app.asar (dir-phase mode).
// Declared up here: the dir-mode dispatch runs at module top level.
const ASAR_ENTRY_POINTS = [
  '/dist/preload/preload/preload.js', // preload.ts -> window bridges (all IPC)
  '/dist/main/main/main.js', // main entry (package.json "main")
  '/dist/renderer/index.html', // renderer entry
];

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// --- Row 74: native-module mode (argument = the electron-builder unpacked dir) ---
// The PE checks below only see icon/version resources, so they stay green while
// the packed .node binaries target the wrong ABI. Both Windows build paths can
// produce that: the postinstall hook swallows `install-app-deps` failures, and
// `dist:win:local` passes `--config.npmRebuild=false`. UNVERIFIED-RUNTIME: the
// bindings are never require()d (a foreign-ABI .node cannot load on the build
// host anyway) - the checks read packed bytes only.
if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
  verifyPackedNative(target);
  verifyPackedAsarEntries(target);
  console.log('OK: packed native modules carry the Electron ABI recorded by the rebuild, the win32 node-pty prebuilds are present, and app.asar carries the app entry points');
  process.exit(0);
}
// The Setup.exe / portable-exe mode above reads PE resources only, so it does NOT
// re-list the asar. That is deliberate: the nsis + zip legs run with
// `--prepackaged out/win-unpacked`, i.e. they pack the exact tree the dir-phase
// mode just audited, so a payload edit between the two gates would need a manual
// re-pack. Extracting app-64.7z (150 MB, needs a 7z host binary) to re-prove a
// check that already ran on the same bytes is not worth the dependency.

if (!fs.existsSync(target)) fail(`${target} not found - run the electron-builder dir phase first`);
const exe = target;
const buf = fs.readFileSync(exe);

// V8-ABI addons export `node_register_module_v<NODE_MODULE_VERSION>`; that
// symbol name is in the binary, so the file bytes state which runtime the
// loader will accept. N-API addons export `napi_register_module_v1` instead
// (ABI-stable, nothing to compare) -> undefined here.
function packedModuleAbi(file) {
  const match = /node_register_module_v(\d+)/.exec(fs.readFileSync(file).toString('latin1'));
  return match ? match[1] : undefined;
}

function verifyPackedNative(unpackedDir) {
  const modules = path.join(unpackedDir, 'resources', 'app.asar.unpacked', 'node_modules');
  if (!fs.existsSync(modules)) {
    fail(`${modules} not found - pass the unpacked app dir (out/win-unpacked), not an exe`);
  }

  // 1. better-sqlite3 ships the Electron ABI, not the build host's Node ABI.
  //    The anchor is node_modules/better-sqlite3/build/Release/.forge-meta:
  //    @electron/rebuild (run by `electron-builder install-app-deps`) is its
  //    ONLY writer and writes `<arch>--<NODE_MODULE_VERSION>` on every success
  //    path (prebuildify / prebuild-install / node-pre-gyp / node-gyp). Plain
  //    node-gyp and `npm rebuild` never touch it. The marker is NOT copied into
  //    the bundle (electron-builder drops it), so it has to be read from the
  //    build tree that produced it - and the packed binding must carry the
  //    same NODE_MODULE_VERSION in its register symbol.
  const binding = path.join(modules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(binding)) fail(`${binding} missing - better-sqlite3 was not unpacked from app.asar (asarUnpack)`);
  const metaFile = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', '.forge-meta');
  if (!fs.existsSync(metaFile)) {
    fail(`${path.relative(root, metaFile)} missing - better-sqlite3 was never rebuilt for the Electron ABI (postinstall swallows install-app-deps failures); run \`npx electron-builder install-app-deps\``);
  }
  const meta = fs.readFileSync(metaFile, 'utf8').trim();
  const expectedAbi = /--(\d+)$/.exec(meta)?.[1];
  if (!expectedAbi) fail(`${path.relative(root, metaFile)} is ${JSON.stringify(meta)}, expected "<arch>--<NODE_MODULE_VERSION>" as written by @electron/rebuild`);
  const abi = packedModuleAbi(binding);
  console.log(`${path.relative(root, binding)}: NODE_MODULE_VERSION ${abi ?? 'none (N-API build?)'} in the register symbol (build tree .forge-meta ${JSON.stringify(meta)})`);
  if (abi !== expectedAbi) {
    fail(`packed better_sqlite3.node targets ABI ${abi ?? '?'}, the Electron rebuild recorded ${expectedAbi} - every user hits ERR_DLOPEN_FAILED otherwise. Re-run \`npx electron-builder install-app-deps\` and rebuild (dist:win:local's --config.npmRebuild=false skips it).`);
  }

  // 2. node-pty's win32 bindings are N-API loaders that pull in winpty.dll /
  //    conpty.dll and spawn winpty-agent.exe / OpenConsole.exe next to
  //    app.asar. electron-builder strips .dll/.exe from node_modules for every
  //    NON-Windows target (app-builder-lib appFileCopier
  //    getNodeModuleExcludedExts), so the linux/mac bundles legitimately lack
  //    them and only a Windows artifact can prove they survived.
  const prebuilds = path.join(modules, 'node-pty', 'prebuilds');
  if (!fs.existsSync(prebuilds)) fail(`${prebuilds} missing - node-pty was not unpacked from app.asar`);
  const winDirs = fs.readdirSync(prebuilds).filter((d) => d.startsWith('win32-'));
  if (!winDirs.length) fail(`${prebuilds} has no win32-* directory - node-pty would find no binding on Windows (lib/utils.js loadNativeModule)`);
  const needed = ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty.dll', 'winpty-agent.exe',
    path.join('conpty', 'conpty.dll'), path.join('conpty', 'OpenConsole.exe')];
  for (const dir of winDirs) {
    for (const rel of needed) {
      const file = path.join(prebuilds, dir, rel);
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size === 0) fail(`node-pty ${dir}/${rel} missing or empty in ${path.relative(root, unpackedDir)} - Windows PTY spawn fails at runtime`);
    }
    console.log(`node-pty ${dir}: ${needed.length} required files present`);
  }
}

// --- App entry points inside app.asar ---
// The historical defect: a build whose preload leg never ran (build:core is
// `tsc -p tsconfig.main.json && tsc -p tsconfig.preload.json`; a truncated run
// ships main+renderer only) produces a bundle that installs, launches a window
// and shows the UI — while every IPC call dies because BrowserWindow's preload
// script is not in the archive. Nothing else in the chain notices: the native
// ABI check, the icon/version stamp and latest.yml are all green. The asar
// header is the ground truth for what the shipped app can load, so read it.
function verifyPackedAsarEntries(unpackedDir) {
  const asarPath = path.join(unpackedDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) fail(`${asarPath} missing - pass the unpacked app dir (out/win-unpacked) after the dir phase`);
  let asar;
  try {
    asar = createRequire(import.meta.url)('@electron/asar');
  } catch (err) {
    fail(`cannot load @electron/asar (bundled with electron-builder): ${err.message} - run npm install`);
  }
  // listPackage emits platform separators; the required entries are asar paths.
  const entries = new Set(asar.listPackage(asarPath).map((p) => p.split(path.sep).join('/')));
  const preloadFiles = [...entries].filter((p) => p.startsWith('/dist/preload/')).length;
  console.log(`resources/app.asar: ${entries.size} entries, ${preloadFiles} files under dist/preload/`);
  for (const entry of ASAR_ENTRY_POINTS) {
    if (!entries.has(entry)) {
      fail(`resources/app.asar does not list ${entry} - the packaged app cannot load it: ${
        entry.includes('preload')
          ? 'a missing preload.js leaves the window rendering with every IPC channel dead (run `npm run build:core`, which is tsc main AND tsc preload; never substitute one leg for the other)'
          : `run \`npm run build\` before packing (files: ${JSON.stringify(entry)})`}`);
    }
  }
  console.log(`app.asar entry points present: ${ASAR_ENTRY_POINTS.join(', ')}`);
}

// --- PE layout -> .rsrc file offset + RVA delta ---
if (buf.readUInt16LE(0) !== 0x5a4d) fail('not an MZ executable');
const peOff = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOff) !== 0x00004550) fail('not a PE executable');
// The app exe is PE32+; the NSIS Setup stub is a 32-bit PE32 image, and both
// carry the identity resources, so accept either (the data-directory offset
// differs by image type below).
const magic = buf.readUInt16LE(peOff + 24);
if (magic !== 0x20b && magic !== 0x10b) fail(`expected a PE32 (0x10b) or PE32+ (0x20b) image, got 0x${magic.toString(16)}`);
const numSections = buf.readUInt16LE(peOff + 6);
const sizeOfOptional = buf.readUInt16LE(peOff + 20);
const secOff = peOff + 24 + sizeOfOptional;
const dataDirOff = peOff + 24 + (magic === 0x20b ? 112 : 96); // data directories: PE32+ at +112, PE32 at +96; index 2 = .rsrc
const rsrcRva = buf.readUInt32LE(dataDirOff + 2 * 8);
const rsrcSize = buf.readUInt32LE(dataDirOff + 2 * 8 + 4);
if (!rsrcRva || !rsrcSize) fail('exe has no resource directory at all');
let rsrcFileOff = -1;
for (let i = 0; i < numSections; i++) {
  const o = secOff + i * 40;
  if (buf.readUInt32LE(o + 12) === rsrcRva) { rsrcFileOff = buf.readUInt32LE(o + 20); break; }
}
if (rsrcFileOff < 0) fail('.rsrc RVA not backed by any section');
// Resource-directory node offsets are relative to the .rsrc start; data
// entries are RVAs. Both map linearly into the file because .rsrc is one
// contiguous section.
const node = (rel) => rsrcFileOff + (rel & 0x7fffffff);
const slice = (rva, bytes) => buf.subarray(rsrcFileOff + (rva - rsrcRva), rsrcFileOff + (rva - rsrcRva) + bytes);

// --- resource directory tree (type -> name -> language) ---
function entries(nodeOff) {
  const n = buf.readUInt16LE(nodeOff + 14);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = nodeOff + 16 + i * 8;
    out.push({ id: buf.readUInt32LE(e), dataOff: buf.readUInt32LE(e + 4) });
  }
  return out;
}
// Directory entries: high bit of `id` marks a string-named entry; the high
// bit of `dataOff` (levels 1-2) marks "points to a subdirectory", NOT "named".
const isNamedId = (id) => (id & 0x80000000) !== 0;
function typeLeaves(typeId) {
  const typeNode = entries(rsrcFileOff).find((e) => !isNamedId(e.id) && e.id === typeId);
  if (!typeNode) return [];
  const out = [];
  for (const name of entries(node(typeNode.dataOff))) {
    const id = isNamedId(name.id) ? '' : name.id;
    for (const lang of entries(node(name.dataOff))) {
      const o = node(lang.dataOff);
      out.push({ id, rva: buf.readUInt32LE(o), bytes: buf.readUInt32LE(o + 4) });
    }
  }
  return out;
}

const icons = new Map(typeLeaves(RT_ICON).map((l) => [String(l.id), l]));
const groups = typeLeaves(RT_GROUP_ICON);
const versions = typeLeaves(RT_VERSION);
if (!groups.length) fail('no RT_GROUP_ICON resource - exe carries no icon at all');
if (!icons.size) fail('no RT_ICON resources');
if (!versions.length) fail('no RT_VERSION resource - exe was never stamped (Windows shows "Electron"); run npm run win:stamp');

// --- icon group: size set + dark-tile pixel check on the 32px BMP entry ---
const g = slice(groups[0].rva, groups[0].bytes);
const count = g.readUInt16LE(4);
const images = [];
for (let i = 0; i < count; i++) {
  const o = 6 + i * 14;
  images.push({ w: g[o] || 256, id: g.readUInt16LE(o + 12) });
}
console.log(`${path.relative(root, exe)}: icon group has ${count} images: ${images.map((m) => m.w).join(',')}`);
const sizes = new Set(images.map((m) => m.w));
for (const need of [16, 32, 48, 256]) {
  if (!sizes.has(need)) fail(`icon group lacks a ${need}px image - not build/icon.ico (ships 16/24/32/48/64/72/96/128/256)`);
}
const icon32 = icons.get(String(images.find((m) => m.w === 32).id));
if (!icon32) fail('RT_ICON for the 32px group entry is missing');
const ib = slice(icon32.rva, icon32.bytes);
if (ib.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))) {
  fail('32px RT_ICON is PNG-encoded; build/icon.ico stores <=48px entries as BMP');
}
// BITMAPINFOHEADER: biSize=40, biWidth=32, biHeight=64 (XOR+AND doubling),
// biBitCount=32. The 32*32 BGRA XOR bitmap follows the header.
if (ib.readUInt32LE(0) !== 40 || ib.readUInt32LE(4) !== 32 || ib.readUInt32LE(8) !== 64 || ib.readUInt16LE(14) !== 32) {
  fail('32px RT_ICON is not the expected 32x64 32bpp BITMAPINFOHEADER DIB');
}
// Alpha-aware discriminator measured from the shipped assets: the 32px entry
// of build/icon.ico averages 56.6 over opaque pixels (dark squircle);
// electron.exe's own atom icon averages 73.4. Flat RGB means (transparent
// pixels counted as black) and composite-on-white means (110.9 vs 111.0) are
// NOT discriminators - both icons average within 1 unit of each other.
let op = 0;
let sum = 0;
for (let p = 0; p < 32 * 32; p++) {
  const o = 40 + p * 4;
  if (ib[o + 3] > 128) {
    op++;
    sum += ib[o] + ib[o + 1] + ib[o + 2];
  }
}
const opMean = op ? sum / op / 3 : 255;
console.log(`32px icon opaque-pixel mean RGB: ${opMean.toFixed(1)} over ${op} px (threshold ${MAX_MEAN_RGB}; FineVibe tile=56.6, Electron atom=73.4)`);
if (opMean >= MAX_MEAN_RGB) fail('icon pixels match the default Electron icon, not the FineVibe tile - run npm run win:stamp');

// --- VS_VERSION_INFO string table ---
const vb = slice(versions[0].rva, versions[0].bytes);
const align4 = (o) => (o + 3) & ~3;
const readVersionString = (key) => {
  // String entries are: wLength(2) wValueLength(2) wType(2) szKey(utf16z)
  // pad-to-4 wValue(utf16 incl NUL). Locate the entry by its unique key
  // bytes; the node starts 6 bytes before the key.
  const k = vb.indexOf(Buffer.from(key, 'utf16le'));
  if (k < 0) return undefined;
  // wValueLength counts chars; tools differ on whether the NUL is included,
  // so read chars*2 bytes and trim at the first NUL.
  const chars = vb.readUInt16LE(k - 4);
  const vOff = align4(k + 2 * (key.length + 1));
  return vb.toString('utf16le', vOff, vOff + chars * 2).replace(/\0[\s\S]*$/, '');
};
const strings = Object.fromEntries(
  ['ProductName', 'FileVersion', 'OriginalFilename'].map((k) => [k, readVersionString(k)]),
);
console.log(`version strings: ProductName=${JSON.stringify(strings.ProductName)} FileVersion=${JSON.stringify(strings.FileVersion)} OriginalFilename=${JSON.stringify(strings.OriginalFilename)}`);
if (strings.ProductName !== EXPECTED_PRODUCT_NAME) fail(`ProductName is ${JSON.stringify(strings.ProductName)}, expected ${JSON.stringify(EXPECTED_PRODUCT_NAME)} - an unedited build reports "Electron"; run npm run win:stamp`);
// Two artifact shapes: the app exe carries rcedit's 4-part numeric stamp plus
// OriginalFilename; the NSIS Setup stub carries the app version verbatim
// (`0.3.9-dev`) and no OriginalFilename at all — that is what makensis writes,
// and the shape release.yml's guard accepts.
const isSetup = /-Setup-/i.test(path.basename(exe));
if (!/^(\d+\.){2,3}\d+(-[0-9A-Za-z.-]+)?$/.test(strings.FileVersion ?? '')) {
  fail(`FileVersion ${JSON.stringify(strings.FileVersion)} is not a version string`);
}
if (isSetup) {
  let appVersion;
  try {
    appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch (err) {
    fail(`cannot read the app version from package.json: ${err.message}`);
  }
  if (strings.FileVersion.split('-')[0] !== appVersion.split('-')[0]) {
    fail(`Setup FileVersion ${JSON.stringify(strings.FileVersion)} does not carry the app version ${JSON.stringify(appVersion)}`);
  }
} else {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(strings.FileVersion ?? '')) {
    fail(`app exe FileVersion ${JSON.stringify(strings.FileVersion)} is not 4-part numeric - run npm run win:stamp`);
  }
  if (strings.OriginalFilename !== 'FineVibe.exe') fail(`OriginalFilename is ${JSON.stringify(strings.OriginalFilename)}, expected "FineVibe.exe"`);
}

console.log('OK: exe carries the FineVibe icon and FineVibe version resources');
