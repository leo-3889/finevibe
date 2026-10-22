#!/usr/bin/env node
// Stamp icon + version resources into dist/win-unpacked/FineVibe.exe.
//
// Why this exists: on a plain Windows host electron-builder's own rcedit pass
// (`win.signAndEditExecutable`) fails while extracting winCodeSign-2.6.0.7z,
// which needs SeCreateSymbolicLinkPrivilege — so local builds run with
// `--config.win.signAndEditExecutable=false` and the exe ships with the
// default Electron icon. The `rcedit` npm package ships the rcedit binary
// directly (node_modules/rcedit/bin), so stamping works without that archive.
//
// Run after the dir phase and before the prepackaged repack:
//   npm run dist:win:local   (see package.json "scripts")
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rcedit } from 'rcedit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'FineVibe.exe');
const icon = path.join(root, 'build', 'icon.ico');
const rel = p => path.relative(root, p).replace(/\\/g, '/');

if (!fs.existsSync(exe)) {
  console.error(`Missing ${rel(exe)} — run the electron-builder dir phase first, e.g.:`);
  console.error('  npx electron-builder --win dir --x64 --publish never ' +
    '--config.npmRebuild=false --config.win.signAndEditExecutable=false');
  process.exit(1);
}
if (!fs.existsSync(icon)) {
  console.error(`Missing ${rel(icon)} — run \`npm run icons\` first.`);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (err) {
  console.error(`Cannot read package.json: ${err.message}`);
  process.exit(1);
}

// Win32 version resources need 4 numeric parts: "0.3.9-dev" -> "0.3.9.0"
const parts = String(pkg.version).split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
while (parts.length < 4) parts.push(0);
const version = parts.join('.');

const productName = pkg.build?.productName || 'FineVibe';
const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;

try {
  await rcedit(exe, {
    icon,
    'file-version': version,
    'product-version': version,
    'version-string': {
      // rcedit matches these keys case-sensitively (PascalCase) and silently
      // ignores unknown ones.
      ProductName: productName,
      FileDescription: productName,
      CompanyName: author,
      OriginalFilename: `${productName}.exe`
    }
  });
} catch (err) {
  console.error(`rcedit failed on ${rel(exe)}: ${err.message}`);
  process.exit(1);
}

console.log(`Stamped ${rel(exe)}: v${version}, icon ${rel(icon)}, product "${productName}", company "${author}"`);
