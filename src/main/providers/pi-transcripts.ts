import * as path from 'path';
import * as os from 'os';
import {
  createCompatibleTranscriptModule,
  readFirstLineSync,
  readFirstLineAsync,
  parseSessionHeader,
  HEADER_READ_BYTES,
} from './pi-compatible-transcripts';

/**
 * Pi's on-disk transcript contract (shared with OMP — see
 * pi-compatible-transcripts.ts) parameterized with Pi's default agent dir.
 */
export { HEADER_READ_BYTES, readFirstLineSync, readFirstLineAsync, parseSessionHeader };
export type { CompatibleSessionHeader as PiSessionHeader } from './pi-compatible-transcripts';

const { agentDir, sessionsRoot } = createCompatibleTranscriptModule(
  path.join(os.homedir(), '.pi', 'agent')
);

/** Pi's agent dir: ~/.pi/agent by default, relocated via PI_CODING_AGENT_DIR (profiles). */
export const piAgentDir = agentDir;

export const piSessionsRoot = sessionsRoot;
