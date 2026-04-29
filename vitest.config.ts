import { defineConfig } from 'vitest/config';

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
  },
});
