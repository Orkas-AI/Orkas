import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('rendered PPT text collision evidence', () => {
  it('reports occupied text intersections while preserving non-collisions and incomplete coverage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-text-collision-test-'));
    const env = { ...process.env, ORKAS_WORKSPACE_ROOT: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const output = path.join(dir, 'result.json');
      const logs = await promisify(execFile)(require('electron'), [
        path.resolve('test/fixtures/office/text-collision-render.cjs'), process.cwd(), output,
      ], { env, timeout: 30_000, maxBuffer: 256 * 1024 });
      expect(logs.stderr).toBe('');
      expect(logs.stdout).toBe('');
      const results = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(results.collision).toMatchObject({ status: 'checked', assessed_text_elements: 2,
        warnings: [{ type: 'text_collision_candidate', severity: 'warning', paths: ['/slide[1]/shape[@id=1]', '/slide[1]/shape[@id=2]'] }] });
      expect(results.collision.warnings[0].bounds.width).toBeGreaterThan(1);
      expect(results.observedCjkPair.warnings).toEqual([expect.objectContaining({
        paths: ['/slide[1]/shape[@id=100114]', '/slide[1]/shape[@id=100115]'], severity: 'warning',
      })]);
      for (const name of ['background', 'emptyBoxes', 'whitespace', 'wrapped', 'clipping', 'transparent']) {
        expect(results[name], name).toMatchObject({ status: 'checked', warnings: [] });
      }
      expect(results.hidden.warnings).toHaveLength(1);
      for (const name of ['rotated', 'effect']) {
        expect(results[name], name).toMatchObject({ status: 'partial', warnings: [] });
        expect(Object.keys(results[name].skipped).length).toBeGreaterThan(0);
      }
      // Identical painted text may be intentional decoration: report a candidate,
      // never infer intent, mutate it, or turn it into a fatal/blocker result.
      expect(results.decorative.warnings).toHaveLength(1);
      expect(results.decorative.warnings[0].severity).toBe('warning');
      expect(results.decorative.limitations.join(' ')).toContain('intentional overlap is not inferred');
      expect(results.unsupported).toMatchObject({ status: 'not_assessed', warnings: [], skipped: { unsupported_text_container: 1 } });
      expect(results.budget.status).toBe('partial');
      expect(results.budget.skipped.collection_budget).toBeGreaterThan(0);
      expect(JSON.stringify(results.budget).length).toBeLessThan(12000);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);
});
