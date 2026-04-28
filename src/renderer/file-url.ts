import { isWin } from './platform.js';

export function pathToFileURL(absPath: string): string {
  let p = isWin ? absPath.replace(/\\/g, '/') : absPath;
  if (isWin && /^[A-Za-z]:/.test(p)) p = '/' + p;
  const segments = p.split('/').map((seg, i) => {
    // Skip the drive-letter segment so its colon isn't encoded as %3A.
    if (isWin && i === 1 && /^[A-Za-z]:$/.test(seg)) return seg;
    return encodeURIComponent(seg);
  });
  return 'file://' + segments.join('/');
}
