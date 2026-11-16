import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { validateAgentSpec } from '../../../src/main/quality';
import { VIDEO_STUDIO_TOOL_CONTRACT } from '../../../src/main/features/video_studio_skill_contract';
import { videoFrameSupport, videoModelSpec } from '../../../src/main/features/video_models';
import { compileVideoPage, parseVideoManifest, validateVideoTimeline } from '../../../src/main/features/video_timeline';
import { createVideoStudioTool } from '../../../src/main/model/core-agent/video-studio-tool';
import { createVideoTimelineTool } from '../../../src/main/model/core-agent/video-timeline-tool';
import { AGENT_FALLBACK_TOOL_GROUP_IDS, toolNamesForGroups } from '../../../src/main/model/core-agent/tool-catalog';

// The VideoStudio package reaches users through the marketplace and the tool through
// App releases, so what the package tells the model must match what this App's tool does.

const pcRoot = process.cwd();
const packageDir = path.join(pcRoot, 'resources', 'builtin', 'marketplace', 'agents', '79df9cc89f5f');
const agent = JSON.parse(fs.readFileSync(path.join(packageDir, 'agent.json'), 'utf8')) as Record<string, any>;

function textFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'scripts' || entry.name === 'assets' ? [] : textFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

const skillFiles = textFiles(path.join(packageDir, 'skills'));
const modelText = [
  { file: 'agent.json', text: [agent.workflow, ...agent.knowhow, ...agent.standards].join('\n') },
  ...skillFiles.map((file) => ({ file: path.relative(packageDir, file), text: fs.readFileSync(file, 'utf8') })),
];

function toolOps(): string[] {
  const opts = { userId: 'package-contract' };
  const tool = createVideoTimelineTool(opts, createVideoStudioTool(opts));
  return (tool.inputSchema as { properties: { op: { enum: string[] } } }).properties.op.enum;
}

function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split('.').map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

describe('the VideoStudio package', () => {
  it('keeps the documented ledger, timeline and page usable together, and rejects broken bindings', () => {
    const reference = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/timeline.md'), 'utf8');
    const blocks = [...reference.matchAll(/```(json|html)\n([\s\S]*?)\n```/g)];
    const examples = blocks.filter((block) => block[1] === 'json').map((block) => JSON.parse(block[2]));
    const manifest = parseVideoManifest(examples.find((value) => value.schema_version === 3)).manifest!;
    const assets = examples.find((value) => Array.isArray(value.assets)).assets;
    const product = examples.find((value) => Array.isArray(value.facts));
    const html = blocks.find((block) => block[1] === 'html')![2];
    expect(manifest).not.toBeNull();
    expect(validateVideoTimeline({ manifest, assets, product })).toEqual([]);
    const compiled = compileVideoPage({ html, manifest, product, baseHref: 'file:///example/videos/main/' });
    expect(compiled.issues).toEqual([]);
    expect(compiled.html).toContain('¥199');
    for (const scene of manifest.scenes) {
      for (const clip of scene.clips ?? []) {
        expect(compiled.scenes[scene.id].subtree).toContain(`data-clip="${clip.id}"`);
        expect(assets.some((asset: { id: string }) => asset.id === clip.asset)).toBe(true);
      }
    }
    // A plausible missing picture or typo must still be detected by the actual validators.
    const clip = manifest.scenes.flatMap((scene) => scene.clips ?? [])[0];
    expect(clip).toBeDefined();
    expect(validateVideoTimeline({ manifest, assets: assets.filter((asset: { id: string }) => asset.id !== clip.asset), product })
      .some((issue) => issue.code === 'TIMELINE_ASSET_UNKNOWN')).toBe(true);
    expect(compileVideoPage({ html: html.replace(`data-clip="${clip.id}"`, 'data-clip="missing-clip"'),
      manifest, product, baseHref: 'file:///example/videos/main/' }).issues
      .some((issue) => issue.code === 'PAGE_CLIP_UNKNOWN')).toBe(true);
  });

  it('owns current-file measurement reuse in audio guidance without relaxing delivery checks', () => {
    const audio = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/audio.md'), 'utf8');
    const levels = (audio.split('## Levels')[1] ?? '').replace(/\s+/g, ' ');
    for (const field of ['video.render', 'probe', 'media_qa', 'loudness', 'video.ship', 'version.integrated_lufs', 'warnings']) {
      expect(levels).toContain(`\`${field}\``);
    }
    expect(levels).toMatch(/same unchanged.*file/i);
    expect(levels).toMatch(/missing.*failed.*unknown/i);
    expect(levels).toMatch(/chang.*fresh/i);
    expect(levels).toMatch(/missing measurement|specific concern/i);
    expect(levels).toMatch(/fade.*not|not.*fade/i);
    const entry = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    for (const op of ['video.check', 'video.sheet', 'video.render', 'video.ship']) expect(entry).toContain(`\`${op}\``);
    expect(agent.workflow).not.toContain('integrated_lufs');
  });

  it('routes source images and reference videos to their supported inspection tools', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    const brief = guide.split('## 1. Brief')[1].split('## 2. Material')[0];
    expect(brief).toMatch(/images with `read_files`/);
    expect(brief).toMatch(/reference videos with `reference\.inspect`/);
  });

  it('distinguishes plain subtitles from designed page text in its owning route', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    const route = guide.split('## The two tools')[1].split('## 1. Brief')[0];
    expect(route).toMatch(/designed text.*page/i);
    expect(route).toMatch(/plain subtitles.*`burnsubs`.*`stage-edit`/i);
    // The implementation and font caveat stay in the editing Skill, rather
    // than becoming another resident command manual.
    expect(agent.workflow).not.toContain('burnsubs');
    expect(route).not.toContain('drawtext');
  });

  it('owns repair, honest blocked stops and optional enhancements without deferring requirements', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    const delivery = guide.split('## 5. Deliver')[1].split('## When to stop and ask')[0];
    expect(delivery).toMatch(/unmet requirements.*repair/i);
    expect(delivery).toMatch(/incomplete/i);
    expect(delivery).toMatch(/existing rework limit/i);
    expect(delivery).toMatch(/optional enhancements.*request is satisfied/i);
    expect(delivery).not.toMatch(/each known gap that can still be closed needs one/i);
    expect(agent.standards.join('\n')).toMatch(/unmet requirements.*incomplete/i);
    expect(agent.standards.join('\n')).not.toMatch(/next steps.*each gap/i);
  });

  it('carries the completion standards once through the real named-Agent prompt', async () => {
    const { normalizeAgent } = await import('../../../src/main/features/agents');
    const { _buildAgentInGroupSystemPromptForTest } = await import('../../../src/main/features/group_chat/bus');
    const prompt = await _buildAgentInGroupSystemPromptForTest(normalizeAgent(agent, 'builtin')!, '/tmp/video-package-contract', 'zh');
    for (const standard of agent.standards) expect(prompt.split(standard)).toHaveLength(2);
    for (const displayOnly of agent.knowhow) expect(prompt).not.toContain(displayOnly);
    expect(prompt).not.toMatch(/next steps.*each gap/i);
  });

  it('routes ads with nothing to sell to marketing guidance, and makes test versions as copies', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    const writing = guide.split('## 2. Material')[0];
    expect(writing).toContain('(@skill/video-craft/references/marketing.md)');
    const craft = fs.readFileSync(path.join(packageDir, 'skills/video-craft/SKILL.md'), 'utf8');
    expect(craft).toContain('(references/marketing.md)');
    const ads = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/ads.md'), 'utf8');
    expect(ads).toContain('(@skill/video-craft/references/marketing.md)');

    // Versions for a test reuse the revision copy the main Skill owns, so they share
    // footage and voice instead of paying for the same shots again.
    const revision = guide.split('## Changing a video')[1] ?? '';
    expect(revision).toMatch(/test variant, gets a copy: `videos\/main` to `videos\/<new id>`/);
    const marketing = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/marketing.md'), 'utf8')
      .replace(/\s+/g, ' ');
    const versions = marketing.split('## Versions for testing and placements')[1] ?? '';
    expect(versions).toContain('copy `videos/main` to `videos/<id>`');
    expect(versions).toMatch(/change one thing in each/);
    // Claims without a source stay off screen, as the Agent's standards require.
    expect(agent.standards.join(' ')).toMatch(/claim with no source stays off screen/i);
    expect(marketing).toMatch(/need a source the user or the page gave/);
  });

  it('keeps a short ad from going silent or ending as slides, and says what a check flagged', () => {
    // 2026-11-12 live brand ad: two clips, then three flat text cards still for ~3.5 s each,
    // no music and no voice; the checks flagged both and the reply mentioned neither.
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    const audio = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/audio.md'), 'utf8')
      .replace(/\s+/g, ' ');
    const music = audio.split('## Music')[1]?.split('## Narration')[0] ?? '';
    expect(music).toMatch(/do not deliver a silent ad unless the user asked for none/);
    expect(music).toMatch(/short voice-over made with `generate_speech`/);
    // Two free reruns read "narration" as caption text and still shipped no audio track.
    const make = guide.split('## 3. Make')[1]?.split('## 4. Check')[0] ?? '';
    expect(make).toMatch(/An ad goes out with sound unless the user asked for none/);
    expect(make).toMatch(/`narration\.text` alone only shows captions/);
    expect(music).not.toMatch(/deliver without music and say so/);
    const marketing = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/marketing.md'), 'utf8')
      .replace(/\s+/g, ' ');
    expect(marketing).toMatch(/few shots can be generated, carry them through to the end/);
    expect(marketing).toMatch(/plain text cards over a flat background reads as slides/);

    // The reply names what the real checks flagged and was kept.
    const delivery = guide.split('## 5. Deliver')[1].split('## When to stop and ask')[0];
    expect(delivery).toMatch(/a check flagged that you kept rather than fixed/);
    const checks = ['video_timeline_render.ts', 'video_timeline_ship.ts']
      .map((name) => fs.readFileSync(path.join(pcRoot, 'src/main/features', name), 'utf8')).join('\n');
    for (const code of ['SCENE_MOSTLY_EMPTY', 'DELIVERY_MOSTLY_STATIC']) expect(checks).toContain(`'${code}'`);
  });

  it('keeps configured-service preflight and bounded external spending separate from private credits', () => {
    const spend = agent.workflow.split('### 4. Spend')[1].split('### 5.')[0];
    expect(spend).toContain('video.request_budget');
    expect(spend).toMatch(/configured services/);
    expect(spend).toMatch(/cannot verify prices or balances/);
    expect(spend).toMatch(/user.s authorization once/);
    const stops = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8').split('## When to stop and ask')[1].split('## Changing a video')[0];
    expect(stops).toMatch(/paid image or video.*authorization/i);
    expect(modelText.some(row => /host shows.*price|available credits|credits_per_second|music_capabilities|separation_capabilities|music_status|separation_status/.test(row.text))).toBe(false);
  });

  it('routes presenter videos and selling formats to their on-demand guidance', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    const writing = guide.split('## 2. Material')[0];
    expect(writing).toContain('(@skill/video-craft/references/presenter.md)');
    const craft = fs.readFileSync(path.join(packageDir, 'skills/video-craft/SKILL.md'), 'utf8');
    expect(craft).toContain('(references/presenter.md)');

    const presenter = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/presenter.md'), 'utf8')
      .replace(/\s+/g, ' ');
    expect(presenter).toMatch(/not claim experience/);
    // A presenter and the product travel as references on every clip, which the built-in
    // H3 route accepts several of, unlike a first frame paired with references.
    expect(presenter).toMatch(/Pass references rather than a first frame/);
    expect(videoModelSpec('minimax', 'MiniMax-H3-Lite')?.images).toBeGreaterThanOrEqual(2);
    expect(presenter).toMatch(/offer to add a small visible label/);

    const commerce = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/ecommerce.md'), 'utf8')
      .replace(/\s+/g, ' ');
    const formats = commerce.split('## Common formats')[1]?.split('## Where it runs')[0] ?? '';
    expect(formats).toContain('(presenter.md)');
    expect(formats).toContain('(@skill/stage-decide)');
    expect(formats).toMatch(/a generated scene can show use, not a test result/);
    const placements = commerce.split('## Where it runs')[1]?.split('## Product continuity')[0] ?? '';
    expect(placements).toMatch(/Amazon listing video: no prices/);
  });

  it('routes music montages to guidance whose beat check the shipped scripts run', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    expect(guide.split('## 2. Material')[0]).toContain('(@skill/video-craft/references/music-cut.md)');
    const craft = fs.readFileSync(path.join(packageDir, 'skills/video-craft/SKILL.md'), 'utf8');
    expect(craft).toContain('(references/music-cut.md)');
    const music = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/music-cut.md'), 'utf8').replace(/\s+/g, ' ');
    expect(music).toMatch(/Never add up a fixed beat length/);
    // The delivery checks the beat itself when told the video is cut to it (2026-11-13: the
    // runs that skipped their own check, or ran it and shipped anyway, all drifted off it).
    expect(music).toMatch(/Deliver with `video\.ship` and `"cut_to_beat": true`/);
    const ship = fs.readFileSync(path.join(pcRoot, 'src/main/model/core-agent/video-timeline-tool.ts'), 'utf8');
    expect(ship).toMatch(/cut_to_beat: \{ type: 'boolean'/);
    const analyze = fs.readFileSync(path.join(packageDir, 'skills/stage-edit/scripts/analyze_media.js'), 'utf8');
    expect(analyze).toMatch(/new Set\(\[[^\]]*'beats'/);
    expect(music).toContain('--fps');
    expect(analyze).toContain("'--fps'");
  });

  it('routes clips from long recordings to guidance whose framing the shipped scripts accept', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    expect(guide.split('## 2. Material')[0]).toContain('(@skill/stage-decide/references/clips.md)');
    const decide = fs.readFileSync(path.join(packageDir, 'skills/stage-decide/SKILL.md'), 'utf8');
    expect(decide).toContain('(references/clips.md)');

    const clips = fs.readFileSync(path.join(packageDir, 'skills/stage-decide/references/clips.md'), 'utf8')
      .replace(/\s+/g, ' ');
    expect(clips).toMatch(/Never write a time you did not read there/);
    expect(clips).toMatch(/rank all the candidates against each other/);
    expect(clips).toMatch(/Fewer clips than asked for is a fine answer/);
    expect(clips).toMatch(/If the line answers a question, start on the question/);
    expect(clips).toMatch(/says only what the clip says/);
    // The framing it describes is what the shipped scripts parse.
    const edit = fs.readFileSync(path.join(packageDir, 'skills/stage-edit/scripts/edit_video.js'), 'utf8');
    const analyze = fs.readFileSync(path.join(packageDir, 'skills/stage-edit/scripts/analyze_media.js'), 'utf8');
    expect(clips).toContain('--plan');
    expect(edit).toContain("'--plan'");
    expect(clips).toContain('--regions');
    expect(analyze).toContain("'--regions'");
    expect(analyze).toMatch(/new Set\(\[[^\]]*'activity'/);
  });

  it('routes explainers and tutorials to guidance whose sourcing tools the Agent can load', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    expect(guide.split('## 2. Material')[0]).toContain('(@skill/video-craft/references/explainer.md)');
    const craft = fs.readFileSync(path.join(packageDir, 'skills/video-craft/SKILL.md'), 'utf8');
    expect(craft).toContain('(references/explainer.md)');
    const edit = fs.readFileSync(path.join(packageDir, 'skills/stage-edit/SKILL.md'), 'utf8');
    expect(edit).toContain('(@skill/video-craft/references/explainer.md)');

    const explainer = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/explainer.md'), 'utf8')
      .replace(/\s+/g, ' ');
    expect(explainer).toMatch(/State only what a source says/);
    expect(explainer).toMatch(/A claim you cannot source stays off screen/);
    expect(explainer).toMatch(/compute bar heights, positions and labels from it/);
    expect(explainer).toMatch(/Blur tokens, keys, emails/);
    // The guidance sends the Agent to the web tools; a named Agent may load that group
    // on demand even though its persisted tool list does not name it.
    expect(explainer).toContain('`web_search`');
    expect(AGENT_FALLBACK_TOOL_GROUP_IDS).toContain('web');
    expect(toolNamesForGroups(['web'])).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
  });

  it('routes commentary recaps to guidance whose assembly the edit scripts accept', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    expect(guide.split('## 2. Material')[0]).toContain('(@skill/video-craft/references/commentary.md)');
    const craft = fs.readFileSync(path.join(packageDir, 'skills/video-craft/SKILL.md'), 'utf8');
    expect(craft).toContain('(references/commentary.md)');

    const commentary = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/commentary.md'), 'utf8')
      .replace(/\s+/g, ' ');
    expect(commentary).toMatch(/ask whether they hold the rights or a licence/);
    expect(commentary).toMatch(/Facts come only from the episodes supplied/);
    expect(commentary).toMatch(/over about 2 minutes shows the narration for review before it is voiced/);
    expect(commentary).toMatch(/never let the picture run on into the next scene/);
    // Every flag the assembly names is one the shipped scripts parse.
    const edit = fs.readFileSync(path.join(packageDir, 'skills/stage-edit/scripts/edit_video.js'), 'utf8');
    for (const flag of ['--audio-segments', '--on-existing-audio', '--duck']) {
      expect(commentary).toContain(flag);
      expect(edit).toContain(`'${flag}'`);
    }
    const analyze = fs.readFileSync(path.join(packageDir, 'skills/stage-edit/scripts/analyze_media.js'), 'utf8');
    expect(commentary).toContain('`analyze_media --op phrases`');
    expect(analyze).toMatch(/new Set\(\[[^\]]*'phrases'/);
  });

  it('numbers the craft sections without gaps, as the generation guide cites them', () => {
    const craft = fs.readFileSync(path.join(packageDir, 'skills/video-craft/SKILL.md'), 'utf8');
    const numbers = [...craft.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    const titles = new Map([...craft.matchAll(/^## (\d+)\. (.+)$/gm)].map((match) => [match[1], match[2]]));
    const generation = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/generation.md'), 'utf8');
    const cited = /`video-craft` §(\d+) and §(\d+)/.exec(generation);
    expect(cited).not.toBeNull();
    expect(titles.get(cited![1])).toMatch(/^Shot & camera language/);
    expect(titles.get(cited![2])).toMatch(/^Generation-prompt writing/);
  });

  it('routes sales creative to the private commerce owner before timeline authoring', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    const material = guide.split('## 2. Material')[1]?.split('## 3. Make')[0] ?? '';
    const writing = guide.split('## 2. Material')[0];
    expect(writing).toContain('(@skill/video-craft)');
    expect(writing).toContain('(@skill/video-craft/references/ecommerce.md)');
    expect(material).toMatch(/above|creative guidance/i);
    expect(fs.existsSync(path.join(packageDir, 'skills/video-craft/references/ecommerce.md'))).toBe(true);
    // A plain cut must still have its existing direct route; the sales handoff
    // does not impose a commerce workflow on every edit.
    const commerce = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/ecommerce.md'), 'utf8');
    expect(commerce).toContain('A one-step edit still goes directly to `stage-edit`');
  });

  it('routes short films to their on-demand story guidance before any script is written', () => {
    // The Commander selects on the description alone, so a story request must find the Agent there.
    expect(agent.description_zh).toMatch(/剧情短片/);
    expect(agent.description_en).toMatch(/short films/);
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    const writing = guide.split('## 2. Material')[0];
    expect(writing).toContain('(@skill/video-craft/references/short-film.md)');
    const craft = fs.readFileSync(path.join(packageDir, 'skills/video-craft/SKILL.md'), 'utf8');
    expect(craft).toContain('(references/short-film.md)');
    // The character method once lived in a Skill this package no longer ships.
    expect(craft).not.toMatch(/consistency skill/i);
    const generation = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/generation.md'), 'utf8');
    expect(generation).toContain('(@skill/video-craft/references/short-film.md)');
  });

  it('routes a video to recreate to its reference guidance before any script is written', () => {
    // The Commander selects on the description alone, so "recreate this video" must find the Agent there.
    expect(agent.description_zh).toMatch(/参考视频.*复刻/);
    expect(agent.description_en).toMatch(/recreating a reference video/);
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    const brief = guide.split('## 1. Brief')[1].split('## 2. Material')[0];
    expect(brief).toContain('(@skill/design-system-importer)');
    expect(agent.skill_list).toContain('design-system-importer');
    const importer = fs.readFileSync(path.join(packageDir, 'skills/design-system-importer/SKILL.md'), 'utf8');
    expect(importer).toContain('(@skill/video-craft/references/reference-recreation.md)');
    expect(fs.existsSync(path.join(packageDir, 'skills/video-craft/references/reference-recreation.md'))).toBe(true);
  });

  it('keeps supplied music provenance and reference style without claiming hosted audio generation', () => {
    const audio = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/audio.md'), 'utf8').replace(/\s+/g, ' ');
    const music = audio.split('## Music')[1]?.split('## Narration')[0] ?? '';
    expect(music).toMatch(/licensed track the user supplies/);
    expect(music).toMatch(/source and license/);
    expect(music).toContain('generate_speech');
    expect(music).not.toMatch(/music_capabilities|action.*music|credits|task receipt/);
    const recreation = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/reference-recreation.md'), 'utf8').replace(/\s+/g, ' ');
    expect(recreation).toContain('audio.bpm');
    expect(recreation).toMatch(/take the audio's style, not its detail/);
  });

  it('keeps the story guidance within what the built-in service and the timeline accept', () => {
    const story = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/short-film.md'), 'utf8')
      .replace(/\s+/g, ' ');
    // The built-in service refuses an opening frame sent with reference images, so the
    // guidance has to offer them apart rather than as one call.
    expect(videoFrameSupport('minimax', 'MiniMax-H3-Lite').withReferences).toBe(false);
    expect(story).toContain('reference images or a first frame, not both');
    expect(story).toContain('`first_frame`');

    // Speech stays on the clip's own sound; the caption comes from narration text with
    // no voice asset, which the timeline must accept as written.
    expect(story).toContain('"audio": "keep"');
    expect(story).toMatch(/`narration\.text` to the line with no `asset`/);
    const dialogue = {
      schema_version: 3, id: 'main', label: 'Rain delivery',
      canvas: { width: 1080, height: 1920, fps: 30, language: 'zh-CN' },
      scenes: [{
        id: 'door',
        clips: [{ id: 'door-talk', asset: 'door-talk', in: 0, dur: 4, audio: 'keep' }],
        narration: { text: '药放门口了，您记得吃。' },
      }],
      captions: { enabled: true },
    };
    const accepted = parseVideoManifest(dialogue);
    expect(accepted.issues).toEqual([]);
    expect(accepted.manifest?.scenes[0].narration?.asset).toBeUndefined();
    // Look-alike: a caption with no words is refused, so the oracle is not accepting everything.
    const empty = { ...dialogue, scenes: [{ ...dialogue.scenes[0], narration: { text: ' ' } }] };
    expect(parseVideoManifest(empty).issues).not.toEqual([]);
  });

  it('keeps music and printed words out of generated clips when a service always returns sound', () => {
    // MiniMax H3 cannot make a silent clip; a live 2026-11-12 H3 Lite take printed its
    // spoken line onto the picture. Music and captions belong to the timeline.
    expect(videoModelSpec('minimax', 'MiniMax-H3-Lite')?.silent).toBe(false);
    expect(videoModelSpec('doubao', 'doubao-seedance-2-5-260628')?.silent).toBe(true);
    const generation = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/generation.md'), 'utf8')
      .replace(/\s+/g, ' ');
    const prompting = generation.split('## Writing the prompt')[1]?.split('## Judging')[0] ?? '';
    expect(prompting).toMatch(/always return sound/);
    expect(prompting).toContain('"No music"');
    expect(prompting).toContain('"No on-screen text or subtitles"');

    // A recurring person is carried by the same words in every prompt and shot, and a
    // spoken line names its speaker and language around the quoted words.
    const story = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/short-film.md'), 'utf8')
      .replace(/\s+/g, ' ');
    expect(story).toMatch(/look line word for word into every prompt/);
    expect(story).toMatch(/says in Mandarin Chinese: "[^"]+"/);
    // The cast sheet comes before the budget check, the step every plan takes (2026-11-14: 0/3 plans
    // wrote it when it was only "before the first generation", 3/3 after), and the guide
    // shows a shot with the look lines pasted in.
    expect(story).toContain('Write `cast.md` in the production before you check service availability with `video.request_budget`');
    expect(story).toMatch(/hard cut: 30 岁左右的外卖小哥，瘦高，黄色雨衣，黑色头盔/);
    const consistent = generation.split('## Consistent characters')[1] ?? '';
    expect(consistent).toContain('write `cast.md` with a look line for each before checking service availability');
  });

  it('keeps the old ad recipe from overriding source-aware commercial direction', () => {
    const ads = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/ads.md'), 'utf8');
    const source = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/product-source.md'), 'utf8');
    const timeline = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/timeline.md'), 'utf8');
    expect(ads).toContain('(@skill/video-craft)');
    expect(ads).toContain('(@skill/video-craft/references/ecommerce.md)');
    expect(ads).not.toContain('**Show it working.**');
    expect(ads).not.toContain('Large empty areas read as unfinished');
    expect(source).not.toContain('at least ~40% of the frame');
    expect(timeline).not.toContain('Something on screen should move or change at least every 2 seconds');
    expect(timeline).toContain('Preserve requested framing and intentional negative space');
  });

  it('owns final script fact review after timing edits in the on-demand commerce reference', () => {
    const commerce = fs.readFileSync(path.join(packageDir, 'skills/video-craft/references/ecommerce.md'), 'utf8');
    const review = (commerce.split('## Candidate inspection')[1] ?? '').replace(/\s+/g, ' ');
    expect(review).toMatch(/last timing revision.*final narration/i);
    expect(review).toMatch(/timing.*revis|revis.*timing/i);
    expect(review).toMatch(/narration.*captions.*actions/i);
    expect(review).toMatch(/conditional shooting idea.*definite consumer promise/i);
    expect(review).toMatch(/compare.*supplied material/i);
    expect(review).toMatch(/claim that outpaces.*source/i);
    expect(review).toMatch(/without.*extra approval stage/i);
    // The commercial review stays out of the general role and timing tool.
    expect(agent.workflow).not.toContain('conditional production notes');
    const timing = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/script-timing.md'), 'utf8');
    expect(timing).not.toContain('conditional production notes');
  });

  it('owns flexible timed writing and final-text reconciliation in the private timing reference', () => {
    const timing = fs.readFileSync(path.join(packageDir, 'skills/video-studio/references/script-timing.md'), 'utf8').replace(/\s+/g, ' ');
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(timing).toMatch(/before drafting.*main message/i);
    expect(timing).toMatch(/visual.*spoken.*together/i);
    expect(timing).toMatch(/time.*flexible|flexible.*time/i);
    expect(timing).toMatch(/final.*spoken lines.*times.*estimated input/i);
    expect(timing).toMatch(/apply.*edits.*delivered script/i);
    expect(timing).toMatch(/advisory.*not.*export gate/i);
    expect(guide).toMatch(/script-timing\.md.*before drafting/i);
    expect(agent.workflow).not.toContain('timing_review');
  });

  it('distinguishes operation success from advisory visual findings without a new approval stop', () => {
    const guide = fs.readFileSync(path.join(packageDir, 'skills/video-studio/SKILL.md'), 'utf8');
    expect(guide).toContain('`ok` means the operation succeeded');
    expect(guide).toContain('`visual_review`');
    expect(guide).toContain('advisory');
    expect(guide).not.toContain('If it says `needs_work`, fix that too before rendering');
  });
  it('passes the quality validator with no extreme red flags', () => {
    const report = validateAgentSpec({ agentJson: agent });
    expect(report.violations.filter((violation) => violation.level === 'EXTREME')).toEqual([]);
  });

  it('declares the contract this App speaks, and an App version that exists', () => {
    expect(agent.video_studio_contract).toBe(VIDEO_STUDIO_TOOL_CONTRACT);
    const appVersion = JSON.parse(fs.readFileSync(path.join(pcRoot, 'package.json'), 'utf8')).version as string;
    expect(compareVersions(agent.min_app_version, appVersion)).toBeLessThanOrEqual(0);
  });

  it('asks for only what a seller has to say', () => {
    expect(agent.inputs.map((input: { id: string }) => input.id)).toEqual(['topic']);
  });

  it('declares exactly the skills it ships', () => {
    const shipped = fs.readdirSync(path.join(packageDir, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packageDir, 'skills', entry.name, 'SKILL.md')))
      .map((entry) => entry.name);
    expect([...agent.skill_list].sort()).toEqual([...shipped].sort());
  });

  it('links only to references that exist', () => {
    const broken = skillFiles.flatMap((file) => {
      const links = [...fs.readFileSync(file, 'utf8').matchAll(/\]\((references\/[^)#\s]+)/g)].map((match) => match[1]);
      return links.filter((link) => !fs.existsSync(path.join(path.dirname(file), link)))
        .map((link) => `${path.relative(packageDir, file)} -> ${link}`);
    });
    expect(broken).toEqual([]);
  });

  it('ships the animation library a page refers to', () => {
    const vendor = fs.readFileSync(path.join(packageDir, 'skills', 'video-studio', 'assets', 'vendor', 'gsap.min.js'), 'utf8');
    for (const api of ['timeline', 'totalTime', 'totalDuration', 'timeScale']) expect(vendor).toContain(api);
    const timeline = fs.readFileSync(path.join(packageDir, 'skills', 'video-studio', 'references', 'timeline.md'), 'utf8');
    expect(timeline).toContain('assets/vendor/gsap.min.js');
  });

  it('names only operations the tool has', () => {
    const ops = new Set(toolOps());
    const unknown = modelText.flatMap(({ file, text }) => (
      [...text.matchAll(/\b(?:video|reference|product|speech)\.[a-z_]+\b/g)]
        .map((match) => match[0])
        .filter((name) => !ops.has(name) && !/^(?:video|product)\.(?:json|mp4|html|md)$/.test(name))
        .map((name) => `${file}: ${name}`)
    ));
    expect(unknown).toEqual([]);
  });

  it('holds no instruction from the retired plan and gate flow', () => {
    const retired = /composition\.[a-z_]+\b|production\.(?:status|edit|approve_plan|approve_generation|segment_qa)|stage-(?:plan|assemble|compose|generate|consistency)|gate-control|video-router|composition-design-review|plan\.json|composition-manifest|production_plan_path|production_segment_id|narration_segment_index|approve_(?:plan|draft|generation)|\bGate [A-D]\b/;
    const stale = modelText.filter(({ text }) => retired.test(text)).map(({ file, text }) => `${file}: ${retired.exec(text)?.[0]}`);
    expect(stale).toEqual([]);
  });
});
