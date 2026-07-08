import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// The runtime loads the committed `scripts/lib/*_core.cjs` bundles, not the
// `_shared/scripts/src/*.ts` sources. Editing a source without re-running the
// build script would silently ship stale behavior — this test is the guard:
// rebuild every core with the repo's own esbuild and byte-compare against the
// committed bundle. Deterministic because esbuild is version-locked and the
// build disables sourcemaps/legal comments.
const requireCjs = createRequire(import.meta.url);
const { outputs, buildTo, pcDir } = requireCjs('../../../scripts/build-video-studio-skill-core.cjs') as {
  outputs: Array<{ entry: string; outfile: string }>;
  buildTo: (outfileFor: (item: { entry: string; outfile: string }) => string) => Promise<
    Array<{ item: { entry: string; outfile: string }; outfile: string }>
  >;
  pcDir: string;
};

describe('video-studio bundled skill cores', () => {
  it('committed lib/*_core.cjs bundles match a fresh build of _shared/scripts/src', async () => {
    expect(outputs.length).toBeGreaterThan(0);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-core-freshness-'));
    try {
      const built = await buildTo((item) => path.join(tmp, path.basename(item.outfile)));
      const stale: string[] = [];
      for (const { item, outfile } of built) {
        const committed = fs.readFileSync(item.outfile);
        const fresh = fs.readFileSync(outfile);
        if (!committed.equals(fresh)) stale.push(path.relative(pcDir, item.outfile));
      }
      expect(
        stale,
        `stale bundled cores (source changed without rebuild): ${stale.join(', ')} — run: node PC/scripts/build-video-studio-skill-core.cjs and commit the updated bundles`,
      ).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
