import { makeContextProducer } from './ai-instructions';

export const geminiContextProducer = makeContextProducer('gemini', {
  fileName: 'GEMINI.md',
  idPrefix: 'gemini-md',
  displayName: 'GEMINI.md',
});
