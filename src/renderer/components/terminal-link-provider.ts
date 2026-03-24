import type { ILinkProvider, ILink, IBufferRange, Terminal } from '@xterm/xterm';
import { appState } from '../state.js';

// Matches file paths like: src/foo/bar.ts:10-20, ./src/foo.ts:10, src/foo.ts
// Must contain a `/` and end with a file extension
const FILE_PATH_RE = /(?:^|[\s'"(\[{])(\.\/)?((?:[a-zA-Z0-9_@.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)(?::(\d+)(?:-(\d+))?)?/g;

export class FilePathLinkProvider implements ILinkProvider {
  constructor(
    private projectId: string,
    private projectPath: string,
    private terminal: Terminal
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }

    const lineText = line.translateToString(true);
    const links: ILink[] = [];

    FILE_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FILE_PATH_RE.exec(lineText)) !== null) {
      const prefix = match[0].length - (match[1] || '').length - match[2].length - (match[3] ? `:${match[3]}` : '').length - (match[4] ? `-${match[4]}` : '').length;
      const startX = match.index + prefix + 1; // 1-based
      const fullMatchText = match[0].substring(prefix);
      const endX = startX + fullMatchText.length - 1;

      const filePath = match[2];
      const lineNumber = match[3] ? parseInt(match[3], 10) : undefined;

      const range: IBufferRange = {
        start: { x: startX, y: bufferLineNumber },
        end: { x: endX, y: bufferLineNumber },
      };

      links.push({
        range,
        text: fullMatchText,
        activate: (event: MouseEvent, _text: string) => {
          if (!event.metaKey) return;
          appState.addFileReaderSession(this.projectId, filePath, lineNumber);
        },
      });
    }

    callback(links.length > 0 ? links : undefined);
  }
}
