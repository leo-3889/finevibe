#!/usr/bin/env node
// Launch gate for `npm start` / `npm run dev` (prestart / predev hooks).
// With dist/ missing, `electron .` exits SILENTLY (the window loads a
// nonexistent index.html), and users then launch bare `electron` and land on
// the stock Electron welcome window. Fail fast instead, naming every missing
// artifact and the fix. The runtime twin of this check is rendererIsBuilt()
// in src/main/main.ts. npm runs both hooks with cwd = package root.
const fs = require('fs');
const path = require('path');

const root = process.cwd();

const required = [
  path.join('dist', 'main', 'main', 'main.js'),
  path.join('dist', 'preload', 'preload', 'preload.js'),
  path.join('dist', 'renderer', 'index.html'),
];

const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)));
if (missing.length) {
  console.error('FineVibe is not built. Missing build artifacts:');
  for (const rel of missing) {
    console.error('  ' + rel);
  }
  console.error('Run: npm run build');
  process.exit(1);
}
