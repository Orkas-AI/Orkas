import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// skill-registry.ts wraps core-agent's SkillLoader. To test allowlist
// filtering without pulling in the real core-agent import, we write fake
// SKILL.md files under the new skills layout and let the real SkillLoader
// scan them — the loader is pure FS + frontmatter parsing, no network/LLM.
//
// Post-refactor layout:
//   platform/builtin skills → `<WS_ROOT>/<uid>/local/marketplace/skills/<id>/SKILL.md`
//   custom skills           → `<WS_ROOT>/<uid>/cloud/skills/<id>/SKILL.md`
// The loader scans marketplace first so same-id platform/builtin overrides custom.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

function builtinDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'marketplace', 'skills');
}
function customDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'skills');
}
function systemDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'system', 'skills');
}
function systemDirFor(uid: string): string {
  return path.join(tmpDir, uid, 'local', 'system', 'skills');
}
function agentPrivateDir(agentId: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'agents', agentId, 'private_skills');
}
function agentEvolvedDir(agentId: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'agents', agentId, 'skills');
}

function writeSkill(root: string, id: string, name: string, description: string, installMeta?: Record<string, unknown>) {
  const skillDir = path.join(root, id);
  fs.mkdirSync(skillDir, { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${description}\n---\nbody`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), md);
  if (installMeta) {
    fs.writeFileSync(path.join(skillDir, '_install.json'), JSON.stringify(installMeta));
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skillreg-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  vi.doUnmock('#core-agent');
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadRegistry() {
  return import('../../../src/main/model/core-agent/skill-registry');
}

describe('skill-registry › getSystemPromptBlock(allowlist)', () => {
  it('returns full listing when allowlist is undefined (legacy behavior)', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    writeSkill(customDir(), 'summarize', 'Summarize', 'S');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('translate');
    expect(text).toContain('summarize');
  });

  it('renders only allowlisted skills when allowlist is provided', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    writeSkill(builtinDir(), 'summarize', 'Summarize', 'S');
    writeSkill(builtinDir(), 'search', 'Search', 'X');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['translate', 'search'] });
    expect(text).toContain('translate');
    expect(text).toContain('search');
    expect(text).not.toContain('summarize');
  });

  it('matches allowlist entries by display name when marketplace id differs', async () => {
    writeSkill(builtinDir(), '6bb95f967501', 'github', 'GitHub skill');
    writeSkill(builtinDir(), 'daa4378ab55a', 'find-skill', 'Find skill');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['github', 'find-skill'] });
    expect(text).toContain('**github** (Source: platform; internal read id: 6bb95f967501)');
    expect(text).toContain('**find-skill** (Source: platform; internal read id: daa4378ab55a)');
    expect(text).not.toContain('(id: 6bb95f967501)');
  });

  it('returns empty string when allowlist is [] (agent opting out of all skills)', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: [] });
    expect(text).toBe('');
  });

  it('still renders the acting agent private skills under an empty allowlist', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    writeSkill(agentPrivateDir('agent-a'), 'private-helper', 'private-helper', 'private help');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ agentId: 'agent-a', allowlist: [] });
    expect(text).toContain('private-helper');
    expect(text).not.toContain('translate');
  });

  it('does not render self-evolved skills — core-agent evolution injects those, not this block', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    writeSkill(agentEvolvedDir('agent-a'), 'evolved-helper', 'evolved-helper', 'evolved help');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ agentId: 'agent-a', allowlist: [] });
    // Self-evolved skills (cloud/agents/<id>/skills) are surfaced by core-agent's
    // evolution SkillStore.buildIndex(); rendering them here too would double-inject.
    expect(text).not.toContain('evolved-helper');
    expect(text).not.toContain('translate');
  });

  it('preserves allowlist order when mixing agent-scoped and trusted skills', async () => {
    writeSkill(customDir(), 'selected-helper', 'selected-helper', 'selected help');
    writeSkill(agentPrivateDir('agent-a'), 'default-helper', 'default-helper', 'default help');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      agentId: 'agent-a',
      allowlist: ['default-helper', 'selected-helper'],
      forceOpenSkillRefs: ['selected-helper'],
    });
    expect(text.indexOf('default-helper')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('selected-helper')).toBeGreaterThan(text.indexOf('default-helper'));
  });

  it('silently drops unknown ids in the allowlist', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['translate', 'nonexistent'] });
    expect(text).toContain('translate');
    expect(text).not.toContain('nonexistent');
  });

  it('returns empty string when allowlist provided but no matching skills exist', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['nonexistent'] });
    expect(text).toBe('');
  });

  // Regression: per-uid migration (CLAUDE.md §4) made both skill roots end
  // in `/skills`, so deriving the `Source` tag from basename collapses to
  // `skills` for every entry. `chat_commander.md` / `chat_agent_in_group.md`
  // tell the LLM to pick a root by `Source: builtin|platform|custom` — a degenerate label
  // sends it guessing and half the SKILL.md reads ENOENT on first try.
  it('labels `Source` as platform vs custom by root path, not basename', async () => {
    writeSkill(builtinDir(), 'shipped', 'Shipped', 'desc-platform');
    writeSkill(customDir(), 'mine', 'Mine', 'desc-custom');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('Source: platform');
    expect(text).toContain('Source: custom');
    expect(text).not.toContain('Source: skills');
  });

  it('labels packaged seed skills as builtin from install metadata', async () => {
    writeSkill(builtinDir(), 'seeded', 'Seeded', 'desc-builtin', { seed_source: 'builtin' });
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('**Seeded** (Source: builtin; internal read id: seeded) — desc-builtin');
  });

  // The block embeds a Read-pattern header with resolved ROOT values for
  // both sources + an anti-prior warning. Without these, the LLM falls back
  // on training-prior layouts (e.g. `/data/custom/skills/<id>/`) and trips
  // E_PATH_OUT_OF_SCOPE on `read_file`. See bus.ts substitution map cleanup
  // — `$builtin_skills_dir / $custom_skills_dir` no longer flow through the
  // prompt template, so this header IS the only place the LLM learns the
  // real root paths.
  it('block header carries Read pattern + resolved ROOT values', async () => {
    writeSkill(builtinDir(), 'shipped', 'Shipped', 'desc-b');
    writeSkill(customDir(), 'mine', 'Mine', 'desc-c');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('`read_file(<ROOT>/<id>/SKILL.md)`');
    expect(text).toContain(`- custom:  ${path.resolve(customDir())}`);
    expect(text).toContain(`- platform: ${path.resolve(builtinDir())}`);
    expect(text).toContain(`- builtin: ${path.resolve(builtinDir())}`);
    expect(text).toContain('Use these ROOT values verbatim');
    expect(text).toContain('These entries are skills, not tool names');
    expect(text).toContain('never call the display name or id as a tool');
    expect(text).toContain('Never mention skill ids');
  });

  it('block omits ROOT header when no skills are present (renderSkillLines short-circuits empty)', async () => {
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toBe('');
  });

  it('renders compact skill descriptions in the prompt across zh/en descriptions', async () => {
    writeSkill(customDir(), 'zh-long', 'ZhLong', '抓取网页并提取结构化信息；适合网页调研和数据整理；触发词：抓取、网页');
    writeSkill(customDir(), 'zh-sentence', 'ZhSentence', '分析资料并输出结论。适合深度研究。');
    writeSkill(customDir(), 'en-long', 'EnLong', 'Analyze API logs. Suitable for debugging production incidents. Triggers: logs, traces.');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('**ZhLong** (Source: custom; internal read id: zh-long) — 抓取网页并提取结构化信息');
    expect(text).toContain('**ZhSentence** (Source: custom; internal read id: zh-sentence) — 分析资料并输出结论。');
    expect(text).toContain('**EnLong** (Source: custom; internal read id: en-long) — Analyze API logs.');
    expect(text).not.toContain('触发词');
    expect(text).not.toContain('Suitable for debugging');
    expect(text).not.toContain('Triggers: logs');
  });

  it('dedupes same display-name skills with platform shadowing custom', async () => {
    writeSkill(builtinDir(), 'platform-reviewer', 'agent-static-review', 'platform desc');
    writeSkill(customDir(), 'custom-reviewer', 'agent-static-review', 'custom desc');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('**agent-static-review** (Source: platform; internal read id: platform-reviewer) — platform desc');
    expect(text).not.toContain('custom-reviewer');
    expect(text).not.toContain('custom desc');
  });

  it('keeps same display-name marketplace skills with different internal ids', async () => {
    writeSkill(builtinDir(), '111111111111', 'agent-static-review', 'first marketplace desc');
    writeSkill(builtinDir(), '222222222222', 'agent-static-review', 'second marketplace desc');
    const advertised: Array<{ id: string; system: string }> = [];
    const displayNameById = new Map<string, string>();
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      displayNameById,
      onSkillAdvertised(id, system) {
        advertised.push({ id, system });
      },
    });

    expect(text).toContain('**agent-static-review** (Source: platform; internal read id: 111111111111) — first marketplace desc');
    expect(text).toContain('**agent-static-review** (Source: platform; internal read id: 222222222222) — second marketplace desc');
    expect(advertised).toEqual([
      { id: '111111111111', system: 'A.platform' },
      { id: '222222222222', system: 'A.platform' },
    ]);
    expect(displayNameById.get('111111111111')).toBe('agent-static-review');
    expect(displayNameById.get('222222222222')).toBe('agent-static-review');
  });

  it('keeps explicitly allowlisted same-name marketplace skill ids', async () => {
    writeSkill(builtinDir(), '111111111111', 'agent-static-review', 'first marketplace desc');
    writeSkill(builtinDir(), '222222222222', 'agent-static-review', 'second marketplace desc');
    writeSkill(builtinDir(), '333333333333', 'other-skill', 'other desc');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['111111111111', '222222222222'] });

    expect(text).toContain('internal read id: 111111111111');
    expect(text).toContain('internal read id: 222222222222');
    expect(text).not.toContain('333333333333');
    expect(text).not.toContain('other desc');
  });

  it('reuses agent-private SkillLoader instances while still seeing root mtime changes', async () => {
    let constructed = 0;
    vi.doMock('#core-agent', async (importOriginal) => {
      const actual = await importOriginal<any>();
      class CountingSkillLoader extends actual.SkillLoader {
        constructor(opts: any) {
          super(opts);
          constructed++;
        }
      }
      return { ...actual, SkillLoader: CountingSkillLoader };
    });

    writeSkill(agentPrivateDir('video-studio'), 'private-one', 'private-one', 'first private skill');
    const { getSystemPromptBlock } = await loadRegistry();
    const first = await getSystemPromptBlock({ agentId: 'video-studio' });

    expect(first).toContain('private-one');
    expect(constructed).toBe(2); // trusted loader + one agent-private root loader

    writeSkill(agentPrivateDir('video-studio'), 'private-two', 'private-two', 'second private skill');
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(agentPrivateDir('video-studio'), later, later);
    const second = await getSystemPromptBlock({ agentId: 'video-studio' });

    expect(second).toContain('private-one');
    expect(second).toContain('private-two');
    expect(constructed).toBe(2);
  });

  it('lists agent-owned private and self-evolved skill ids', async () => {
    writeSkill(agentPrivateDir('video-studio'), 'private-one', 'private-one', 'first private skill');
    writeSkill(agentEvolvedDir('video-studio'), 'evolved-one', 'evolved-one', 'first evolved skill');
    const { listAgentOwnedSkillIds } = await loadRegistry();
    await expect(listAgentOwnedSkillIds(TEST_UID, 'video-studio')).resolves.toEqual([
      'private-one',
      'evolved-one',
    ]);
  });
});

describe('skill-registry › getSystemSkillsPromptBlock', () => {
  it('renders system skills in a separate block with SYSTEM_SKILLS_ROOT', async () => {
    writeSkill(systemDir(), 'agent-creator', 'agent-creator', 'Create agents');
    writeSkill(systemDir(), 'autotask-creator', 'autotask-creator', 'Create automations');
    writeSkill(systemDir(), 'package-installer', 'package-installer', 'Install packages');
    writeSkill(systemDir(), 'skill-creator', 'skill-creator', 'Create skills');
    const { getSystemSkillsPromptBlock, getSystemPromptBlock } = await loadRegistry();

    const systemText = await getSystemSkillsPromptBlock();
    expect(systemText).toContain('## System skills');
    expect(systemText).toContain('SYSTEM_SKILLS_ROOT');
    expect(systemText).toContain(path.resolve(systemDir()));
    expect(systemText).toContain('**agent-creator**');
    expect(systemText).toContain('**autotask-creator**');
    expect(systemText).toContain('**package-installer**');
    expect(systemText).toContain('**skill-creator**');

    const regularText = await getSystemPromptBlock();
    expect(regularText).not.toContain('agent-creator');
    expect(regularText).not.toContain('autotask-creator');
    expect(regularText).not.toContain('package-installer');
    expect(regularText).not.toContain('skill-creator');
  });

  it('uses an explicit user id for SYSTEM_SKILLS_ROOT', async () => {
    const otherUid = 'u2';
    const systemSkills = await import('../../../src/main/features/system_skills');
    const { getSystemSkillsPromptBlock } = await loadRegistry();
    await systemSkills.reconcileAllForUser(otherUid);

    const systemText = await getSystemSkillsPromptBlock(otherUid);
    expect(systemText).toContain(path.resolve(systemDirFor(otherUid)));
    expect(systemText).not.toContain(path.resolve(systemDir()));
    expect(fs.existsSync(path.join(systemDirFor(otherUid), 'agent-creator', 'SKILL.md'))).toBe(true);
  });
});

describe('skill-registry › replaceKnownSkillIdsForDisplay', () => {
  it('rewrites known marketplace ids to display names with token boundaries', async () => {
    const { replaceKnownSkillIdsForDisplay } = await loadRegistry();
    const text = replaceKnownSkillIdsForDisplay(
      'skill: follow the `16e1bfcb3426` skill; leave x16e1bfcb3426y alone',
      [{ id: '16e1bfcb3426', name: 'agent-creator' }],
    );
    expect(text).toBe('skill: follow the `agent-creator` skill; leave x16e1bfcb3426y alone');
  });

  it('normalizes skill follow phrasing to a compact display reference', async () => {
    const { normalizeKnownSkillRefsForDisplay } = await loadRegistry();
    const text = normalizeKnownSkillRefsForDisplay(
      '`skill: follow the 16e1bfcb3426 skill` — create agents',
      [{ id: '16e1bfcb3426', name: 'agent-creator' }],
    );
    expect(text).toBe('`agent-creator` skill — create agents');
  });
});

describe('skill-registry › compactPromptDescription', () => {
  // The commander's "Agents list" and skill list inject this compacted entry.
  // The bug it guards: an agent/skill whose FIRST sentence is a throwaway
  // tagline (ends with 。 before the real capability + routing guidance) used to
  // collapse to that 9-char tagline, so the commander never saw the routing
  // instruction and self-served the task instead of dispatching.

  it('keeps a substantive first sentence as-is (the common, adequate case)', async () => {
    const { compactPromptDescription } = await loadRegistry();
    const desc =
      '办公写作与交付入口：把用户想做、想改、想整理的办公材料落成可交付文档、表格、演示或 PDF；适合写报告。触发词：写文档';
    // `；适合` marker fires → cut before the 适合 tail; unchanged by the floor.
    expect(compactPromptDescription(desc)).toBe(
      '办公写作与交付入口：把用户想做、想改、想整理的办公材料落成可交付文档、表格、演示或 PDF',
    );
  });

  it('extends a too-short tagline-first description past the tagline (the floor)', async () => {
    const { compactPromptDescription } = await loadRegistry();
    const desc =
      '做视频，也剪视频。三条产线：①解说②AI 生成③剪辑你上传的真实视频。' +
      '凡是“对一段已有视频做处理”的都路由到它，而不是 commander 自己拿命令行拼。' +
      '适合“做个动画”。触发词：做视频、加字幕、剪辑';
    const out = compactPromptDescription(desc);
    // Must not collapse to the 9-char "做视频，也剪视频。" tagline …
    expect(out.length).toBeGreaterThan('做视频，也剪视频。'.length);
    // … must carry the routing instruction the commander needs …
    expect(out).toContain('路由到它');
    // … and must stop before the 适合/触发词 enumeration (recognising the 。
    // delimiter the ；-only markers miss), not bleed the whole description in.
    expect(out).not.toContain('适合');
    expect(out).not.toContain('触发');
  });

  it('does not over-extend a short BUT complete description (no tail to add)', async () => {
    const { compactPromptDescription } = await loadRegistry();
    // Below the floor length, but there is nothing after it — return as-is,
    // never pad from absent content.
    expect(compactPromptDescription('查天气。')).toBe('查天气。');
  });

  it('preserves the existing English ". Triggers"/"。触发词" marker cut', async () => {
    const { compactPromptDescription } = await loadRegistry();
    const en =
      'Makes and edits videos for you across explainer, generated footage, and real-clip editing. Triggers: make a video, add captions, edit video';
    // Long-enough lead → floor never fires; period-keyword marker still trims
    // the Triggers tail (regression guard on the original behavior).
    expect(compactPromptDescription(en)).toBe(
      'Makes and edits videos for you across explainer, generated footage, and real-clip editing.',
    );
  });

  it('caps a runaway extension at a sentence boundary', async () => {
    const { compactPromptDescription } = await loadRegistry();
    // Tagline first, then many sentences and NO 适合/触发 section → the floor
    // extends but must clip at a 。 under the hard cap, not return 1000 chars.
    const long = '短。' + '这是一段没有触发段的很长描述内容用来测试上限。'.repeat(40);
    const out = compactPromptDescription(long);
    expect(out.length).toBeGreaterThan('短。'.length);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith('。')).toBe(true);
  });

  it('returns empty string for empty/whitespace input', async () => {
    const { compactPromptDescription } = await loadRegistry();
    expect(compactPromptDescription('   ')).toBe('');
    expect(compactPromptDescription('')).toBe('');
  });
});
