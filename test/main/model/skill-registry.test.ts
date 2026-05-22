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
