import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const VIDEO_STUDIO_ROOT = path.join(
  process.cwd(),
  'resources',
  'builtin',
  'marketplace',
  'agents',
  '79df9cc89f5f',
);

const read = (...segments: string[]) => fs.readFileSync(path.join(VIDEO_STUDIO_ROOT, ...segments), 'utf8');

describe('open-source VideoStudio resources', () => {
  it('preserves natural English casing and bounds all-caps accents', () => {
    const agent = JSON.parse(read('agent.json')) as { standards?: string[] };
    const frontendDesign = read('skills', 'frontend-design', 'SKILL.md');
    const stageCompose = read('skills', 'stage-compose', 'SKILL.md');
    const compositionDesignReview = read('skills', 'composition-design-review', 'SKILL.md');
    const visualPrimitives = read('skills', 'frontend-design', 'references', 'visual-primitives.md');
    const standards = (agent.standards ?? []).join('\n');

    expect(visualPrimitives).not.toMatch(/text-transform\s*:\s*uppercase/i);
    expect(visualPrimitives).toMatch(/Preserve the authored case by default/i);
    expect(frontendDesign).toMatch(/Preserve the authored casing of approved English copy by default/i);
    expect(frontendDesign).toMatch(/two or more English text roles.*all caps/i);
    expect(stageCompose).toMatch(/Preserve approved English casing by default/i);
    expect(compositionDesignReview).toMatch(/two or more English text roles.*all caps/i);
    expect(standards).toMatch(/Preserve approved English casing/i);
  });
});
