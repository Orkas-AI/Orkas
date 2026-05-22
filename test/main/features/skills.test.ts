import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// skills.ts pulls path constants + the module-level _skillListCache at load.
// Reset ORKAS_WORKSPACE_ROOT + module graph per test for isolation.

// Swap the LLM stream impl per test — same pattern as chats.test.ts /
// agents.test.ts so streamSendToSkillChat tests can feed synthetic finals.
const streamImpl: { current: null | ((opts: any) => AsyncGenerator<any, void, unknown>) } = { current: null };
vi.mock('../../../src/main/model/client', () => ({
  streamChatWithModel: (opts: any) => {
    if (streamImpl.current) return streamImpl.current(opts);
    return (async function* () { /* empty */ })();
  },
  chatWithModel: vi.fn(async () => ({ ok: true, text: 'ok', error: '', aborted: false })),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skills-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  streamImpl.current = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSkills() {
  return import('../../../src/main/features/skills');
}

function customSkillsDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'skills');
}

function builtinSkillsDir(): string {
  // Platform (marketplace-installed) skills live under <uid>/local/marketplace/skills/.
  return path.join(tmpDir, TEST_UID, 'local', 'marketplace', 'skills');
}

function writeCustomSkill(id: string, frontmatter = `name: "${id}"\ndescription: "test"`, body = '# body'): void {
  const d = path.join(customSkillsDir(), id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`);
}

describe('skills › parseSkillFrontmatter', () => {
  it('extracts unquoted scalars', async () => {
    const s = await loadSkills();
    const meta = s.parseSkillFrontmatter('---\nname: agent-browser\ndescription: A tool\n---\nbody');
    expect(meta.name).toBe('agent-browser');
    expect(meta.description).toBe('A tool');
  });

  it('unescapes double-quoted values with \\n / \\"', async () => {
    const s = await loadSkills();
    const meta = s.parseSkillFrontmatter('---\ndescription: "line1\\nline2 with \\"quote\\""\n---');
    expect(meta.description).toBe('line1\nline2 with "quote"');
  });

  it('handles single-quoted with doubled quote escape', async () => {
    const s = await loadSkills();
    const meta = s.parseSkillFrontmatter("---\ndescription: 'it''s fine'\n---");
    expect(meta.description).toBe("it's fine");
  });

  it('skips indented continuation lines and list items', async () => {
    const s = await loadSkills();
    const meta = s.parseSkillFrontmatter(
      '---\nname: x\nallowed-tools:\n  - tool1\n  - tool2\n- bare\n---'
    );
    expect(meta.name).toBe('x');
    expect(meta['allowed-tools']).toBeUndefined();
  });

  it('returns empty object when no frontmatter fence', async () => {
    const s = await loadSkills();
    expect(s.parseSkillFrontmatter('no frontmatter\nhere')).toEqual({});
  });

  it('silently ignores legacy external_deps block (field removed from spec)', async () => {
    const s = await loadSkills();
    const meta = s.parseSkillFrontmatter([
      '---',
      'name: x',
      'description: d',
      'external_deps:',
      '  - "yt-dlp (CLI) — 缺失时 YouTube 空结果"',
      '---',
    ].join('\n'));
    // external_deps is no longer parsed; name + description still extracted.
    expect(meta.name).toBe('x');
    expect(meta.description).toBe('d');
  });
});

describe('skills › splitSkillMd', () => {
  it('separates meta + body for well-formed file', async () => {
    const s = await loadSkills();
    const r = s.splitSkillMd('---\nname: n\ndescription: d\n---\n\nbody text');
    expect(r.meta.name).toBe('n');
    expect(r.body).toBe('body text');
  });

  it('returns whole text as body when no frontmatter', async () => {
    const s = await loadSkills();
    const r = s.splitSkillMd('just body');
    expect(r.body).toBe('just body');
    expect(r.meta).toEqual({});
  });
});

describe('skills › skillMdContent', () => {
  it('escapes embedded quotes in name/description', async () => {
    const s = await loadSkills();
    // Legacy single-string description (English) routes to description_en.
    const md = s.skillMdContent('Weird "name"', 'desc with "quote"');
    expect(md).toContain('name: "Weird \\"name\\""');
    expect(md).toContain('description_en: "desc with \\"quote\\""');
    expect(md).toContain('description_zh: ""');
  });

  it('flattens newlines in metadata', async () => {
    const s = await loadSkills();
    const md = s.skillMdContent('a\nb', 'c\nd', 'body');
    expect(md).toContain('name: "a b"');
    expect(md).toContain('description_en: "c d"');
  });

  it('trims leading newlines from body', async () => {
    const s = await loadSkills();
    const md = s.skillMdContent('n', 'd', '\n\n\nreal body');
    expect(md).toMatch(/---\n\nreal body$/);
  });
});

describe('skills › validateSkillName', () => {
  it('accepts letter-first names with word chars', async () => {
    const s = await loadSkills();
    expect(s.validateSkillName('my_skill')).toBe('');
    expect(s.validateSkillName('Skill-1')).toBe('');
    expect(s.validateSkillName('My Skill Name')).toBe('');
  });

  it('rejects empty/too-long', async () => {
    const s = await loadSkills();
    expect(s.validateSkillName('')).toMatch(/Please enter|填写/);
    expect(s.validateSkillName('a'.repeat(65))).toMatch(/too long|过长/);
  });

  it('rejects non-letter start', async () => {
    const s = await loadSkills();
    expect(s.validateSkillName('1abc')).not.toBe('');
    expect(s.validateSkillName('_skill')).not.toBe('');
  });

  it('rejects path separators and unicode', async () => {
    const s = await loadSkills();
    expect(s.validateSkillName('foo/bar')).not.toBe('');
    expect(s.validateSkillName('我的技能')).not.toBe('');
  });

  it('rejects double spaces and leading/trailing space', async () => {
    const s = await loadSkills();
    expect(s.validateSkillName('foo  bar')).not.toBe('');
    expect(s.validateSkillName(' foo')).not.toBe('');
    expect(s.validateSkillName('foo ')).not.toBe('');
  });
});

describe('skills › isValidSkillId', () => {
  it('matches the same grammar as validateSkillName', async () => {
    const s = await loadSkills();
    expect(s.isValidSkillId('foo')).toBe(true);
    expect(s.isValidSkillId('foo bar')).toBe(true);
    expect(s.isValidSkillId('')).toBe(false);
    expect(s.isValidSkillId(null)).toBe(false);
    expect(s.isValidSkillId(42)).toBe(false);
  });
});

describe('skills › extractSkillFileBlocks', () => {
  it('returns original text when no block present', async () => {
    const s = await loadSkills();
    const r = s.extractSkillFileBlocks('just prose');
    expect(r.files).toEqual([]);
    expect(r.cleanText).toBe('just prose');
  });

  it('extracts a single file block', async () => {
    const s = await loadSkills();
    const text = 'before\n<<<skill-file path=foo.md\ncontent here\n>>>\nafter';
    const r = s.extractSkillFileBlocks(text);
    expect(r.files).toEqual([{ path: 'foo.md', content: 'content here' }]);
    expect(r.cleanText).toContain('before');
    expect(r.cleanText).toContain('after');
    expect(r.cleanText).not.toContain('<<<skill-file');
  });

  it('extracts multiple blocks', async () => {
    const s = await loadSkills();
    const text = '<<<skill-file path=a.md\nA body\n>>>\n<<<skill-file path=sub/b.md\nB body\n>>>';
    const r = s.extractSkillFileBlocks(text);
    expect(r.files.map((f) => f.path)).toEqual(['a.md', 'sub/b.md']);
    expect(r.files[0].content).toBe('A body');
  });

  it('collapses excessive blank lines left behind after removal', async () => {
    const s = await loadSkills();
    const text = 'x\n<<<skill-file path=a.md\nA\n>>>\n\n\n\ny';
    const r = s.extractSkillFileBlocks(text);
    // Trimmed result shouldn't have 3+ consecutive newlines
    expect(/\n{3,}/.test(r.cleanText)).toBe(false);
  });
});

describe('skills › extractSkillContainers', () => {
  // Pure text-munging regex around the commander's `<skill>` container.
  // Hard rule (PC/CLAUDE.md §9): set A pins real shapes the matcher must
  // accept; set B pins look-alike shapes the matcher must NOT process.
  // Adding a guard / branch later requires extending both sets — silent
  // regressions in this file have shipped before through the `<agent>`
  // strip-regex path.

  // ── Set A: real shapes (must extract) ──────────────────────────────────
  it('A1: edit container with skill_id + single SKILL.md block', async () => {
    const s = await loadSkills();
    const text = 'prose before\n<skill>\n<skill_id>foo</skill_id>\n<<<skill-file path=SKILL.md\n---\nname: "foo"\n---\n\n# body\n>>>\n</skill>\nprose after';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0].skillId).toBe('foo');
    expect(r.containers[0].files.map((f: any) => f.path)).toEqual(['SKILL.md']);
    expect(r.containers[0].files[0].content).toContain('name: "foo"');
    expect(r.cleanText).toContain('prose before');
    expect(r.cleanText).toContain('prose after');
    expect(r.cleanText).not.toContain('<skill>');
    expect(r.cleanText).not.toContain('<<<skill-file');
  });

  it('A2: create container (no skill_id) with multiple blocks', async () => {
    const s = await loadSkills();
    const text = '<skill>\n<<<skill-file path=SKILL.md\n---\nname: "abc"\ndescription_en: "desc"\n---\n\n# body\n>>>\n<<<skill-file path=scripts/foo.py\nprint("hi")\n>>>\n</skill>';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0].skillId).toBeUndefined();
    expect(r.containers[0].files.map((f: any) => f.path)).toEqual(['SKILL.md', 'scripts/foo.py']);
  });

  it('A3: skill_id with whitespace + leading blank line is trimmed', async () => {
    const s = await loadSkills();
    const text = '<skill>\n<skill_id>\n   bar  \n</skill_id>\n<<<skill-file path=SKILL.md\nbody\n>>>\n</skill>';
    const r = s.extractSkillContainers(text);
    expect(r.containers[0].skillId).toBe('bar');
  });

  it('A4: every container is parsed in emission order; all stripped from cleanText', async () => {
    const s = await loadSkills();
    const text = '<skill>\n<skill_id>first</skill_id>\n<<<skill-file path=SKILL.md\nA\n>>>\n</skill>\nmid\n<skill>\n<skill_id>second</skill_id>\n<<<skill-file path=SKILL.md\nB\n>>>\n</skill>';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toHaveLength(2);
    expect(r.containers[0].skillId).toBe('first');
    expect(r.containers[1].skillId).toBe('second');
    expect(r.cleanText).toContain('mid');
    expect(r.cleanText).not.toContain('<skill>');
  });

  // ── Set B: look-alike shapes (must NOT extract / must NOT mis-route) ───
  it('B1: bare prose without `<skill>` returns empty containers, untouched cleanText', async () => {
    const s = await loadSkills();
    const r = s.extractSkillContainers('I will write a skill that does X');
    expect(r.containers).toEqual([]);
    expect(r.cleanText).toBe('I will write a skill that does X');
  });

  it('B2: agent <skills> sub-tag must NOT match skill container', async () => {
    const s = await loadSkills();
    // The <skills> tag inside an <agent> container is a list, not the
    // commander's <skill>. Matching it would silently treat agent edits
    // as skill writes.
    const text = '<agent>\n<skills>\nfoo-skill\n</skills>\n</agent>';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toEqual([]);
    expect(r.cleanText).toBe(text);
  });

  it('B3: stray `<<<skill-file>>>` outside any `<skill>` container is left visible (LLM feedback)', async () => {
    const s = await loadSkills();
    // The block is visible prose, NOT processed. cleanText should still
    // contain it so the LLM sees it didn't take effect and self-corrects
    // next turn. Pre-emptive global stripping would silently swallow the
    // mistake.
    const text = 'before\n<<<skill-file path=foo.md\nbody\n>>>\nafter';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toEqual([]);
    expect(r.cleanText).toContain('<<<skill-file');
  });

  it('B4: unclosed `<skill>` tag is stripped from cleanText but not extracted', async () => {
    const s = await loadSkills();
    // Final-event text shouldn't have unclosed containers, but if one
    // slips through (mid-stream truncation / abort), don't extract it
    // (no closing tag = container intent unclear). Range-based clean
    // still removes the half-open tokens so naked `<skill>` doesn't
    // pollute the bubble.
    const text = '<skill>\n<skill_id>x</skill_id>\nno closing tag here';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toEqual([]);
    expect(r.cleanText).not.toContain('<skill>');
    expect(r.cleanText).not.toContain('<skill_id>');
  });

  // ── Set B (prose/code guard): containers inside code regions ──────────
  // Without this guard the LLM teaching/quoting the protocol to the user
  // — by emitting a fenced ```...``` example or an inline `<skill>...</skill>`
  // span — would falsely trigger a real skill write. This is the "agent
  // section line 229 / chat_skill_setup.md showing protocol" risk surface.

  it('B5: `<skill>` inside fenced ```xml block must NOT match', async () => {
    const s = await loadSkills();
    const text = 'Here is the format:\n```xml\n<skill>\n<skill_id>example</skill_id>\n<<<skill-file path=SKILL.md\nname: "example"\n>>>\n</skill>\n```\nThat is the shape.';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toEqual([]);
    expect(r.cleanText).toBe(text); // Untouched — it's prose teaching, not a real op.
  });

  it('B6: `<skill>` inside inline backtick span must NOT match', async () => {
    const s = await loadSkills();
    const text = 'Wrap your spec inside `<skill>...</skill>` and the system will pick it up.';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toEqual([]);
    expect(r.cleanText).toBe(text);
  });

  it('B7: real container AFTER a code-fence example — only the real one is extracted', async () => {
    const s = await loadSkills();
    // Critical: this is the failure mode the guard prevents — a naive
    // regex would match the FIRST `<skill>` (the fenced example) and
    // try to write fictional files, ignoring the real container below.
    const text = 'Format:\n```xml\n<skill>\n<skill_id>example</skill_id>\n</skill>\n```\nAnd here is the real one:\n<skill>\n<skill_id>real</skill_id>\n<<<skill-file path=SKILL.md\nbody\n>>>\n</skill>';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0].skillId).toBe('real');
    expect(r.cleanText).toContain('```xml');
    expect(r.cleanText).toContain('<skill>\n<skill_id>example</skill_id>'); // fenced example survives
  });
});

describe('skills › applySkillContainerFromCommander › create', () => {
  it('creates skill from frontmatter `name`, writes all blocks', async () => {
    const s = await loadSkills();
    const skillMdContent = '---\nname: "social-fetch"\ndescription_zh: "抓取并分析"\ndescription_en: "Fetch and analyze"\n---\n\n# When to use\n…\n';
    const r = await s.applySkillContainerFromCommander({
      files: [
        { path: 'SKILL.md', content: skillMdContent },
        { path: 'scripts/fetch.py', content: 'print("hi")\n' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('created');
    expect(r.skillId).toBe('social-fetch');
    expect(r.written).toEqual(['SKILL.md', 'scripts/fetch.py']);
    const md = fs.readFileSync(path.join(customSkillsDir(), 'social-fetch', 'SKILL.md'), 'utf8');
    expect(md).toContain('description_en: "Fetch and analyze"');
    expect(md).toContain('# When to use');
  });

  it('rejects create when SKILL.md block is missing', async () => {
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      files: [{ path: 'scripts/x.py', content: 'pass' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SKILL.md|缺少/);
  });

  it('rejects create when frontmatter has no `name`', async () => {
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      files: [{ path: 'SKILL.md', content: '---\ndescription_en: "x"\n---\n\nbody\n' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/name|缺少/);
  });

  it('rejects create when name has Chinese characters (charset gate)', async () => {
    const s = await loadSkills();
    // Hard requirement from product: skill name must be ASCII only.
    const r = await s.applySkillContainerFromCommander({
      files: [{ path: 'SKILL.md', content: '---\nname: "中文技能"\n---\n\nbody\n' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/name|invalid|名称/);
  });

  it('rejects create on collision with existing custom skill', async () => {
    writeCustomSkill('dup');
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      files: [{ path: 'SKILL.md', content: '---\nname: "dup"\n---\n\nbody\n' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists|已存在/);
  });
});

describe('skills › applySkillContainerFromCommander › edit', () => {
  it('writes blocks to existing custom skill', async () => {
    writeCustomSkill('beta', 'name: "beta"\ndescription_en: "old"', 'old body');
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      skillId: 'beta',
      files: [{ path: 'scripts/run.py', content: 'pass\n' }],
    });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('updated');
    expect(r.skillId).toBe('beta');
    expect(r.written).toEqual(['scripts/run.py']);
    expect(fs.existsSync(path.join(customSkillsDir(), 'beta', 'scripts/run.py'))).toBe(true);
  });

  it('rejects edit on builtin skill (read-only outside dev panel)', async () => {
    fs.mkdirSync(path.join(builtinSkillsDir(), 'shipped'), { recursive: true });
    fs.writeFileSync(
      path.join(builtinSkillsDir(), 'shipped', 'SKILL.md'),
      '---\nname: "shipped"\n---\n\nbody\n',
    );
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      skillId: 'shipped',
      files: [{ path: 'SKILL.md', content: '---\nname: "shipped"\n---\n\ntampered\n' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/built-in|内置/i);
    // Original body preserved.
    expect(fs.readFileSync(path.join(builtinSkillsDir(), 'shipped', 'SKILL.md'), 'utf8'))
      .toContain('body');
  });

  it('rejects edit when skill does not exist', async () => {
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      skillId: 'nonexistent',
      files: [{ path: 'SKILL.md', content: '---\nname: "nonexistent"\n---\n\nbody\n' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found|不存在/i);
  });

  it('auto-renames the dir when SKILL.md `name` changes', async () => {
    writeCustomSkill('oldname', 'name: "oldname"\ndescription_en: "x"', 'body');
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      skillId: 'oldname',
      files: [{ path: 'SKILL.md', content: '---\nname: "newname"\ndescription_en: "x"\n---\n\nbody\n' }],
    });
    expect(r.ok).toBe(true);
    expect(r.skillId).toBe('newname');
    expect(fs.existsSync(path.join(customSkillsDir(), 'oldname'))).toBe(false);
    expect(fs.existsSync(path.join(customSkillsDir(), 'newname'))).toBe(true);
  });

  it('best-effort: one rejected path does not roll back successful writes', async () => {
    writeCustomSkill('keep', 'name: "keep"\ndescription_en: "x"', 'body');
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      skillId: 'keep',
      files: [
        { path: 'good.txt', content: 'kept' },
        { path: '../escape', content: 'should reject' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(['good.txt']);
    expect(r.rejected).toEqual(['../escape']);
    expect(fs.readFileSync(path.join(customSkillsDir(), 'keep', 'good.txt'), 'utf8')).toBe('kept');
  });
});

// hashTree / syncBuiltinSkills removed: there is no globally-shared `data/builtin/`
// tree anymore. Platform skills now arrive via marketplace install and live at
// `<uid>/local/marketplace/skills/<id>/` per machine — see features/marketplace_*.ts.

describe('skills › listSkills', () => {
  it('returns empty when both dirs are missing', async () => {
    const s = await loadSkills();
    const list = await s.listSkills();
    expect(list).toEqual([]);
  });

  it('lists custom skills from frontmatter', async () => {
    // Legacy `description` (English) migrates to `description_en`.
    writeCustomSkill('alpha', 'name: "Alpha"\ndescription: "The first"');
    const s = await loadSkills();
    const list = await s.listSkills();
    expect(list).toEqual([
      { id: 'alpha', name: 'Alpha', source: 'custom', description_zh: '', description_en: 'The first', category: '', create_uid: undefined, enabled: true },
    ]);
  });

  it('custom wins when builtin has same id', async () => {
    writeCustomSkill('dup', 'name: "Custom Dup"\ndescription: "cx"');
    const builtinDir = path.join(builtinSkillsDir(), 'dup');
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, 'SKILL.md'),
      '---\nname: "Builtin Dup"\ndescription: "bx"\n---\n');
    const s = await loadSkills();
    const list = await s.listSkills();
    const dup = list.filter((x) => x.id === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0].source).toBe('custom');
    expect(dup[0].description_en).toBe('cx');
  });
});

describe('skills › getCustomSkill', () => {
  it('returns null for missing skill', async () => {
    const s = await loadSkills();
    expect(await s.getCustomSkill('missing')).toBeNull();
  });

  it('returns id/name/description/dir for existing skill', async () => {
    writeCustomSkill('alpha', 'name: "Alpha"\ndescription: "desc"');
    const s = await loadSkills();
    const sk = await s.getCustomSkill('alpha');
    expect(sk).toEqual({
      id: 'alpha',
      name: 'Alpha',
      description_zh: '',
      description_en: 'desc',
      category: '',
      source: 'custom',
      dir: path.join(customSkillsDir(), 'alpha'),
    });
  });
});

describe('skills › createCustomSkill', () => {
  it('creates a new skill dir with SKILL.md', async () => {
    const s = await loadSkills();
    // Legacy single description (English) routes to description_en.
    const sk = await s.createCustomSkill('my-skill', 'my desc');
    expect(sk?.id).toBe('my-skill');
    expect(sk?.description_en).toBe('my desc');
    const md = path.join(customSkillsDir(), 'my-skill', 'SKILL.md');
    expect(fs.existsSync(md)).toBe(true);
    expect(fs.readFileSync(md, 'utf8')).toContain('name: "my-skill"');
  });

  it('throws on invalid name', async () => {
    const s = await loadSkills();
    await expect(s.createCustomSkill('1bad', '')).rejects.toThrow();
  });

  it('throws on duplicate custom id', async () => {
    writeCustomSkill('dup');
    const s = await loadSkills();
    await expect(s.createCustomSkill('dup', '')).rejects.toThrow(/already exists|已存在/);
  });

  it('throws when name collides with builtin', async () => {
    const builtinDir = path.join(builtinSkillsDir(), 'fixed');
    fs.mkdirSync(builtinDir, { recursive: true });
    const s = await loadSkills();
    await expect(s.createCustomSkill('fixed', '')).rejects.toThrow(/conflicts with a built-in|内置技能冲突/);
  });
});

describe('skills › updateCustomSkill', () => {
  it('rewrites SKILL.md with new description, preserving body', async () => {
    // Frontmatter name must match the dir id; otherwise updateCustomSkill
    // treats meta.name as a rename target and refuses "already exists".
    // Legacy `description` update routes through Chinese-character heuristic.
    writeCustomSkill('alpha', 'name: "alpha"\ndescription: "old"', 'original body content');
    const s = await loadSkills();
    const updated = await s.updateCustomSkill('alpha', { description: 'new desc' });
    expect(updated?.description_en).toBe('new desc');
    const md = fs.readFileSync(path.join(customSkillsDir(), 'alpha', 'SKILL.md'), 'utf8');
    expect(md).toContain('original body content');
    expect(md).toContain('description_en: "new desc"');
  });

  it('renames the skill dir when name changes', async () => {
    writeCustomSkill('alpha');
    const s = await loadSkills();
    const updated = await s.updateCustomSkill('alpha', { name: 'beta' });
    expect(updated?.id).toBe('beta');
    expect(fs.existsSync(path.join(customSkillsDir(), 'alpha'))).toBe(false);
    expect(fs.existsSync(path.join(customSkillsDir(), 'beta'))).toBe(true);
  });

  it('returns null for missing skill', async () => {
    const s = await loadSkills();
    expect(await s.updateCustomSkill('ghost', { description: 'x' })).toBeNull();
  });
});

describe('skills › deleteCustomSkill', () => {
  it('removes the dir', async () => {
    writeCustomSkill('target');
    const s = await loadSkills();
    const ok = await s.deleteCustomSkill('target');
    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(customSkillsDir(), 'target'))).toBe(false);
  });

  it('returns false for missing skill', async () => {
    const s = await loadSkills();
    expect(await s.deleteCustomSkill('ghost')).toBe(false);
  });

  it('purges the core-agent session jsonl so recreate starts fresh', async () => {
    writeCustomSkill('target');
    const sessionDir = path.join(tmpDir, TEST_UID, 'cloud', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, 'skill-target.jsonl');
    fs.writeFileSync(sessionFile, '{"role":"user","content":"old"}\n');

    const s = await loadSkills();
    const ok = await s.deleteCustomSkill('target');
    expect(ok).toBe(true);
    expect(fs.existsSync(sessionFile)).toBe(false);
  });
});

describe('skills › writeCustomSkillFile (path safety)', () => {
  it('writes a file inside the skill dir', async () => {
    writeCustomSkill('alpha');
    const s = await loadSkills();
    expect(s.writeCustomSkillFile('alpha', 'note.md', '# content')).toBe(true);
    const written = fs.readFileSync(
      path.join(customSkillsDir(), 'alpha', 'note.md'), 'utf8');
    expect(written).toBe('# content');
  });

  it('rejects path traversal attempts', async () => {
    writeCustomSkill('alpha');
    const s = await loadSkills();
    expect(s.writeCustomSkillFile('alpha', '../../evil.md', 'x')).toBe(false);
    expect(s.writeCustomSkillFile('alpha', 'sub/../../evil.md', 'x')).toBe(false);
  });

  it('rejects empty relpath', async () => {
    writeCustomSkill('alpha');
    const s = await loadSkills();
    expect(s.writeCustomSkillFile('alpha', '', 'x')).toBe(false);
  });

  it('returns false when skill does not exist', async () => {
    const s = await loadSkills();
    expect(s.writeCustomSkillFile('ghost', 'note.md', 'x')).toBe(false);
  });
});

describe('skills › listSkillTree', () => {
  it('returns file tree for a skill', async () => {
    writeCustomSkill('alpha');
    const dir = path.join(customSkillsDir(), 'alpha');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'nested.txt'), 'x');
    const s = await loadSkills();
    const r = await s.listSkillTree('custom', 'alpha');
    expect(r.ok).toBe(true);
    const tree = (r as any).tree;
    // Dirs first, then files (both alpha-sorted)
    expect(tree[0]).toMatchObject({ name: 'sub', type: 'dir' });
    expect(tree[0].children[0].name).toBe('nested.txt');
    expect(tree.find((n: any) => n.name === 'SKILL.md')).toBeDefined();
  });

  it('error for missing skill', async () => {
    const s = await loadSkills();
    const r = await s.listSkillTree('custom', 'ghost');
    expect(r.ok).toBe(false);
  });
});

describe('skills › buildSkillEditSystemPrompt', () => {
  it('renders template with skill metadata + file list, no leftover placeholders', async () => {
    writeCustomSkill('alpha', 'name: "Alpha"\ndescription: "a demo"', 'body text');
    const s = await loadSkills();
    const skill = (await s.getCustomSkill('alpha'))!;
    const sys = await s.buildSkillEditSystemPrompt(skill);
    expect(sys).toContain('Alpha');
    expect(sys).toContain('a demo');
    expect(sys).toContain('alpha');     // shows up in skill_dir (dir name == id)
    expect(sys).toContain('SKILL.md');  // file listing includes SKILL.md
    // Template no longer carries the user-input footer.
    expect(sys).not.toMatch(/##\s*用户的初始请求/);
    // All placeholders resolved.
    expect(sys).not.toMatch(/\$skill_name|\$skill_description|\$skill_dir|\$skill_files/);
  });
});

describe('skills › readSkillFile path safety', () => {
  it('rejects paths escaping the skill dir', async () => {
    writeCustomSkill('alpha');
    const s = await loadSkills();
    const r = await s.readSkillFile('custom', 'alpha', '../../etc/passwd');
    expect(r.ok).toBe(false);
  });

  it('reads SKILL.md by default', async () => {
    writeCustomSkill('alpha', 'name: "A"\ndescription: "d"', 'hello');
    const s = await loadSkills();
    const r = await s.readSkillFile('custom', 'alpha');
    expect(r.ok).toBe(true);
    expect((r as any).content).toContain('hello');
    expect((r as any).ext).toBe('md');
  });
});

describe('skills › streamSendToSkillChat synthesized progress', () => {
  beforeEach(async () => {
    const { setCurrentLang } = await import('../../../src/main/i18n');
    setCurrentLang('zh');
  });

  it('emits a progress line per skill-file block written', async () => {
    streamImpl.current = async function* () {
      yield {
        type: 'final',
        text: '<<<skill-file path=notes.md\nhello\n>>>\n\n<<<skill-file path=scripts/helper.ts\nexport default 1\n>>>',
      };
    };
    writeCustomSkill('alpha');

    const s = await loadSkills();
    const events: any[] = [];
    for await (const ev of s.streamSendToSkillChat('u1', 'alpha', 'edit')) {
      events.push(ev);
    }

    const progressTexts = events.filter((e) => e.type === 'progress').map((e) => e.text);
    expect(progressTexts).toContain('▶ 写入 notes.md');
    expect(progressTexts).toContain('▶ 写入 scripts/helper.ts');

    // Persisted into chat.jsonl too.
    const chatPath = path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'skill', 'alpha', 'chat.jsonl');
    const lines = fs.readFileSync(chatPath, 'utf8').trim().split('\n');
    const assistantMsg = JSON.parse(lines[lines.length - 1]);
    expect(Array.isArray(assistantMsg.process)).toBe(true);
    const persistedTexts = assistantMsg.process.map((p: any) => p.text);
    expect(persistedTexts).toContain('▶ 写入 notes.md');
    expect(persistedTexts).toContain('▶ 写入 scripts/helper.ts');
  });

  it('marks rejected writes with the 拒绝写入 glyph', async () => {
    streamImpl.current = async function* () {
      // Path escape gets rejected by writeCustomSkillFile; the handler
      // must still synthesize a progress line so the user sees *why* the
      // disk was not touched.
      yield { type: 'final', text: '<<<skill-file path=../evil.md\nhi\n>>>' };
    };
    writeCustomSkill('alpha');

    const s = await loadSkills();
    const events: any[] = [];
    for await (const ev of s.streamSendToSkillChat('u1', 'alpha', 'edit')) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === 'progress').map((e) => e.text))
      .toContain('◯ 拒绝写入 ../evil.md');
  });

  it('does not synthesize progress events when no skill-file blocks are present', async () => {
    streamImpl.current = async function* () {
      yield { type: 'final', text: 'plain reply' };
    };
    writeCustomSkill('alpha');

    const s = await loadSkills();
    const events: any[] = [];
    for await (const ev of s.streamSendToSkillChat('u1', 'alpha', 'edit')) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === 'progress')).toHaveLength(0);
  });
});

// (The legacy marketplace-sentinel / data/builtin sync tests are gone. Marketplace
// installs now live at `<uid>/local/marketplace/skills/<id>/` and are reconciled from
// the cloud-synced `installs.json` manifest — see features/marketplace_*.ts.)
