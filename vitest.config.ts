import { defineConfig } from 'vitest/config';
import { cpus } from 'node:os';

const testWorkers = Math.max(1, Math.min(4, cpus().length || 1));

export default defineConfig({
  test: {
    globals: false,
    include: ['test/**/*.test.ts', 'src/core-agent/test/**/*.test.ts'],
    // Each test file gets a fresh module graph — important because several of
    // our modules cache state (storage line counts, prompts cache, paths
    // mkdir on load). Without isolation, test order would leak state.
    isolate: true,
    // Runs before any test module (or its transitive imports) is loaded.
    // Critical safety net: pins `ORKAS_WORKSPACE_ROOT` to a throwaway tmp
    // dir so `paths.ts`'s module-level `WS_ROOT` constant never freezes to
    // the developer's real `PC/data/`. See ./test/setup-env.ts for the
    // full rationale.
    setupFiles: ['./test/setup-env.ts'],
    // Default reporter is a per-file dot list — keep CI output compact.
    reporters: ['default'],
    // The desktop suite exercises native modules, file IO, child processes,
    // and sqlite-backed features. Leaving Vitest at the host default can
    // oversubscribe local dev machines and make otherwise healthy tests trip
    // the 5s default timeout in full-suite runs.
    maxWorkers: testWorkers,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/main/**/*.{ts,js}',
        'src/core-agent/src/**/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        'src/main/index.ts',
        'src/main/smoke.ts',
        'src/core-agent/src/demo.ts',
        'src/core-agent/src/main.ts',
      ],
      thresholds: {
        lines: 61,
        functions: 62,
        statements: 58,
        branches: 52,
      },
    },
  },
});
