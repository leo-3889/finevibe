import { basename } from './platform.js';

export function deriveProjectName(cwd: string, fallback = ''): string {
  return basename(cwd) || fallback;
}
