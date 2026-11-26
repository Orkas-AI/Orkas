import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Playwright cleans its output directory at startup. Keep each invocation's
// attachments and HTML report independent, including failed/baseline evidence.
const runId = randomUUID();

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*_e2e_*.spec.ts',
  outputDir: `./test-results/e2e/${runId}`,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: `playwright-report/${runId}`, open: 'never' }], ['./scripts/e2e-attempt-reporter.ts']]
    : [['list'], ['html', { outputFolder: `playwright-report/${runId}`, open: 'never' }], ['./scripts/e2e-attempt-reporter.ts']],
  projects: [
    {
      name: `electron-${process.platform}`,
    },
  ],
});
