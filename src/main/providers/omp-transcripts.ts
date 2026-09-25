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
 * OMP's on-disk transcript contract (shared with Pi — see
 * pi-compatible-transcripts.ts) parameterized with OMP's default agent dir.
 */
export { HEADER_READ_BYTES, readFirstLineSync, readFirstLineAsync, parseSessionHeader };
export type { CompatibleSessionHeader as OmpSessionHeader } from './pi-compatible-transcripts';

const { agentDir, sessionsRoot } = createCompatibleTranscriptModule(
  path.join(os.homedir(), '.omp', 'agent')
);

/** OMP's agent dir: ~/.omp/agent by default, relocated via PI_CODING_AGENT_DIR (profiles). */
export const ompAgentDir = agentDir;

export const ompSessionsRoot = sessionsRoot;
