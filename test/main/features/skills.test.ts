import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// skills.ts pulls path constants + the module-level _skillListCache at load.
// Reset ORKAS_WORKSPACE_ROOT + module graph per test for isolation.

// Swap the LLM stream impl per test — same pattern as chats.test.ts /
// agents.test.ts so streamSendToSkillChat tests can feed synthetic finals.
const streamImpl: { current: null | ((opts: any) => AsyncGenerator<any, void, unknown>) } = { current: null };
const chatImpl: { current: null | ((opts: any) => Promise<any>) } = { current: null };
vi.mock('../../../src/main/model/client', () => ({
  streamChatWithModel: (opts: any) => {
    if (streamImpl.current) return streamImpl.current(opts);
    return (async function* () { /* empty */ })();
  },
  chatWithModel: vi.fn(async (opts: any) => {
    if (chatImpl.current) return chatImpl.current(opts);
    return { ok: true, text: 'ok', error: '', aborted: false };
  }),
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
  chatImpl.current = null;
  vi.unstubAllGlobals();
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

function markImportDraft(id: string, source: 'url' | 'dir' = 'dir'): void {
  fs.writeFileSync(
    path.join(customSkillsDir(), id, '_meta.json'),
    JSON.stringify({ _import: { draft: true, source } }, null, 2),
    'utf8',
  );
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
    const md = s.skillMdContent('Weird "name"', 'desc with "quote"');
    expect(md).toContain('name: "Weird \\"name\\""');
    expect(md).toContain('description: "desc with \\"quote\\""');
    expect(md).not.toContain('description_en:');
    expect(md).not.toContain('description_zh:');
  });

  it('flattens newlines in metadata', async () => {
    const s = await loadSkills();
    const md = s.skillMdContent('a\nb', 'c\nd', 'body');
    expect(md).toContain('name: "a b"');
    expect(md).toContain('description: "c d"');
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
  });

  it('rejects empty/too-long', async () => {
    const s = await loadSkills();
    expect(s.validateSkillName('')).toMatch(/Please enter|填写/);
    expect(s.validateSkillName('a'.repeat(60))).toBe('');
    expect(s.validateSkillName('a'.repeat(61))).toMatch(/too long|过长/);
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

  it('rejects any spaces', async () => {
    const s = await loadSkills();
    expect(s.validateSkillName('My Skill Name')).not.toBe('');
    expect(s.validateSkillName('foo bar')).not.toBe('');
    expect(s.validateSkillName('foo  bar')).not.toBe('');
    expect(s.validateSkillName(' foo')).not.toBe('');
    expect(s.validateSkillName('foo ')).not.toBe('');
  });
});

describe('skills › isValidSkillId', () => {
  it('matches the same grammar as validateSkillName', async () => {
    const s = await loadSkills();
    expect(s.isValidSkillId('foo')).toBe(true);
    expect(s.isValidSkillId('foo bar')).toBe(false);
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

describe('skills › extractSkillMetadataBlocks', () => {
  it('extracts lightweight metadata updates and strips the block', async () => {
    const s = await loadSkills();
    const text = 'done\n<skill-meta>\n<category>data</category>\n<description_en>New desc</description_en>\n</skill-meta>';
    const r = s.extractSkillMetadataBlocks(text);
    expect(r.updates).toEqual([{ category: 'data', description_en: 'New desc' }]);
    expect(r.cleanText).toBe('done');
  });

  it('extracts routing metadata updates from lightweight metadata blocks', async () => {
    const s = await loadSkills();
    const text = [
      'done',
      '<skill-meta>',
      '<category>data</category>',
      '<negative_examples>',
      '- draw a logo',
      '- write sales copy',
      '</negative_examples>',
      '<applicable_domain>research notes</applicable_domain>',
      '<prerequisites>',
      '- source notes are available',
      '</prerequisites>',
      '</skill-meta>',
    ].join('\n');
    const r = s.extractSkillMetadataBlocks(text);
    expect(r.updates).toEqual([{
      category: 'data',
      routing: {
        negative_examples: ['draw a logo', 'write sales copy'],
        applicable_domain: 'research notes',
        prerequisites: ['source notes are available'],
      },
    }]);
    expect(r.cleanText).toBe('done');
  });

  it('treats explicit XML fences as structural metadata output', async () => {
    const s = await loadSkills();
    const text = '```xml\n<skill-meta><category>data</category></skill-meta>\n```';
    const r = s.extractSkillMetadataBlocks(text);
    expect(r.updates).toEqual([{ category: 'data' }]);
    expect(r.cleanText).toBe('```xml\n\n```');
  });

  it('preserves inline quoted mentions', async () => {
    const s = await loadSkills();
    const text = 'Use `<skill-meta>` only for metadata edits.';
    const r = s.extractSkillMetadataBlocks(text);
    expect(r.updates).toEqual([]);
    expect(r.cleanText).toBe(text);
  });
});

describe('skills › extractSkillAsPackageMarker', () => {
  it('parses a self-closing marker with a name and strips it', async () => {
    const s = await loadSkills();
    const text = 'Installed and ready.\n<skill-as-package name="hyperframes"/>';
    const r = s.extractSkillAsPackageMarker(text);
    expect(r).not.toBeNull();
    expect(r!.name).toBe('hyperframes');
    expect(r!.cleanText).toBe('Installed and ready.');
  });

  it('accepts spacing, single quotes, and a paired close tag', async () => {
    const s = await loadSkills();
    const r1 = s.extractSkillAsPackageMarker("ok <skill-as-package name='my-pkg' />");
    expect(r1!.name).toBe('my-pkg');
    const r2 = s.extractSkillAsPackageMarker('ok <skill-as-package name="p"></skill-as-package>');
    expect(r2!.name).toBe('p');
    expect(r2!.cleanText).toBe('ok');
  });

  it('returns a null name when the attribute is absent but the marker is present', async () => {
    const s = await loadSkills();
    const r = s.extractSkillAsPackageMarker('done <skill-as-package/>');
    expect(r).not.toBeNull();
    expect(r!.name).toBeNull();
    expect(r!.cleanText).toBe('done');
  });

  it('does not fire on look-alike prose, bare mentions, or absent markers', async () => {
    const s = await loadSkills();
    expect(s.extractSkillAsPackageMarker('no marker here')).toBeNull();
    expect(s.extractSkillAsPackageMarker('talking about packages and skills')).toBeNull();
    // A bare opening tag (no `/>` and no close tag) must NOT finalize — firing
    // deletes the placeholder skill, so prose mentions stay inert.
    expect(s.extractSkillAsPackageMarker('the `<skill-as-package>` marker finalizes an import')).toBeNull();
    expect(s.extractSkillAsPackageMarker('<skill-as-package name="x">')).toBeNull();
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

  it('A3b: edit container can carry metadata without a SKILL.md payload', async () => {
    const s = await loadSkills();
    const text = '<skill>\n<skill_id>bar</skill_id>\n<category>data</category>\n</skill>';
    const r = s.extractSkillContainers(text);
    expect(r.containers[0].skillId).toBe('bar');
    expect(r.containers[0].files).toEqual([]);
    expect(r.containers[0].metadata).toEqual({ category: 'data' });
  });

  it('A3c: metadata tags inside a skill-file block are not parsed as container metadata', async () => {
    const s = await loadSkills();
    const text = '<skill>\n<skill_id>bar</skill_id>\n<<<skill-file path=SKILL.md\n---\nname: "bar"\ndescription_en: "desc"\ncategory: "general"\n---\n\nExample:\n<category>data</category>\n>>>\n</skill>';
    const r = s.extractSkillContainers(text);
    expect(r.containers[0].files).toHaveLength(1);
    expect(r.containers[0].metadata).toBeUndefined();
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

  it('B5: `<skill>` inside fenced non-XML code block must NOT match', async () => {
    const s = await loadSkills();
    const text = 'Here is the format:\n```\n<skill>\n<skill_id>example</skill_id>\n<<<skill-file path=SKILL.md\nname: "example"\n>>>\n</skill>\n```\nThat is the shape.';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toEqual([]);
    expect(r.cleanText).toBe(text); // Untouched — it's prose teaching, not a real op.
  });

  it('B5b: `<skill>` inside fenced ```xml block is treated as structural', async () => {
    const s = await loadSkills();
    const text = '```xml\n<skill>\n<skill_id>example</skill_id>\n<<<skill-file path=SKILL.md\nbody\n>>>\n</skill>\n```';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0].skillId).toBe('example');
    expect(r.containers[0].files.map((f: any) => f.path)).toEqual(['SKILL.md']);
    expect(r.cleanText).toBe('```xml\n\n```');
  });

  it('B6: `<skill>` inside inline backtick span must NOT match', async () => {
    const s = await loadSkills();
    const text = 'Wrap your spec inside `<skill>...</skill>` and the system will pick it up.';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toEqual([]);
    expect(r.cleanText).toBe(text);
  });

  it('B6b: inline quoted `<skill>` text must NOT match', async () => {
    const s = await loadSkills();
    const text = '请输出 "<skill><skill_id>example</skill_id></skill>" 这些字符';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toEqual([]);
    expect(r.cleanText).toBe(text);
  });

  it('B7: real container AFTER a code-fence example — only the real one is extracted', async () => {
    const s = await loadSkills();
    // Critical: this is the failure mode the guard prevents — a naive
    // regex would match the FIRST `<skill>` (the fenced example) and
    // try to write fictional files, ignoring the real container below.
    const text = 'Format:\n```\n<skill>\n<skill_id>example</skill_id>\n</skill>\n```\nAnd here is the real one:\n<skill>\n<skill_id>real</skill_id>\n<<<skill-file path=SKILL.md\nbody\n>>>\n</skill>';
    const r = s.extractSkillContainers(text);
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0].skillId).toBe('real');
    expect(r.cleanText).toContain('```');
    expect(r.cleanText).toContain('<skill>\n<skill_id>example</skill_id>'); // fenced example survives
  });
});

describe('skills › applySkillContainerFromCommander › create', () => {
  it('creates skill from frontmatter `name`, writes all blocks', async () => {
    const s = await loadSkills();
    const skillMdContent = '---\nname: "social-fetch"\ndescription_zh: "抓取并分析"\ndescription_en: "Fetch and analyze"\ncategory: "data"\n---\n\n# When to use\n…\n';
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
    expect(md).toContain('description:');
    expect(md).not.toContain('description_en:');
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'social-fetch', '_meta.json'), 'utf8'));
    expect(meta.descriptions.en).toBe('Fetch and analyze');
    expect(meta.descriptions.zh).toBe('抓取并分析');
    expect(meta.category).toBe('data');
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

  it('stores model-authored category metadata outside SKILL.md', async () => {
    const s = await loadSkills();
    const missing = await s.applySkillContainerFromCommander({
      files: [{ path: 'SKILL.md', content: '---\nname: "uncategorized"\ndescription_en: "x"\n---\n\nbody\n' }],
    });
    expect(missing.ok).toBe(true);
    expect(fs.readFileSync(path.join(customSkillsDir(), 'uncategorized', 'SKILL.md'), 'utf8'))
      .not.toContain('category:');

    const invalid = await s.applySkillContainerFromCommander({
      files: [{ path: 'SKILL.md', content: '---\nname: "badcat"\ndescription_en: "x"\ncategory: "bad category"\n---\n\nbody\n' }],
    });
    expect(invalid.ok).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'badcat', '_meta.json'), 'utf8'));
    expect(meta.category).toBe('general');
    expect(fs.readFileSync(path.join(customSkillsDir(), 'badcat', 'SKILL.md'), 'utf8'))
      .not.toContain('category:');
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

  it('updates category from lightweight metadata without a full SKILL.md block', async () => {
    writeCustomSkill('beta', 'name: "beta"\ndescription_en: "old"\ncategory: "general"', 'old body');
    const s = await loadSkills();
    const before = fs.readFileSync(path.join(customSkillsDir(), 'beta', 'SKILL.md'), 'utf8');
    expect(before).toContain('old body');

    const r = await s.applySkillContainerFromCommander({
      skillId: 'beta',
      files: [],
      metadata: { category: 'data' },
    });

    expect(r.ok).toBe(true);
    expect(r.kind).toBe('updated');
    expect(r.written).toEqual(['SKILL.md']);
    const after = fs.readFileSync(path.join(customSkillsDir(), 'beta', 'SKILL.md'), 'utf8');
    expect(after).not.toContain('category: "data"');
    expect(after).toContain('old body');
    expect(after).toContain('description_en: "old"');
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'beta', '_meta.json'), 'utf8'));
    expect(meta.category).toBe('data');
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
    expect(r.error).toMatch(/marketplace|平台技能|マーケットプレイス/i);
    // Original body preserved.
    expect(fs.readFileSync(path.join(builtinSkillsDir(), 'shipped', 'SKILL.md'), 'utf8'))
      .toContain('body');
  });

  it('creates when skill_id target is missing but a full SKILL.md payload is present', async () => {
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      skillId: 'nonexistent',
      files: [{
        path: 'SKILL.md',
        content: '---\nname: "nonexistent"\ndescription_zh: "测试技能"\ndescription_en: "Test skill"\ncategory: "general"\n---\n\n# When to use\nUse for test prompts.\n',
      }],
    });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('created');
    expect(r.skillId).toBe('nonexistent');
    expect(fs.existsSync(path.join(customSkillsDir(), 'nonexistent', 'SKILL.md'))).toBe(true);
  });

  it('rejects missing skill_id target when there is no SKILL.md create payload', async () => {
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      skillId: 'nonexistent',
      files: [{ path: 'scripts/run.py', content: 'pass\n' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found|不存在/i);
  });

  it('auto-renames the dir when SKILL.md `name` changes', async () => {
    writeCustomSkill('oldname', 'name: "oldname"\ndescription_en: "x"\ncategory: "general"', 'body');
    const s = await loadSkills();
    const r = await s.applySkillContainerFromCommander({
      skillId: 'oldname',
      files: [{ path: 'SKILL.md', content: '---\nname: "newname"\ndescription_en: "x"\ncategory: "general"\n---\n\nbody\n' }],
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

// hashTree / syncBuiltinSkills removed. Platform skills now arrive via marketplace install and live at
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

  it('keeps disabled state when the list is served from cache', async () => {
    writeCustomSkill('alpha', 'name: "Alpha"\ndescription: "The first"');
    const s = await loadSkills();

    expect((await s.listSkills()).find((x) => x.id === 'alpha')?.enabled).toBe(true);
    s.setSkillEnabledForActiveUser('alpha', false);

    expect((await s.listSkills()).find((x) => x.id === 'alpha')?.enabled).toBe(false);
    expect((await s.listSkills()).find((x) => x.id === 'alpha')?.enabled).toBe(false);
  });

  it('ignores skill directories that do not contain SKILL.md', async () => {
    fs.mkdirSync(path.join(customSkillsDir(), 'empty-custom'), { recursive: true });
    const platformOnlyMeta = path.join(builtinSkillsDir(), 'empty-platform');
    fs.mkdirSync(platformOnlyMeta, { recursive: true });
    fs.writeFileSync(path.join(platformOnlyMeta, '_install.json'), JSON.stringify({ version: '1.0.0' }));

    const s = await loadSkills();
    expect(await s.listSkills()).toEqual([]);
  });

  it('does not let an empty custom directory shadow a valid marketplace skill', async () => {
    fs.mkdirSync(path.join(customSkillsDir(), 'dup'), { recursive: true });
    const builtinDir = path.join(builtinSkillsDir(), 'dup');
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, 'SKILL.md'),
      '---\nname: "Marketplace Dup"\ndescription: "mx"\n---\n');

    const s = await loadSkills();
    const list = await s.listSkills();

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('dup');
    expect(list[0].source).toBe('marketplace');
    expect(list[0].description_en).toBe('mx');
  });

  it('refreshes the list when SKILL.md appears inside an existing empty directory', async () => {
    const dir = path.join(customSkillsDir(), 'late-skill');
    fs.mkdirSync(dir, { recursive: true });

    const s = await loadSkills();
    expect(await s.listSkills()).toEqual([]);

    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      '---\nname: "Late Skill"\ndescription: "now valid"\n---\n');

    const list = await s.listSkills();
    expect(list.map((x) => x.id)).toEqual(['late-skill']);
    expect(list[0].name).toBe('Late Skill');
  });

  it('marketplace wins when custom has same id', async () => {
    writeCustomSkill('dup', 'name: "Custom Dup"\ndescription: "cx"');
    const builtinDir = path.join(builtinSkillsDir(), 'dup');
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, 'SKILL.md'),
      '---\nname: "Builtin Dup"\ndescription: "bx"\n---\n');
    const s = await loadSkills();
    const list = await s.listSkills();
    const dup = list.filter((x) => x.id === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0].source).toBe('marketplace');
    expect(dup[0].description_en).toBe('bx');
  });

  it('exposes marketplace install version and freshness metadata', async () => {
    const builtinDir = path.join(builtinSkillsDir(), 'platform-skill');
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, 'SKILL.md'),
      '---\nname: "Platform Skill"\ndescription: "platform"\n---\n');
    fs.writeFileSync(path.join(builtinDir, '_install.json'), JSON.stringify({
      version: '2.0.1',
      published_at: 1747066800000,
      updated_at: 1747067800000,
      default_install: true,
    }));

    const s = await loadSkills();
    const found = (await s.listSkills()).find((x) => x.id === 'platform-skill');
    expect(found?.version).toBe('2.0.1');
    expect(found?.marketplace_published_at).toBe(1747066800000);
    expect(found?.marketplace_updated_at).toBe(1747067800000);
    expect(found?.default_install).toBe(true);
  });

  it('cache-only invalidator picks up marketplace file rewrites', async () => {
    const parent = builtinSkillsDir();
    const dir = path.join(parent, 'platform-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      '---\nname: "Old platform skill"\ndescription: "old"\n---\n');
    const fixedStamp = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(parent, fixedStamp, fixedStamp);

    const s = await loadSkills();
    expect((await s.listSkills()).find((x) => x.id === 'platform-skill')?.name)
      .toBe('Old platform skill');

    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      '---\nname: "New platform skill"\ndescription: "new"\n---\n');
    fs.utimesSync(parent, fixedStamp, fixedStamp);

    expect((await s.listSkills()).find((x) => x.id === 'platform-skill')?.name)
      .toBe('Old platform skill');
    s.clearSkillListCache();
    expect((await s.listSkills()).find((x) => x.id === 'platform-skill')?.name)
      .toBe('New platform skill');
  });
});

describe('skills › getCustomSkill', () => {
  it('returns null for missing skill', async () => {
    const s = await loadSkills();
    expect(await s.getCustomSkill('missing')).toBeNull();
  });

  it('returns null for a directory without SKILL.md', async () => {
    fs.mkdirSync(path.join(customSkillsDir(), 'empty-custom'), { recursive: true });
    const s = await loadSkills();
    expect(await s.getCustomSkill('empty-custom')).toBeNull();
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
      status: '',
      source: 'custom',
      dir: path.join(customSkillsDir(), 'alpha'),
    });
  });
});

describe('skills › createCustomSkill', () => {
  it('creates a new skill dir with SKILL.md', async () => {
    const s = await loadSkills();
    const sk = await s.createCustomSkill('my-skill', 'my desc');
    expect(sk?.id).toBe('my-skill');
    expect(sk?.description_en).toBe('my desc');
    const md = path.join(customSkillsDir(), 'my-skill', 'SKILL.md');
    expect(fs.existsSync(md)).toBe(true);
    expect(fs.readFileSync(md, 'utf8')).toContain('name: "my-skill"');
  });

  it('keeps a single custom description in SKILL.md instead of _meta.json', async () => {
    const { setLanguage } = await import('../../../src/main/features/config');
    setLanguage('zh');
    const s = await loadSkills();

    const sk = await s.createCustomSkill('zh-skill', '当前语言简介');

    expect(sk?.description_zh).toBe('当前语言简介');
    expect(sk?.description_en).toBe('');
    const md = fs.readFileSync(path.join(customSkillsDir(), 'zh-skill', 'SKILL.md'), 'utf8');
    expect(md).toContain('description: "当前语言简介"');
    expect(md).not.toContain('description_zh:');
    expect(md).not.toContain('description_en:');
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'zh-skill', '_meta.json'), 'utf8'));
    expect(meta.descriptions).toBeUndefined();
    expect(meta.description_zh).toBeUndefined();
    expect(meta.description_en).toBeUndefined();
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
    await expect(s.createCustomSkill('fixed', '')).rejects.toThrow(/conflicts with a marketplace|与平台技能冲突|マーケットプレイスのスキルと競合/);
  });
});

describe('skills › createFromDir', () => {
  it('reports the actual filtered file count when the import exceeds the limit', async () => {
    const srcParent = fs.mkdtempSync(path.join(process.cwd(), '.tmp-skill-import-'));
    try {
      const src = path.join(srcParent, 'source-too-many');
      fs.mkdirSync(src, { recursive: true });
      for (let i = 0; i < 205; i += 1) {
        fs.writeFileSync(path.join(src, `file-${String(i).padStart(3, '0')}.md`), 'x');
      }
      fs.writeFileSync(path.join(src, '.DS_Store'), 'ignored');
      fs.writeFileSync(path.join(src, 'package.json'), '{}');
      fs.mkdirSync(path.join(src, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(src, 'node_modules', 'ignored.js'), 'ignored');

      const s = await loadSkills();
      const r = await s.createFromDir(null, null, src);

      expect(r.ok).toBe(false);
      expect(r.error).toContain('205');
      expect(r.error).toContain('200');
      expect(r.error).not.toContain('201');
      expect(fs.existsSync(path.join(customSkillsDir(), 'source-too-many'))).toBe(false);
    } finally {
      fs.rmSync(srcParent, { recursive: true, force: true });
    }
  });

  it('installs a local source SKILL.md folder directly, then seeds metadata-only edit chat', async () => {
    const srcParent = fs.mkdtempSync(path.join(process.cwd(), '.tmp-skill-import-'));
    try {
      const modelCalls: any[] = [];
      chatImpl.current = async (opts: any) => {
        modelCalls.push(opts);
        return { ok: true, text: JSON.stringify({ category: 'education' }), error: '', aborted: false };
      };
      const src = path.join(srcParent, 'growth');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'SKILL.md'), [
        '---',
        'name: "growth"',
        'description: "待整理的技能"',
        '---',
        '',
        '# Imported body',
      ].join('\n'));
      fs.writeFileSync(path.join(src, '_meta.json'), JSON.stringify({ category: 'data' }, null, 2), 'utf8');
      fs.writeFileSync(path.join(src, '领域头部开源项目与Agent驱动机会.md'), '参考资料\n', 'utf8');

      const s = await loadSkills();
      const r = await s.createFromDir(null, null, src);

      expect(r.ok).toBe(true);
      expect(r.seedModelText).toContain('growth');
      expect(r.seedModelText).not.toContain('metadata');
      expect(r.seedModelText).not.toContain('SKILL.md');
      expect(r.seedModelText!.length).toBeLessThan(120);
      expect(r.seedMessage).toBe(r.seedModelText);
      expect(r.skill?.id).toBe('growth');
      expect(modelCalls).toHaveLength(0);
      const skillDir = path.join(customSkillsDir(), 'growth');
      expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('# Imported body');
      expect(fs.existsSync(path.join(skillDir, '领域头部开源项目与Agent驱动机会.md'))).toBe(true);
      const meta = JSON.parse(fs.readFileSync(path.join(skillDir, '_meta.json'), 'utf8'));
      expect(meta._import).toBeUndefined();
      expect(meta.category).toBe('data');
      expect(meta.status).toBe('approved');
    } finally {
      fs.rmSync(srcParent, { recursive: true, force: true });
    }
  });

  it('installs multiple local source SKILL.md files as separate skills without pre-modeling', async () => {
    const srcParent = fs.mkdtempSync(path.join(process.cwd(), '.tmp-skill-import-'));
    try {
      const modelCalls: any[] = [];
      chatImpl.current = async (opts: any) => {
        modelCalls.push(opts);
        const isAlpha = String(opts.message || '').includes('alpha-skill');
        return {
          ok: true,
          text: JSON.stringify(isAlpha
            ? { category: 'data', routing: { negative_examples: ['beta work'] }, descriptions: { en: 'drop me' } }
            : { category: 'creation' }),
          error: '',
          aborted: false,
        };
      };
      const src = path.join(srcParent, 'skill-pack');
      const alpha = path.join(src, 'skills', 'alpha-skill');
      const beta = path.join(src, 'skills', 'beta-skill');
      fs.mkdirSync(path.join(alpha, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(beta, 'references'), { recursive: true });
      fs.writeFileSync(path.join(alpha, 'SKILL.md'), [
        '---',
        'name: "alpha-skill"',
        'description: "Alpha import"',
        'category: "data"',
        '---',
        '',
        '# Alpha Body',
      ].join('\n'));
      fs.writeFileSync(path.join(alpha, 'scripts', 'alpha.py'), 'print("alpha")\n');
      fs.writeFileSync(path.join(alpha, '_meta.json'), JSON.stringify({
        category: 'general',
        descriptions: { zh: '旧简介' },
        routing: { negative_examples: ['beta work'] },
        source_url: 'https://example.com/source',
      }, null, 2), 'utf8');
      fs.writeFileSync(path.join(beta, 'SKILL.md'), [
        '---',
        'name: "beta-skill"',
        'description: "Beta import"',
        'category: "creation"',
        '---',
        '',
        '# Beta Body',
      ].join('\n'));
      fs.writeFileSync(path.join(beta, 'references', 'beta.md'), 'beta notes\n');

      const s = await loadSkills();
      const r = await s.createFromDir(null, null, src);

      expect(r.ok).toBe(true);
      expect(r.seedModelText).toContain('alpha-skill');
      expect(r.seedModelText).toContain('beta-skill');
      expect(r.seedModelText).not.toContain('metadata-only');
      expect(r.seedModelText!.length).toBeLessThan(140);
      expect(r.skills?.map((sk: any) => sk.id).sort()).toEqual(['alpha-skill', 'beta-skill']);
      expect(modelCalls).toHaveLength(0);
      expect(fs.existsSync(path.join(customSkillsDir(), 'skill-pack'))).toBe(false);

      const alphaDir = path.join(customSkillsDir(), 'alpha-skill');
      const betaDir = path.join(customSkillsDir(), 'beta-skill');
      expect(fs.existsSync(path.join(alphaDir, 'scripts', 'alpha.py'))).toBe(true);
      expect(fs.existsSync(path.join(betaDir, 'references', 'beta.md'))).toBe(true);
      expect(fs.existsSync(path.join(alphaDir, '_meta.json'))).toBe(true);

      const alphaMd = fs.readFileSync(path.join(alphaDir, 'SKILL.md'), 'utf8');
      const betaMd = fs.readFileSync(path.join(betaDir, 'SKILL.md'), 'utf8');
      expect(alphaMd).toContain('# Alpha Body');
      expect(betaMd).toContain('# Beta Body');
      expect(alphaMd).not.toContain('category:');
      expect(betaMd).not.toContain('category:');
      const alphaMeta = JSON.parse(fs.readFileSync(path.join(alphaDir, '_meta.json'), 'utf8'));
      const betaMeta = JSON.parse(fs.readFileSync(path.join(betaDir, '_meta.json'), 'utf8'));
      expect(alphaMeta.category).toBe('data');
      expect(alphaMeta.routing).toBeUndefined();
      expect(alphaMeta.descriptions).toBeUndefined();
      expect(alphaMeta.source_url).toBeUndefined();
      expect(alphaMeta._import).toBeUndefined();
      expect(betaMeta.category).toBe('creation');
      expect(betaMeta._import).toBeUndefined();
    } finally {
      fs.rmSync(srcParent, { recursive: true, force: true });
    }
  });

  it('installs a selected skills/ collection with direct child SKILL.md folders as a batch', async () => {
    const srcParent = fs.mkdtempSync(path.join(process.cwd(), '.tmp-skill-import-'));
    try {
      const src = path.join(srcParent, 'skills');
      const core = path.join(src, 'gsap-core');
      const timeline = path.join(src, 'gsap-timeline');
      fs.mkdirSync(core, { recursive: true });
      fs.mkdirSync(timeline, { recursive: true });
      fs.writeFileSync(path.join(src, 'llms.txt'), 'GSAP skill index\n', 'utf8');
      fs.writeFileSync(path.join(core, 'SKILL.md'), [
        '---',
        'name: gsap-core',
        'description: GSAP core animation guidance',
        'license: MIT',
        '---',
        '',
        '# GSAP Core',
      ].join('\n'));
      fs.writeFileSync(path.join(timeline, 'SKILL.md'), [
        '---',
        'name: gsap-timeline',
        'description: GSAP timeline guidance',
        'license: MIT',
        '---',
        '',
        '# GSAP Timeline',
      ].join('\n'));

      const s = await loadSkills();
      const r = await s.createFromDir(null, null, src);

      expect(r.ok).toBe(true);
      expect(r.seedModelText).toContain('gsap-core');
      expect(r.seedModelText).toContain('gsap-timeline');
      expect(r.skills?.map((sk: any) => sk.id).sort()).toEqual(['gsap-core', 'gsap-timeline']);
      expect(fs.existsSync(path.join(customSkillsDir(), 'skills'))).toBe(false);
      expect(fs.existsSync(path.join(customSkillsDir(), 'gsap-core', 'llms.txt'))).toBe(false);
      const coreMd = fs.readFileSync(path.join(customSkillsDir(), 'gsap-core', 'SKILL.md'), 'utf8');
      const timelineMd = fs.readFileSync(path.join(customSkillsDir(), 'gsap-timeline', 'SKILL.md'), 'utf8');
      expect(coreMd).toContain('# GSAP Core');
      expect(timelineMd).toContain('# GSAP Timeline');
      expect(coreMd).not.toContain('license:');
      expect(timelineMd).not.toContain('license:');
    } finally {
      fs.rmSync(srcParent, { recursive: true, force: true });
    }
  });

  it('installs a nested single source SKILL.md when the selected dir is only a collection wrapper', async () => {
    const srcParent = fs.mkdtempSync(path.join(process.cwd(), '.tmp-skill-import-'));
    try {
      const src = path.join(srcParent, 'skill-pack');
      const only = path.join(src, 'skills', 'only-skill');
      fs.mkdirSync(only, { recursive: true });
      fs.writeFileSync(path.join(src, 'README.md'), 'Collection wrapper\n', 'utf8');
      fs.writeFileSync(path.join(only, 'SKILL.md'), [
        '---',
        'name: "only-skill"',
        'description: "Only nested skill"',
        '---',
        '',
        '# Only Body',
      ].join('\n'));

      const s = await loadSkills();
      const r = await s.createFromDir(null, null, src);

      expect(r.ok).toBe(true);
      expect(r.seedModelText).toContain('only-skill');
      expect(r.skill?.id).toBe('only-skill');
      expect(fs.existsSync(path.join(customSkillsDir(), 'skill-pack'))).toBe(false);
      expect(fs.readFileSync(path.join(customSkillsDir(), 'only-skill', 'SKILL.md'), 'utf8')).toContain('# Only Body');
    } finally {
      fs.rmSync(srcParent, { recursive: true, force: true });
    }
  });

  it('skips an empty wrapper SKILL.md when nested source skills are present', async () => {
    const srcParent = fs.mkdtempSync(path.join(process.cwd(), '.tmp-skill-import-'));
    try {
      const src = path.join(srcParent, 'gsap-skills');
      const core = path.join(src, 'gsap-core');
      const timeline = path.join(src, 'gsap-timeline');
      fs.mkdirSync(core, { recursive: true });
      fs.mkdirSync(timeline, { recursive: true });
      fs.writeFileSync(path.join(src, 'SKILL.md'), [
        '---',
        'name: "gsap-skills"',
        'description: "Wrapper only"',
        '---',
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(core, 'SKILL.md'), [
        '---',
        'name: "gsap-core"',
        'description: "GSAP core"',
        '---',
        '',
        '# GSAP Core',
      ].join('\n'));
      fs.writeFileSync(path.join(timeline, 'SKILL.md'), [
        '---',
        'name: "gsap-timeline"',
        'description: "GSAP timeline"',
        '---',
        '',
        '# GSAP Timeline',
      ].join('\n'));

      const s = await loadSkills();
      const r = await s.createFromDir(null, null, src);

      expect(r.ok).toBe(true);
      expect(r.seedModelText).toContain('gsap-core');
      expect(r.seedModelText).toContain('gsap-timeline');
      expect(r.skills?.map((sk: any) => sk.id).sort()).toEqual(['gsap-core', 'gsap-timeline']);
      expect(fs.existsSync(path.join(customSkillsDir(), 'gsap-skills'))).toBe(false);
      expect(fs.readFileSync(path.join(customSkillsDir(), 'gsap-core', 'SKILL.md'), 'utf8')).toContain('# GSAP Core');
      expect(fs.readFileSync(path.join(customSkillsDir(), 'gsap-timeline', 'SKILL.md'), 'utf8')).toContain('# GSAP Timeline');
      const coreMeta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'gsap-core', '_meta.json'), 'utf8'));
      expect(coreMeta._import).toBeUndefined();
      expect(coreMeta.category).toBe('general');
    } finally {
      fs.rmSync(srcParent, { recursive: true, force: true });
    }
  });

  it('blocks unsafe directory imports until force is requested', async () => {
    const srcParent = fs.mkdtempSync(path.join(process.cwd(), '.tmp-skill-import-'));
    try {
      const src = path.join(srcParent, 'unsafe-import');
      fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(src, 'SKILL.md'), [
        '---',
        'name: "unsafe-import"',
        'description_en: "Unsafe import"',
        'category: "general"',
        '---',
        '',
        '# Body',
      ].join('\n'));
      fs.writeFileSync(path.join(src, 'scripts', 'run.py'), 'from pathlib import Path\nprint(Path(".env").read_text())\n');

      const s = await loadSkills();
      const blocked = await s.createFromDir(null, null, src);

      expect(blocked.ok).toBe(false);
      expect(blocked.report?.ok).toBe(false);
      expect(blocked.report?.violations.map((v: any) => v.rule)).toContain('no_credential_path_read');
      expect(fs.existsSync(path.join(customSkillsDir(), 'unsafe-import'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'skill', 'unsafe-import'))).toBe(false);

      const forced = await s.createFromDir(null, null, src, { force: true });
      expect(forced.ok).toBe(true);
      expect(fs.existsSync(path.join(customSkillsDir(), 'unsafe-import', 'scripts', 'run.py'))).toBe(true);
    } finally {
      fs.rmSync(srcParent, { recursive: true, force: true });
    }
  });
});

describe('skills › createFromUrl', () => {
  it('creates an editable draft without silently fetching or modeling a GitHub URL', async () => {
    const modelCalls: any[] = [];
    chatImpl.current = async (opts: any) => {
      modelCalls.push(opts);
      return { ok: true, text: JSON.stringify({ category: 'general' }), error: '', aborted: false };
    };
    const fetchMock = vi.fn(async () => new Response('unexpected'));
    vi.stubGlobal('fetch', fetchMock);

    const s = await loadSkills();
    const r = await s.createFromUrl(null, null, 'https://github.com/greensock/gsap-skills');

    expect(r.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(modelCalls).toHaveLength(0);
    expect(r.skill?.id).toBe('gsap-skills');
    expect(r.skills).toBeUndefined();
    expect(r.seedModelText).toBe('Help me install this skill: https://github.com/greensock/gsap-skills');
    expect(r.seedMessage).toBe(r.seedModelText);
    expect(fs.existsSync(path.join(customSkillsDir(), 'gsap-skills', 'SKILL.md'))).toBe(true);
  });

  it('creates an editable draft without silently fetching or modeling an ordinary web URL', async () => {
    const modelCalls: any[] = [];
    chatImpl.current = async (opts: any) => {
      modelCalls.push(opts);
      return { ok: true, text: JSON.stringify({ category: 'creation' }), error: '', aborted: false };
    };
    const fetchMock = vi.fn(async () => new Response('unexpected'));
    vi.stubGlobal('fetch', fetchMock);

    const s = await loadSkills();
    const r = await s.createFromUrl(null, null, 'https://example.com/docs/gsap-guide');

    expect(r.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(modelCalls).toHaveLength(0);
    expect(r.skill?.id).toBe('gsap-guide');
    expect(r.skills).toBeUndefined();
    expect(r.seedModelText).toBe('Help me install this skill: https://example.com/docs/gsap-guide');
    expect(r.seedMessage).toBe(r.seedModelText);
    expect(fs.existsSync(path.join(customSkillsDir(), 'gsap-guide', 'SKILL.md'))).toBe(true);
  });
});

describe('skills › updateCustomSkill', () => {
  it('rewrites SKILL.md with new description, preserving body', async () => {
    // Frontmatter name must match the dir id; otherwise updateCustomSkill
    // treats meta.name as a rename target and refuses "already exists".
    writeCustomSkill('alpha', 'name: "alpha"\ndescription: "old"', 'original body content');
    const s = await loadSkills();
    const updated = await s.updateCustomSkill('alpha', { description: 'new desc' });
    expect(updated?.description_en).toBe('new desc');
    const md = fs.readFileSync(path.join(customSkillsDir(), 'alpha', 'SKILL.md'), 'utf8');
    expect(md).toContain('original body content');
    expect(md).toContain('description: "new desc"');
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'alpha', '_meta.json'), 'utf8'));
    expect(meta.descriptions).toBeUndefined();
    expect(meta.description_zh).toBeUndefined();
    expect(meta.description_en).toBeUndefined();
  });

  it('stores a single description update in SKILL.md without sidecar localization', async () => {
    const { setLanguage } = await import('../../../src/main/features/config');
    setLanguage('zh');
    writeCustomSkill('alpha', 'name: "alpha"\ndescription: "old English"', 'body');
    const s = await loadSkills();

    const updated = await s.updateCustomSkill('alpha', { description: 'plain English while UI is zh' });

    expect(updated?.description_zh).toBe('');
    expect(updated?.description_en).toBe('plain English while UI is zh');
    const md = fs.readFileSync(path.join(customSkillsDir(), 'alpha', 'SKILL.md'), 'utf8');
    expect(md).toContain('description: "plain English while UI is zh"');
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'alpha', '_meta.json'), 'utf8'));
    expect(meta.descriptions).toBeUndefined();
    expect(meta.description_zh).toBeUndefined();
    expect(meta.description_en).toBeUndefined();
  });

  it('renames the skill dir when name changes', async () => {
    writeCustomSkill('alpha');
    const s = await loadSkills();
    const updated = await s.updateCustomSkill('alpha', { name: 'beta' });
    expect(updated?.id).toBe('beta');
    expect(fs.existsSync(path.join(customSkillsDir(), 'alpha'))).toBe(false);
    expect(fs.existsSync(path.join(customSkillsDir(), 'beta'))).toBe(true);
  });

  it('supports two-phase name edits with skipRename before final rename', async () => {
    writeCustomSkill('alpha', 'name: "alpha"\ndescription_en: "x"', 'body');
    const s = await loadSkills();

    const staged = await s.updateCustomSkill('alpha', { name: 'beta' }, { skipRename: true });
    expect(staged?.id).toBe('alpha');
    expect(fs.existsSync(path.join(customSkillsDir(), 'alpha'))).toBe(true);
    expect(fs.existsSync(path.join(customSkillsDir(), 'beta'))).toBe(false);
    expect(fs.readFileSync(path.join(customSkillsDir(), 'alpha', 'SKILL.md'), 'utf8'))
      .toContain('name: "beta"');

    const committed = await s.updateCustomSkill('alpha', { name: 'beta' });
    expect(committed?.id).toBe('beta');
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

describe('skills › discardImportDraftIfPristine', () => {
  it('deletes an untouched placeholder (only SKILL.md, empty body)', async () => {
    const s = await loadSkills();
    await s.createCustomSkill('draft1', 'desc'); // writes boilerplate, empty body
    expect(await s.discardImportDraftIfPristine('draft1')).toBe(true);
    expect(fs.existsSync(path.join(customSkillsDir(), 'draft1'))).toBe(false);
  });

  it('keeps a skill that was authored (non-empty body)', async () => {
    writeCustomSkill('authored', 'name: "authored"\ndescription: "d"', '# How to use\nReal content.');
    const s = await loadSkills();
    expect(await s.discardImportDraftIfPristine('authored')).toBe(false);
    expect(fs.existsSync(path.join(customSkillsDir(), 'authored'))).toBe(true);
  });

  it('keeps a placeholder that has extra files even with empty body', async () => {
    const s = await loadSkills();
    await s.createCustomSkill('withfile', 'desc');
    fs.writeFileSync(path.join(customSkillsDir(), 'withfile', 'notes.md'), 'x');
    expect(await s.discardImportDraftIfPristine('withfile')).toBe(false);
    expect(fs.existsSync(path.join(customSkillsDir(), 'withfile'))).toBe(true);
  });

  it('deletes a marked import draft only when it is still an empty placeholder', async () => {
    const s = await loadSkills();
    await s.createCustomSkill('marked-empty', 'desc');
    markImportDraft('marked-empty');

    expect(await s.discardImportDraftIfPristine('marked-empty')).toBe(true);
    expect(fs.existsSync(path.join(customSkillsDir(), 'marked-empty'))).toBe(false);
  });

  it('keeps a marked import draft that contains copied source files', async () => {
    const s = await loadSkills();
    await s.createCustomSkill('dir-draft', 'desc');
    markImportDraft('dir-draft');
    fs.writeFileSync(path.join(customSkillsDir(), 'dir-draft', 'source.md'), '# source\n', 'utf8');

    expect(await s.discardImportDraftIfPristine('dir-draft')).toBe(false);
    expect(fs.existsSync(path.join(customSkillsDir(), 'dir-draft'))).toBe(true);
  });

  it('keeps a marked import draft after SKILL.md has real body content', async () => {
    const s = await loadSkills();
    await s.createCustomSkill('body-draft', 'desc');
    markImportDraft('body-draft');
    fs.writeFileSync(
      path.join(customSkillsDir(), 'body-draft', 'SKILL.md'),
      '---\nname: body-draft\ndescription: desc\n---\n\n# Real content\n',
      'utf8',
    );

    expect(await s.discardImportDraftIfPristine('body-draft')).toBe(false);
    expect(fs.existsSync(path.join(customSkillsDir(), 'body-draft'))).toBe(true);
  });

  it('clears the import draft marker when a normal file edit succeeds', async () => {
    const s = await loadSkills();
    await s.createCustomSkill('edited-draft', 'desc');
    markImportDraft('edited-draft');

    expect(s.writeCustomSkillFile('edited-draft', 'notes.md', '# note')).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'edited-draft', '_meta.json'), 'utf8'));
    expect(meta._import).toBeUndefined();
  });

  it('clears the import draft marker when skill metadata is updated', async () => {
    const s = await loadSkills();
    await s.createCustomSkill('metadata-draft', 'desc');
    markImportDraft('metadata-draft');

    await s.updateCustomSkill('metadata-draft', { description: 'updated desc' });
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'metadata-draft', '_meta.json'), 'utf8'));
    expect(meta._import).toBeUndefined();
  });

  it('returns false for a missing skill', async () => {
    const s = await loadSkills();
    expect(await s.discardImportDraftIfPristine('ghost')).toBe(false);
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

  it('normalizes SKILL.md writes to Orkas-supported frontmatter fields', async () => {
    writeCustomSkill('alpha', 'name: "alpha"\ndescription_en: "old"\ncategory: "general"', 'old body');
    const s = await loadSkills();
    const result = s.writeCustomSkillFileChecked('alpha', 'SKILL.md', [
      '---',
      'name: "alpha"',
      'description: "Legacy English"',
      'description_zh: "中文简介"',
      'category: "Data"',
      'display_name: "Alpha"',
      'version: "9.9.9"',
      'author: "someone"',
      '---',
      '',
      '# New Body',
    ].join('\n'));

    expect(result.ok).toBe(true);
    const md = fs.readFileSync(path.join(customSkillsDir(), 'alpha', 'SKILL.md'), 'utf8');
    expect(md).toContain('name: "alpha"');
    expect(md).toContain('description:');
    expect(md).not.toContain('description_zh:');
    expect(md).not.toContain('description_en:');
    expect(md).not.toContain('category:');
    expect(md).toContain('# New Body');
    expect(md).not.toMatch(/display_name|version|author/);
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'alpha', '_meta.json'), 'utf8'));
    expect(meta.descriptions).toBeUndefined();
    expect(meta.category).toBe('data');
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

  it('hides marketplace/tooling sidecars from the visible source tree', async () => {
    writeCustomSkill('alpha');
    const dir = path.join(customSkillsDir(), 'alpha');
    fs.writeFileSync(path.join(dir, '_install.json'), '{}');
    fs.writeFileSync(path.join(dir, '_cache.json'), '{}');
    fs.writeFileSync(path.join(dir, '_resource_manifest.json'), '{}');
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');
    fs.mkdirSync(path.join(dir, '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(dir, '__pycache__', 'ignored.pyc'), '');
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.js'), '');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), '');
    fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'coverage', 'lcov.info'), '');
    fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cache', 'state.json'), '');
    fs.writeFileSync(path.join(dir, 'npm-debug.log'), '');
    fs.writeFileSync(path.join(dir, 'tsconfig.tsbuildinfo'), '');
    fs.writeFileSync(path.join(dir, 'deck.pptx.bak-20260604T123456'), '');
    fs.writeFileSync(path.join(dir, 'visible.md'), 'ok');
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'template.pptx'), 'template');

    const s = await loadSkills();
    const r = await s.listSkillTree('custom', 'alpha');
    expect(r.ok).toBe(true);
    const names = (r as any).tree.map((n: any) => n.name);
    expect(names).toContain('visible.md');
    expect(names).toContain('assets');
    expect(names).not.toContain('_install.json');
    expect(names).not.toContain('_cache.json');
    expect(names).not.toContain('_resource_manifest.json');
    expect(names).not.toContain('.DS_Store');
    expect(names).not.toContain('__pycache__');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('dist');
    expect(names).not.toContain('coverage');
    expect(names).not.toContain('.cache');
    expect(names).not.toContain('npm-debug.log');
    expect(names).not.toContain('tsconfig.tsbuildinfo');
    expect(names).not.toContain('deck.pptx.bak-20260604T123456');
  });

  it('error for missing skill', async () => {
    const s = await loadSkills();
    const r = await s.listSkillTree('custom', 'ghost');
    expect(r.ok).toBe(false);
  });
});

describe('skills › buildSkillEditSystemPrompt', () => {
  it('renders template with skill metadata + file list, no leftover placeholders', async () => {
    writeCustomSkill('alpha', 'name: "Alpha"\ndescription: "a demo"\ncategory: "writing"', 'body text');
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
    expect(sys).not.toMatch(/\$skill_name|\$skill_description|\$skill_category|\$category_field_definition|\$skill_dir|\$skill_files/);
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
    const { setLanguage } = await import('../../../src/main/features/config');
    setLanguage('zh');
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

  it('applies skill-meta blocks and emits metadata progress', async () => {
    streamImpl.current = async function* () {
      yield {
        type: 'final',
        text: '已调整分类。\n<skill-meta>\n<category>data</category>\n</skill-meta>',
      };
    };
    writeCustomSkill('alpha', 'name: "alpha"\ndescription_en: "x"\ncategory: "general"', 'body');

    const s = await loadSkills();
    const events: any[] = [];
    for await (const ev of s.streamSendToSkillChat('u1', 'alpha', 'edit')) {
      events.push(ev);
    }

    expect(events.filter((e) => e.type === 'progress').map((e) => e.text))
      .toContain('▶ 更新技能元信息');
    const md = fs.readFileSync(path.join(customSkillsDir(), 'alpha', 'SKILL.md'), 'utf8');
    expect(md).not.toContain('category: "data"');
    expect(md).toContain('body');
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'alpha', '_meta.json'), 'utf8'));
    expect(meta.category).toBe('data');
    expect(events.find((e) => e.type === 'final')?.text).toBe('已完成技能更新。');
  });

  it('applies routing metadata without rewriting SKILL.md', async () => {
    streamImpl.current = async function* () {
      yield {
        type: 'final',
        text: [
          '<skill-meta>',
          '<category>data</category>',
          '<negative_examples>',
          '- write ad copy',
          '- create a logo',
          '</negative_examples>',
          '<applicable_domain>research notes</applicable_domain>',
          '<prerequisites>',
          '- imported notes are present',
          '</prerequisites>',
          '</skill-meta>',
        ].join('\n'),
      };
    };
    writeCustomSkill('alpha', 'name: "alpha"\ndescription: "x"', '# body stays');

    const s = await loadSkills();
    const events: any[] = [];
    for await (const ev of s.streamSendToSkillChat('u1', 'alpha', 'edit')) {
      events.push(ev);
    }

    const md = fs.readFileSync(path.join(customSkillsDir(), 'alpha', 'SKILL.md'), 'utf8');
    expect(md).toContain('# body stays');
    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'alpha', '_meta.json'), 'utf8'));
    expect(meta.category).toBe('data');
    expect(meta.routing).toEqual({
      negative_examples: ['write ad copy', 'create a logo'],
      applicable_domain: 'research notes',
      prerequisites: ['imported notes are present'],
    });
    expect(events.filter((e) => e.type === 'progress').map((e) => e.text))
      .toContain('▶ 更新技能元信息');
  });

  it('uses explicit skill-reply as the visible final text for mutation turns', async () => {
    streamImpl.current = async function* () {
      yield {
        type: 'final',
        text: [
          '<skill-reply>已整理好这个技能。</skill-reply>',
          'Now emitting the completed skill:',
          '<<<skill-file path=SKILL.md',
          '---',
          'name: "alpha"',
          'description: "整理增长研究材料"',
          '---',
          '',
          '## 何时使用',
          '用于增长研究。',
          '>>>',
        ].join('\n'),
      };
    };
    writeCustomSkill('alpha');

    const s = await loadSkills();
    const events: any[] = [];
    for await (const ev of s.streamSendToSkillChat('u1', 'alpha', 'edit')) {
      events.push(ev);
    }

    const finalText = events.find((e) => e.type === 'final')?.text || '';
    expect(finalText).toBe('已整理好这个技能。');
    expect(finalText).not.toContain('Now emitting');
    expect(finalText).not.toContain('skill-file');
  });

  it('absorbs outer skill metadata containers in inline edit chat without showing raw config', async () => {
    streamImpl.current = async function* () {
      yield {
        type: 'final',
        text: '技能目录中已有参考文档，已直接完成整理。\n<skill>\n<category>general</category>\n</skill>',
      };
    };
    writeCustomSkill('alpha', 'name: "alpha"\ndescription_en: "x"\ncategory: "data"', 'body');

    const s = await loadSkills();
    const events: any[] = [];
    for await (const ev of s.streamSendToSkillChat('u1', 'alpha', 'edit')) {
      events.push(ev);
    }

    const finalText = events.find((e) => e.type === 'final')?.text || '';
    expect(finalText).toBe('已完成技能更新。');
    expect(finalText).not.toContain('<skill>');
    expect(events.filter((e) => e.type === 'progress').map((e) => e.text))
      .toContain('▶ 更新技能元信息');

    const meta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'alpha', '_meta.json'), 'utf8'));
    expect(meta.category).toBe('general');

    const chatPath = path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'skill', 'alpha', 'chat.jsonl');
    const lines = fs.readFileSync(chatPath, 'utf8').trim().split('\n');
    const assistantMsg = JSON.parse(lines[lines.length - 1]);
    expect(assistantMsg.content).toBe('已完成技能更新。');
    expect(assistantMsg.content).not.toContain('<skill>');
    expect(assistantMsg.process.map((p: any) => p.text)).toContain('▶ 更新技能元信息');
  });

  it('hides skill-file content from live deltas before final parsing', async () => {
    const skillMd = [
      '---',
      'name: "alpha"',
      'description: "整理增长研究材料"',
      '---',
      '',
      '## 何时使用',
      '用于增长研究。',
    ].join('\n');
    const raw = `Now emitting the completed skill:\n<<<skill-file path=SKILL.md\n${skillMd}\n>>>`;
    streamImpl.current = async function* () {
      yield { type: 'delta', text: '已根据资料整理技能。\n<<<skill-file path=SKILL.md\n---\nname: "alpha"\n' };
      yield { type: 'delta', text: 'description: "整理增长研究材料"\n---\n\n## 何时使用\n用于增长研究。\n>>>' };
      yield { type: 'final', text: raw };
    };
    writeCustomSkill('alpha');

    const s = await loadSkills();
    const events: any[] = [];
    for await (const ev of s.streamSendToSkillChat('u1', 'alpha', 'edit')) {
      events.push(ev);
    }

    const liveText = events.filter((e) => e.type === 'delta').map((e) => e.text || '').join('');
    expect(liveText).toBe('');
    expect(liveText).not.toContain('SKILL.md');
    expect(liveText).not.toContain('整理增长研究材料');
    const finalText = events.find((e) => e.type === 'final')?.text || '';
    expect(finalText).toBe('已完成技能更新。');
    expect(finalText).not.toContain('Now emitting');
    expect(events.filter((e) => e.type === 'progress').map((e) => e.text))
      .toContain('▶ 写入 SKILL.md');
  });

  it('creates multiple skills from outer skill containers in an import draft', async () => {
    streamImpl.current = async function* () {
      yield {
        type: 'final',
        text: [
          '<skill>',
          '<<<skill-file path=SKILL.md',
          '---',
          'name: "alpha-skill"',
          'description: "Alpha imported skill"',
          '---',
          '',
          '# Alpha',
          '>>>',
          '</skill>',
          '<skill>',
          '<<<skill-file path=SKILL.md',
          '---',
          'name: "beta-skill"',
          'description: "Beta imported skill"',
          '---',
          '',
          '# Beta',
          '>>>',
          '</skill>',
        ].join('\n'),
      };
    };
    writeCustomSkill('import-draft', 'name: "import-draft"\ndescription: "pending"', '');
    fs.writeFileSync(
      path.join(customSkillsDir(), 'import-draft', '_meta.json'),
      JSON.stringify({ _import: { draft: true, source: 'dir' } }, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(customSkillsDir(), 'import-draft', 'source-notes.md'), 'source material\n', 'utf8');

    const s = await loadSkills();
    const events: any[] = [];
    for await (const ev of s.streamSendToSkillChat('u1', 'import-draft', 'import these skills')) {
      events.push(ev);
    }

    expect(fs.existsSync(path.join(customSkillsDir(), 'import-draft'))).toBe(false);
    expect(fs.existsSync(path.join(customSkillsDir(), 'alpha-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(customSkillsDir(), 'beta-skill', 'SKILL.md'))).toBe(true);
    const alphaMeta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'alpha-skill', '_meta.json'), 'utf8'));
    expect(alphaMeta._import).toBeUndefined();
    expect(events.filter((e) => e.type === 'progress').map((e) => e.text))
      .toEqual(expect.arrayContaining(['▶ 更新技能 alpha-skill', '▶ 创建技能 beta-skill']));
    const renamed = events.find((e) => e.type === 'event' && e.event?.stream === 'skill_renamed');
    expect(renamed?.event?.data).toEqual({ oldId: 'import-draft', newId: 'alpha-skill' });
    const replaced = events.find((e) => e.type === 'event' && e.event?.stream === 'skill_import_replaced');
    expect(replaced).toBeUndefined();
    const final = events.find((e) => e.type === 'final');
    expect(final?.text).toBe('已完成技能导入，共创建 2 个技能。');
    expect(final?.created.map((c: any) => c.skill_id))
      .toEqual(['alpha-skill', 'beta-skill']);
    expect(final?.created.map((c: any) => c.kind))
      .toEqual(['updated', 'created']);
  });

  it('metadata-checks directly installed multi-skill imports without rewriting existing files', async () => {
    const srcParent = fs.mkdtempSync(path.join(process.cwd(), '.tmp-skill-import-'));
    try {
      const src = path.join(srcParent, 'skill-pack');
      const alpha = path.join(src, 'alpha-skill');
      const beta = path.join(src, 'beta-skill');
      fs.mkdirSync(alpha, { recursive: true });
      fs.mkdirSync(beta, { recursive: true });
      fs.writeFileSync(path.join(alpha, 'SKILL.md'), [
        '---',
        'name: "alpha-skill"',
        'description: "Alpha import"',
        '---',
        '',
        '# Alpha Body',
      ].join('\n'));
      fs.writeFileSync(path.join(beta, 'SKILL.md'), [
        '---',
        'name: "beta-skill"',
        'description: "Beta import"',
        '---',
        '',
        '# Beta Body',
      ].join('\n'));

      const s = await loadSkills();
      const imported = await s.createFromDir(null, null, src);
      expect(imported.ok).toBe(true);
      expect(imported.seedModelText).toContain('alpha-skill');
      expect(imported.seedModelText).toContain('beta-skill');
      expect(imported.seedModelText).not.toContain('SKILL.md');

      streamImpl.current = async function* () {
        yield {
          type: 'final',
          text: [
            '<skill>',
            '<skill_id>alpha-skill</skill_id>',
            '<category>data</category>',
            '<negative_examples>',
            '- write an ad',
            '</negative_examples>',
            '<<<skill-file path=SKILL.md',
            '---',
            'name: "alpha-skill"',
            'description: "Should not land"',
            '---',
            '',
            '# Rewritten',
            '>>>',
            '</skill>',
            '<skill>',
            '<skill_id>beta-skill</skill_id>',
            '<category>creation</category>',
            '<<<skill-file path=SKILL.md',
            '---',
            'name: "beta-skill"',
            'description: "Should also not land"',
            '---',
            '',
            '# Beta Rewritten',
            '>>>',
            '</skill>',
          ].join('\n'),
        };
      };

      const events: any[] = [];
      for await (const ev of s.streamSendToSkillChat('u1', 'alpha-skill', '整理已导入的技能')) {
        events.push(ev);
      }

      const alphaMd = fs.readFileSync(path.join(customSkillsDir(), 'alpha-skill', 'SKILL.md'), 'utf8');
      const betaMd = fs.readFileSync(path.join(customSkillsDir(), 'beta-skill', 'SKILL.md'), 'utf8');
      expect(alphaMd).toContain('# Alpha Body');
      expect(alphaMd).not.toContain('Should not land');
      expect(alphaMd).not.toContain('# Rewritten');
      expect(betaMd).toContain('# Beta Body');
      expect(betaMd).not.toContain('Should also not land');
      expect(betaMd).not.toContain('# Beta Rewritten');

      const alphaMeta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'alpha-skill', '_meta.json'), 'utf8'));
      const betaMeta = JSON.parse(fs.readFileSync(path.join(customSkillsDir(), 'beta-skill', '_meta.json'), 'utf8'));
      expect(alphaMeta.category).toBe('data');
      expect(alphaMeta.routing.negative_examples).toEqual(['write an ad']);
      expect(alphaMeta.descriptions).toBeUndefined();
      expect(betaMeta.category).toBe('creation');
      expect(betaMeta.descriptions).toBeUndefined();

      const progress = events.filter((e) => e.type === 'progress').map((e) => e.text);
      expect(progress.filter((text) => text === '◯ 拒绝写入 SKILL.md')).toHaveLength(2);
      expect(progress).toContain('▶ 更新技能 beta-skill');
      expect(events.find((e) => e.type === 'final')?.text).toBe('已完成技能更新。');

      const chatMeta = JSON.parse(fs.readFileSync(
        path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'skill', 'alpha-skill', 'chat.json'),
        'utf8',
      ));
      expect(chatMeta.import_meta_targets).toBeUndefined();
    } finally {
      fs.rmSync(srcParent, { recursive: true, force: true });
    }
  });

  it('clears direct-import metadata-only state after model errors', async () => {
    const srcParent = fs.mkdtempSync(path.join(process.cwd(), '.tmp-skill-import-'));
    try {
      const src = path.join(srcParent, 'alpha-skill');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'SKILL.md'), [
        '---',
        'name: "alpha-skill"',
        'description: "Alpha import"',
        '---',
        '',
        '# Alpha Body',
      ].join('\n'));

      const s = await loadSkills();
      const imported = await s.createFromDir(null, null, src);
      expect(imported.ok).toBe(true);

      streamImpl.current = async function* () {
        yield { type: 'error', text: 'model unavailable' };
      };

      const events: any[] = [];
      for await (const ev of s.streamSendToSkillChat('u1', 'alpha-skill', '整理已导入的技能')) {
        events.push(ev);
      }

      expect(events.find((e) => e.type === 'error')?.text).toBe('model unavailable');
      const chatMeta = JSON.parse(fs.readFileSync(
        path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'skill', 'alpha-skill', 'chat.json'),
        'utf8',
      ));
      expect(chatMeta.import_meta_targets).toBeUndefined();
      expect(chatMeta.import_meta_created_at).toBeUndefined();
      expect(chatMeta.session_id).toBe('skill-alpha-skill');
    } finally {
      fs.rmSync(srcParent, { recursive: true, force: true });
    }
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

  it('uses modelText for the model while persisting short visible content', async () => {
    let seenOpts: any = null;
    streamImpl.current = async function* (opts: any) {
      seenOpts = opts;
      yield { type: 'final', text: 'done' };
    };
    writeCustomSkill('alpha');

    const s = await loadSkills();
    for await (const _ev of s.streamSendToSkillChat('u1', 'alpha', '整理已导入的技能', {
      modelText: '请读取 SKILL.md 和导入资料，并直接整理完整技能。',
    })) {
      // drain
    }

    expect(seenOpts.message).toBe('请读取 SKILL.md 和导入资料，并直接整理完整技能。');
    const chatPath = path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'skill', 'alpha', 'chat.jsonl');
    const first = JSON.parse(fs.readFileSync(chatPath, 'utf8').trim().split('\n')[0]);
    expect(first.role).toBe('user');
    expect(first.content).toBe('整理已导入的技能');
    expect(first.model_text).toBe('请读取 SKILL.md 和导入资料，并直接整理完整技能。');
  });

  it('passes edit-chat attachments into the model prompt and history', async () => {
    let seenOpts: any = null;
    streamImpl.current = async function* (opts: any) {
      seenOpts = opts;
      yield { type: 'final', text: 'read attachment' };
    };
    writeCustomSkill('alpha');
    const attDir = path.join(tmpDir, TEST_UID, 'cloud', 'chat_attachments', 'skill-edit-alpha');
    fs.mkdirSync(attDir, { recursive: true });
    fs.writeFileSync(path.join(attDir, 'brief.txt'), 'skill brief');

    const s = await loadSkills();
    for await (const _ev of s.streamSendToSkillChat('u1', 'alpha', 'make changes', { attachments: ['brief.txt'] })) {
      // drain
    }

    expect(seenOpts.message).toContain('<attachments>');
    expect(seenOpts.message).toContain('brief.txt');
    expect(seenOpts.message).toContain('make changes');
    expect(seenOpts.readOnlyExtraRoots).toContain(attDir);

    const chatPath = path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'skill', 'alpha', 'chat.jsonl');
    const first = JSON.parse(fs.readFileSync(chatPath, 'utf8').trim().split('\n')[0]);
    expect(first.role).toBe('user');
    expect(first.attachments).toEqual(['brief.txt']);
    expect(first.attachment_cid).toBe('skill-edit-alpha');
  });
});

// (The legacy marketplace-sentinel sync tests are gone. Marketplace installs now live at
// `<uid>/local/marketplace/skills/<id>/` and are reconciled from
// the cloud-synced `installs.json` manifest — see features/marketplace_*.ts.)
