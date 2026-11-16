import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(process.cwd(), 'resources/builtin/marketplace/agents/79df9cc89f5f');
const read = (...segments: string[]) => fs.readFileSync(path.join(root, ...segments), 'utf8');
const agent = JSON.parse(read('agent.json')) as {
  workflow: string; skill_list: string[]; tool_list: string[];
  runtime: { kind: string }; video_studio_contract: number;
};

describe('open-source VideoStudio resources', () => {
  it('preserves configured-service billing and uncertain-request boundaries without hosted funding claims', () => {
    const generation = read('skills/video-studio/references/generation.md');
    expect(agent.runtime.kind).toBe('in_process');
    expect(agent.tool_list).toContain('media');
    expect(agent.workflow).toMatch(/configured services/);
    expect(agent.workflow).toMatch(/cannot verify prices or balances/);
    expect(generation).toMatch(/not a price, balance check or spending authorization/);
    expect(generation).toMatch(/do not dispatch another request automatically/);
    expect(generation).toMatch(/confirmed undispatched failure/);
    expect(generation).toMatch(/explicit new paid attempt needs the user's authorization/);
    expect(generation).not.toMatch(/same request again never pays twice|repeat it unchanged/);
    const audio = read('skills/video-studio/references/audio.md');
    expect(audio).not.toMatch(/music_capabilities|separation_capabilities|music_status|separation_status|credits_per_second/);
    expect(audio).toContain('generate_speech');
    expect(audio).toMatch(/licensed track the user supplies/);
    // The repository forbids adding its own general moderation to model instructions.
    expect(read('skills/video-craft/references/presenter.md')).not.toContain('wholly fictional adult');
  });

  it('keeps natural English casing in the reachable design owners', () => {
    const primitives = read('skills/frontend-design/references/visual-primitives.md');
    const presets = read('skills/frontend-design/references/design-presets.md');
    expect(primitives).not.toMatch(/text-transform\s*:\s*uppercase/i);
    expect(primitives).toMatch(/Preserve the authored case/);
    expect(presets).toMatch(/keep the approved copy's casing/i);
    const dir = path.join(root, 'skills/frontend-design/references/design-presets');
    const files = fs.readdirSync(dir).filter(file => file.endsWith('.md'));
    expect(files).toHaveLength(13);
    for (const file of files) {
      expect(read('skills/frontend-design/references/design-presets', file)).toMatch(/approved casing/i);
    }
    expect(read('skills/frontend-design/SKILL.md')).toContain('(references/design-presets.md)');
  });

  it('ships one current tool protocol and retires the old approval-resource entrypoints', () => {
    expect(agent.video_studio_contract).toBe(3);
    expect([...agent.skill_list].sort()).toEqual([
      'design-system-importer', 'frontend-design', 'stage-decide', 'stage-edit', 'video-craft', 'video-studio',
    ]);
    for (const retired of ['gate-control', 'stage-plan', 'stage-assemble', 'stage-compose',
      'stage-generate', 'stage-consistency', 'video-router', 'composition-design-review']) {
      expect(fs.existsSync(path.join(root, 'skills', retired)), retired).toBe(false);
    }
    expect(read('skills/video-studio/SKILL.md')).toContain('video.ship');
  });
});
