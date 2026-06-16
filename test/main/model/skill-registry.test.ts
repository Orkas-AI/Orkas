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
//   platform skills → `<WS_ROOT>/<uid>/local/marketplace/skills/<id>/SKILL.md`
//   custom skills   → `<WS_ROOT>/<uid>/cloud/skills/<id>/SKILL.md`
// The loader scans `[userSkillsDir(activeUid), userMarketplaceSkillsDir(activeUid)]`,
// with custom listed first so same-id custom overrides platform.

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

function writeSkill(root: string, id: string, name: string, description: string) {
  const skillDir = path.join(root, id);
  fs.mkdirSync(skillDir, { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${description}\n---\nbody`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), md);
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
    expect(text).toContain('**github** (Source: builtin; internal read id: 6bb95f967501)');
    expect(text).toContain('**find-skill** (Source: builtin; internal read id: daa4378ab55a)');
    expect(text).not.toContain('(id: 6bb95f967501)');
  });

  it('returns empty string when allowlist is [] (agent opting out of all skills)', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: [] });
    expect(text).toBe('');
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
  // tell the LLM to pick a root by `Source: builtin|custom` — a degenerate label
  // sends it guessing and half the SKILL.md reads ENOENT on first try.
  it('labels `Source` as builtin vs custom by root path, not basename', async () => {
    writeSkill(builtinDir(), 'shipped', 'Shipped', 'desc-builtin');
    writeSkill(customDir(), 'mine', 'Mine', 'desc-custom');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('Source: builtin');
    expect(text).toContain('Source: custom');
    expect(text).not.toContain('Source: skills');
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

  it('dedupes same display-name skills with custom shadowing builtin', async () => {
    writeSkill(builtinDir(), 'builtin-reviewer', 'agent-static-review', 'builtin desc');
    writeSkill(customDir(), 'custom-reviewer', 'agent-static-review', 'custom desc');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('**agent-static-review** (Source: custom; internal read id: custom-reviewer) — custom desc');
    expect(text).not.toContain('builtin-reviewer');
    expect(text).not.toContain('builtin desc');
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

    expect(text).toContain('**agent-static-review** (Source: builtin; internal read id: 111111111111) — first marketplace desc');
    expect(text).toContain('**agent-static-review** (Source: builtin; internal read id: 222222222222) — second marketplace desc');
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
