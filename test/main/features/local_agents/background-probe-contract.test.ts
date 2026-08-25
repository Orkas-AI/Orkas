import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { evaluateStdinCleanupFact } = require(
  '../../../manual/probe-cli-background-runs-contract.cjs',
) as {
  evaluateStdinCleanupFact: (
    main: { stdinEndedAt: number | null; closedAt: number | null },
    cleanup: {
      sawTaskStarted: boolean;
      sawResult: boolean;
      stdinEndedAt: number | null;
      closedAt: number | null;
      proofExists: boolean;
      error?: string | null;
    } | null,
  ) => string;
};

const closedMain = { stdinEndedAt: 100, closedAt: 320 };
const killedLiveTask = {
  sawTaskStarted: true,
  sawResult: true,
  stdinEndedAt: 80,
  closedAt: 260,
  proofExists: false,
  error: null,
};

describe('Claude background-run manual probe verdict', () => {
  it('passes only when stdin closes the CLI and the live task leaves no proof file', () => {
    expect(evaluateStdinCleanupFact(closedMain, killedLiveTask)).toMatch(/^YES /);
  });

  it.each([
    ['no live task was observed', { ...killedLiveTask, sawTaskStarted: false }],
    ['the cleanup CLI stayed open', { ...killedLiveTask, closedAt: null }],
    ['the background task survived', { ...killedLiveTask, proofExists: true }],
    ['the cleanup probe reported an error', { ...killedLiveTask, error: 'spawn failed' }],
  ])('rejects a lookalike close when %s', (_label, cleanup) => {
    expect(evaluateStdinCleanupFact(closedMain, cleanup)).toMatch(/^NO /);
  });
});
