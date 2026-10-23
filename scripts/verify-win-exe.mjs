#!/usr/bin/env node
// Fail-closed guard for local Windows packaging: proves out/win-unpacked/
// FineVibe.exe carries the FineVibe icon AND the version stamp written by
// scripts/edit-win-exe.mjs. The historical defect: a build run with
// --config.win.signandeditexecutable=false ships a renamed electron.exe that
// shows the default Electron icon. That exe is NOT iconless — it carries
// Electron's own atom icon — so presence checks pass; the discriminators are
// (1) the VS_VERSION_INFO strings electron-builder/rcedit stamp (an
// unedited exe says "Electron"), and (2) the icon pixels: the FineVibe tile
// is near-black, the Electron atom averages light. Both are checked directly
// against the PE resource directory (no Windows API, no deps).
// Usage: node scripts/verify-win-exe.mjs [path-to-exe]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.argv[2] ?? path.join(root, 'out', 'win-unpacked', 'FineVibe.exe');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;
// Same thresholds as the CI guard step in release.yml (build-windows).
const MAX_MEAN_RGB = 65; // opaque-pixel mean; FineVibe=56.6, Electron=73.4
const EXPECTED_PRODUCT_NAME = 'FineVibe';

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (!fs.existsSync(exe)) fail(`${exe} not found - run the electron-builder dir phase first`);
const buf = fs.readFileSync(exe);

// --- PE layout -> .rsrc file offset + RVA delta ---
if (buf.readUInt16LE(0) !== 0x5a4d) fail('not an MZ executable');
const peOff = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOff) !== 0x00004550) fail('not a PE executable');
if (buf.readUInt16LE(peOff + 24) !== 0x20b) fail('expected PE32+ (64-bit) image');
const numSections = buf.readUInt16LE(peOff + 6);
const sizeOfOptional = buf.readUInt16LE(peOff + 20);
const secOff = peOff + 24 + sizeOfOptional;
const dataDirOff = peOff + 24 + 112; // PE32+ optional header data directories start at +112; index 2 = .rsrc
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
if (!/^\d+\.\d+\.\d+\.\d+$/.test(strings.FileVersion ?? '')) fail(`FileVersion ${JSON.stringify(strings.FileVersion)} is not 4-part numeric`);
if (strings.OriginalFilename !== 'FineVibe.exe') fail(`OriginalFilename is ${JSON.stringify(strings.OriginalFilename)}, expected "FineVibe.exe"`);

console.log('OK: exe carries the FineVibe icon and FineVibe version resources');
