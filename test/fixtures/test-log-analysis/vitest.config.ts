// Negative-control harness for the default test log analysis. It reuses the
// real PC Vitest config (setup tap + reporter) and only narrows the inventory.
// ORKAS_LOG_FIXTURE_NO_TAP removes the tap to prove the reporter's coverage gate.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import base from '../../../vitest.config';

// Exercise checkpoint receipts through the real launcher without inheriting a
// parent run's report destination.
process.env.ORKAS_TEST_BATCH_REPORT = process.env.ORKAS_LOG_FIXTURE_BATCH_REPORT || '';

const reporters = [...(base.test?.reporters as unknown[])];
if (process.env.ORKAS_LOG_FIXTURE_JSON) reporters.push(['json', { outputFile: process.env.ORKAS_LOG_FIXTURE_JSON }]);

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    include: ['test/fixtures/test-log-analysis/*.fixture.ts'],
    setupFiles: process.env.ORKAS_LOG_FIXTURE_NO_TAP === '1' ? [] : base.test?.setupFiles,
    reporters: reporters as never,
  },
});
