import * as fs from 'fs';
import { vi } from 'vitest';

export function mockInstructionFiles(
  mockFs: typeof fs,
  files: Record<string, string>,
): void {
  vi.mocked(mockFs.statSync).mockImplementation((filePath: fs.PathLike) => {
    const matchedFile = Object.keys(files).find(key => String(filePath).endsWith(key));

    if (matchedFile) {
      return { isFile: () => true, isDirectory: () => false } as fs.Stats;
    }

    throw new Error('ENOENT');
  });

  vi.mocked(mockFs.readFileSync).mockImplementation((filePath: fs.PathOrFileDescriptor) => {
    const matchedEntry = Object.entries(files).find(([key]) => String(filePath).endsWith(key));

    if (matchedEntry) {
      return matchedEntry[1];
    }

    throw new Error('ENOENT');
  });
}