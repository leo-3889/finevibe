import { makeContextProducer } from './ai-instructions';

export const codexContextProducer = makeContextProducer('codex', {
  fileName: 'AGENTS.md',
  idPrefix: 'agents-md',
  displayName: 'AGENTS.md',
});
