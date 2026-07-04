import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Swap the LLM stream impl per test — mirrors chats.test.ts pattern so
// streamSendToAgentEditChat tests can feed synthetic final events.
const streamImpl: { current: null | ((opts: any) => AsyncGenerator<any, void, unknown>) } = { current: null };
vi.mock('../../../src/main/model/client', () => ({
  streamChatWithModel: (opts: any) => {
    if (streamImpl.current) return streamImpl.current(opts);
    // Default: yield nothing so non-stream tests that still touch this
    // module (rare) don't blow up on require. Most agents.test.ts tests
    // never hit this mock.
    return (async function* () { /* empty */ })();
  },
  chatWithModel: vi.fn(async () => ({ ok: true, text: 'ok', error: '', aborted: false })),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-agents-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  streamImpl.current = null;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function loadAgents() {
  return import('../../../src/main/features/agents');
}

// New layout: custom agents live under <uid>/cloud/agents (no more shared/
// prefix, no more custom/ subdir — the loader distinguishes builtin vs
// custom by source root).
function customAgentsDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'agents');
}

// Platform (marketplace-installed) agents live under <uid>/local/marketplace/agents/.
function builtinAgentsDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'marketplace', 'agents');
}

function writeCustomAgent(agentId: string, fields: Partial<Record<string, any>> = {}): void {
  // Agent directory shape: `agents/<aid>/agent.json` (see docs/plans/agent-as-directory.md).
  const dir = path.join(customAgentsDir(), agentId);
  fs.mkdirSync(dir, { recursive: true });
  const data: Record<string, any> = {
    agent_id: agentId,
    name: fields.name ?? agentId,
    description: fields.description ?? 'Test agent',
    category: fields.category ?? 'general',
    workflow: fields.workflow ?? '',
    created_at: '2026-04-18T10:00:00',
    updated_at: '2026-04-18T10:00:00',
  };
  if ('skill_list' in fields) data.skill_list = fields.skill_list;
  if ('runtime' in fields) data.runtime = fields.runtime;
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(data));
}

function customSkillsDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'skills');
}

function writeSkillOnDisk(id: string, name = id): void {
  const dir = path.join(customSkillsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, `description: test skill ${name}`, '---', '', 'body'];
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'));
}

function packagesDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'packages');
}

function writeExternalPackageSkill(pkgName: string, skillId: string): string {
  const root = path.join(packagesDir(), pkgName, 'skills');
  const skillDir = path.join(root, skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    `name: ${skillId}`,
    `description: external skill ${skillId}`,
    '---',
    '',
    'body',
  ].join('\n'));
  fs.mkdirSync(packagesDir(), { recursive: true });
  fs.writeFileSync(path.join(packagesDir(), '_registry.json'), JSON.stringify({
    version: 1,
    packages: [{
      name: pkgName,
      kind: 'skill',
      skill_roots: ['skills'],
      bin_entries: [],
      enabled: true,
    }],
  }));
  return root;
}

describe('agents › normalizeAgent', () => {
  it('returns null for missing agent_id', async () => {
    const a = await loadAgents();
    expect(a.normalizeAgent({}, 'custom')).toBeNull();
    expect(a.normalizeAgent(null as any, 'custom')).toBeNull();
  });

  it('coerces non-string fields to empty', async () => {
    const a = await loadAgents();
    const norm = a.normalizeAgent({ agent_id: 'x', name: 42 as any }, 'custom');
    expect(norm?.name).toBe('');
    expect(norm?.description_zh).toBe('');
    expect(norm?.description_en).toBe('');
    expect(norm?.workflow).toBe('');
  });

  it('preserves string fields and source', async () => {
    const a = await loadAgents();
    // Legacy `description` (English) migrates to `description_en`; pure
    // descripion_zh / description_en inputs route through directly.
    const norm = a.normalizeAgent({
      agent_id: 'x', name: 'N', description: 'D', workflow: 'W',
      created_at: 't1', updated_at: 't2',
    }, 'marketplace');
    expect(norm).toEqual({
      agent_id: 'x', name: 'N',
      description_zh: '', description_en: 'D',
      workflow: 'W',
      source: 'marketplace', created_at: 't1', updated_at: 't2',
      category: '',
      // computed-at-load default; overridden by listAgents/getAgent at the boundary
      enabled: true,
    });
    // skill_list omitted from raw → not set on norm (undefined sentinel,
    // NOT []); kept as absent dependency metadata.
    expect('skill_list' in (norm as any)).toBe(false);
  });

  it('preserves skill_list when present as string array', async () => {
    const a = await loadAgents();
    const norm = a.normalizeAgent({
      agent_id: 'x', name: 'N',
      skill_list: ['translate', 'summarize'],
    }, 'custom');
    expect(norm?.skill_list).toEqual(['translate', 'summarize']);
  });

  it('treats skill_list = [] as explicit zero skills (kept, not coerced to undefined)', async () => {
    const a = await loadAgents();
    const norm = a.normalizeAgent({ agent_id: 'x', name: 'N', skill_list: [] }, 'custom');
    expect(norm?.skill_list).toEqual([]);
  });

  it('filters non-string and non-safeId entries from skill_list', async () => {
    const a = await loadAgents();
    const norm = a.normalizeAgent({
      agent_id: 'x', name: 'N',
      skill_list: ['ok-one', 42, null, '', '../evil', 'also_ok'],
    } as any, 'custom');
    expect(norm?.skill_list).toEqual(['ok-one', 'also_ok']);
  });

  it('normalizes rich profile fields and design aliases', async () => {
    const a = await loadAgents();
    const norm = a.normalizeAgent({
      agent_id: 'x',
      name: 'Video',
      skill_list: ['canonical-skill'],
      role: '短视频 · 产品片',
      profile: {
        skills: [{ title: 'legacy-profile-skill' }],
        knowhow: [
          { title: 'Legacy embedded knowhow', description: 'Should lose to the top-level field.' },
        ],
      },
      knowhow: ['Task framing'],
      standards: ['Traceable output'],
      skills: [{ title: 'legacy-top-level-skill' }],
      flow: [
        { n: '读脚本', d: '确认平台、时长与风格', tool: 'docs' },
        { n: '写分镜', d: '输出镜头表' },
      ],
      memory: [
        { t: '品牌调性', d: '简洁、克制' },
        { t: '旧反馈', d: '已忘记', kept: false },
      ],
      doYes: ['短视频'],
      doNo: ['真人实拍'],
    } as any, 'custom');

    expect(norm?.profile?.role).toBe('短视频 · 产品片');
    expect(norm?.profile?.knowhow).toEqual(['Task framing']);
    expect(norm?.profile?.standards).toEqual(['Traceable output']);
    expect('workflow' in ((norm?.profile || {}) as any)).toBe(false);
    expect('memory' in ((norm?.profile || {}) as any)).toBe(false);
    expect(norm?.profile?.scope).toEqual({ accepts: ['短视频'], rejects: ['真人实拍'] });
    expect(norm?.skill_list).toEqual(['canonical-skill']);
    expect('skills' in ((norm?.profile || {}) as any)).toBe(false);
  });

  // interactive is read by `groupChat.listMembers` to drive the input-box
  // auto-target; the renderer treats undefined as false. Tolerant string
  // coercion exists because LLMs sometimes emit `"true"` / `"false"` instead
  // of the JSON literal — anything else must round-trip to undefined so
  // a corrupt value can't silently flip the flag.
  it('preserves boolean interactive verbatim', async () => {
    const a = await loadAgents();
    expect(a.normalizeAgent({ agent_id: 'x', interactive: true }, 'custom')?.interactive).toBe(true);
    expect(a.normalizeAgent({ agent_id: 'x', interactive: false }, 'custom')?.interactive).toBe(false);
  });

  it('coerces "true"/"false" string interactive to boolean', async () => {
    const a = await loadAgents();
    expect(a.normalizeAgent({ agent_id: 'x', interactive: 'true' }, 'custom')?.interactive).toBe(true);
    expect(a.normalizeAgent({ agent_id: 'x', interactive: 'false' }, 'custom')?.interactive).toBe(false);
  });

  it('leaves interactive undefined when raw value is missing or malformed', async () => {
    const a = await loadAgents();
    expect('interactive' in (a.normalizeAgent({ agent_id: 'x' }, 'custom') as any)).toBe(false);
    for (const bad of [1, 0, 'yes', null, {}, [] as any]) {
      const norm = a.normalizeAgent({ agent_id: 'x', interactive: bad as any }, 'custom');
      expect('interactive' in (norm as any)).toBe(false);
    }
  });

  it('leaves skill_list undefined when raw field is not an array', async () => {
    const a = await loadAgents();
    for (const bad of ['str', 123, { a: 1 }, null]) {
      const norm = a.normalizeAgent({ agent_id: 'x', name: 'N', skill_list: bad } as any, 'custom');
      expect(norm).toBeTruthy();
      expect('skill_list' in (norm as any)).toBe(false);
    }
  });

  it('passes through a valid CLI runtime', async () => {
    const a = await loadAgents();
    const norm = a.normalizeAgent({
      agent_id: 'x', name: 'N',
      runtime: { kind: 'cli', cli: 'claude', model: 'claude-opus-4-7', custom_args: ['--debug'] },
    } as any, 'custom');
    expect(norm?.runtime).toEqual({
      kind: 'cli', cli: 'claude', model: 'claude-opus-4-7', custom_args: ['--debug'],
    });
    expect(a.isCliAgent(norm)).toBe(true);
  });

  it('drops malformed runtime entries (no field set)', async () => {
    const a = await loadAgents();
    for (const bad of [
      null,
      'cli',
      { kind: 'wat' },
      { kind: 'cli' },          // missing cli name
      { kind: 'cli', cli: '' }, // empty cli name
    ]) {
      const norm = a.normalizeAgent({ agent_id: 'x', name: 'N', runtime: bad } as any, 'custom');
      expect(norm).toBeTruthy();
      expect('runtime' in (norm as any)).toBe(false);
      expect(a.isCliAgent(norm)).toBe(false);
    }
  });

  it('normalizes in_process runtime but does not flag as CLI', async () => {
    const a = await loadAgents();
    const norm = a.normalizeAgent({
      agent_id: 'x', name: 'N',
      runtime: { kind: 'in_process' },
    } as any, 'custom');
    expect(norm?.runtime).toEqual({ kind: 'in_process' });
    expect(a.isCliAgent(norm)).toBe(false);
  });

  it('drops non-string custom_args entries', async () => {
    const a = await loadAgents();
    const norm = a.normalizeAgent({
      agent_id: 'x', name: 'N',
      runtime: { kind: 'cli', cli: 'claude', custom_args: ['--ok', 42, null, '--other'] as any },
    } as any, 'custom');
    expect(norm?.runtime).toEqual({
      kind: 'cli', cli: 'claude', custom_args: ['--ok', '--other'],
    });
  });

  it('keeps category and only recognized output_format values', async () => {
    const a = await loadAgents();
    expect(a.normalizeAgent({
      agent_id: 'x',
      category: 'data',
      output_format: 'text',
    }, 'custom')).toMatchObject({ category: 'data', output_format: 'text' });

    expect(a.normalizeAgent({
      agent_id: 'x',
      output_format: 'markdown_only',
    }, 'custom')).toMatchObject({ output_format: 'text' });

    const bad = a.normalizeAgent({
      agent_id: 'x',
      category: 42 as any,
      output_format: 'future-format' as any,
    }, 'custom');
    expect(bad?.category).toBe('');
    expect('output_format' in (bad as any)).toBe(false);
  });
});

describe('agents › CLI project directory settings', () => {
  it('defaults coding agents to workspace and stores custom dirs in local config only', async () => {
    writeCustomAgent('code-agent', {
      name: 'Code Agent',
      runtime: { kind: 'cli', cli: 'codex' },
    } as any);
    const a = await loadAgents();
    const userWorkspace = await import('../../../src/main/features/user_workspace');
    const workspacePath = userWorkspace.getWorkspacePath(TEST_UID);

    const initial = await a.getAgentCliProjectDirInfo(TEST_UID, 'code-agent');
    expect(initial).toMatchObject({
      agent_id: 'code-agent',
      is_coding: true,
      mode: 'workspace',
      path: workspacePath,
      effective_path: workspacePath,
      exists: true,
    });

    const customDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(customDir);
    const custom = await a.setAgentCliProjectDir(TEST_UID, 'code-agent', customDir);
    expect(custom).toMatchObject({
      mode: 'custom',
      path: customDir,
      effective_path: customDir,
      custom_path: customDir,
      exists: true,
    });

    const spec = JSON.parse(fs.readFileSync(path.join(customAgentsDir(), 'code-agent', 'agent.json'), 'utf8'));
    expect(JSON.stringify(spec)).not.toContain(customDir);
    const localConfig = path.join(tmpDir, TEST_UID, 'local', 'config', 'agent-runtime.json');
    expect(JSON.parse(fs.readFileSync(localConfig, 'utf8')).project_dirs['code-agent'].path).toBe(customDir);

    fs.rmSync(customDir, { recursive: true, force: true });
    const missing = await a.getAgentCliProjectDirInfo(TEST_UID, 'code-agent');
    expect(missing).toMatchObject({
      mode: 'custom',
      path: customDir,
      effective_path: workspacePath,
      exists: false,
    });

    const reset = await a.setAgentCliProjectDir(TEST_UID, 'code-agent', '');
    expect(reset).toMatchObject({
      mode: 'workspace',
      path: workspacePath,
      effective_path: workspacePath,
      exists: true,
    });
  });

  it('rejects project directory overrides on non-coding CLI agents', async () => {
    writeCustomAgent('general-cli', {
      name: 'General CLI',
      runtime: { kind: 'cli', cli: 'openclaw' },
    } as any);
    const a = await loadAgents();
    const customDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(customDir);
    await expect(a.setAgentCliProjectDir(TEST_UID, 'general-cli', customDir))
      .rejects.toMatchObject({ code: 'E_AGENT_NOT_CODING_CLI' });
  });
});

describe('agents › isValidAgentId', () => {
  it('accepts alphanumeric + _/-', async () => {
    const a = await loadAgents();
    expect(a.isValidAgentId('abc123')).toBe(true);
    expect(a.isValidAgentId('foo-bar_baz')).toBe(true);
  });

  it('rejects spaces / path chars / empty', async () => {
    const a = await loadAgents();
    expect(a.isValidAgentId('')).toBe(false);
    expect(a.isValidAgentId(null)).toBe(false);
    expect(a.isValidAgentId('foo bar')).toBe(false);
    expect(a.isValidAgentId('../evil')).toBe(false);
  });
});

describe('agents › extractAgentFieldBlocks', () => {
  it('returns original text with empty blocks when no marker', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('just prose');
    expect(r.blocks).toEqual([]);
    expect(r.cleanText).toBe('just prose');
  });

  it('extracts name/description/workflow children from an <agent> container', async () => {
    const a = await loadAgents();
    const text = [
      'before',
      '<agent>',
      '<name>Planner</name>',
      '<description>Plans things</description>',
      '<workflow>',
      'step 1',
      'step 2',
      '</workflow>',
      '</agent>',
      'after',
    ].join('\n');
    const r = a.extractAgentFieldBlocks(text);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toEqual({
      name: 'Planner',
      description: 'Plans things',
      workflow: 'step 1\nstep 2',
    });
    expect(r.cleanText).toContain('before');
    expect(r.cleanText).toContain('after');
    expect(r.cleanText).not.toContain('<agent>');
    expect(r.cleanText).not.toContain('</agent>');
  });

  it('extracts every <agent> container in emission order (multi-agent turn)', async () => {
    const a = await loadAgents();
    const text = [
      'prose',
      '<agent>',
      '<agent_id>aaaaaaaaaaaa</agent_id>',
      '<workflow>w-A</workflow>',
      '</agent>',
      'middle',
      '<agent>',
      '<agent_id>bbbbbbbbbbbb</agent_id>',
      '<workflow>w-B</workflow>',
      '</agent>',
      'tail',
    ].join('\n');
    const r = a.extractAgentFieldBlocks(text);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0].agent_id).toBe('aaaaaaaaaaaa');
    expect(r.blocks[0].workflow).toBe('w-A');
    expect(r.blocks[1].agent_id).toBe('bbbbbbbbbbbb');
    expect(r.blocks[1].workflow).toBe('w-B');
    expect(r.cleanText).not.toContain('<agent>');
    expect(r.cleanText).toContain('prose');
    expect(r.cleanText).toContain('middle');
    expect(r.cleanText).toContain('tail');
  });

  it('parses each block independently — a malformed sub-tag in one does not affect the other', async () => {
    const a = await loadAgents();
    const text = [
      '<agent>',
      '<agent_id>aaaaaaaaaaaa</agent_id>',
      '<workflow>good-A</workflow>',
      '<inputs>not-json{</inputs>',
      '</agent>',
      '<agent>',
      '<agent_id>bbbbbbbbbbbb</agent_id>',
      '<workflow>good-B</workflow>',
      '</agent>',
    ].join('\n');
    const r = a.extractAgentFieldBlocks(text);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0].workflow).toBe('good-A');
    expect('inputs' in r.blocks[0]).toBe(false);  // malformed JSON → key omitted
    expect(r.blocks[1].workflow).toBe('good-B');
  });

  it('ignores non-XML fenced protocol examples and extracts the real container after them', async () => {
    const a = await loadAgents();
    const text = [
      'Format example:',
      '```',
      '<agent>',
      '<name>Example</name>',
      '</agent>',
      '```',
      'Now the actual update:',
      '<agent>',
      '<name>Real</name>',
      '<workflow>step `bash`</workflow>',
      '</agent>',
      'done',
    ].join('\n');
    const r = a.extractAgentFieldBlocks(text);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toEqual({ name: 'Real', workflow: 'step `bash`' });
    expect(r.cleanText).toContain('<name>Example</name>');
    expect(r.cleanText).not.toContain('<name>Real</name>');
  });

  it('treats fenced ```xml agent blocks as structural output', async () => {
    const a = await loadAgents();
    const text = [
      '```xml',
      '<agent>',
      '<name>Example</name>',
      '<workflow>step one</workflow>',
      '</agent>',
      '```',
    ].join('\n');
    const r = a.extractAgentFieldBlocks(text);
    expect(r.blocks).toEqual([{ name: 'Example', workflow: 'step one' }]);
    expect(r.cleanText).toBe('```xml\n\n```');
  });

  it('leaves inline quoted agent markers visible', async () => {
    const a = await loadAgents();
    const text = '请输出 "<agent><name>Example</name></agent>" 这些字符';
    const r = a.extractAgentFieldBlocks(text);
    expect(r.blocks).toEqual([]);
    expect(r.cleanText).toBe(text);
  });

  it('strips an unclosed real <agent> block without extracting partial fields', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('visible\n<agent>\n<name>Partial</name>\n<workflow>half');
    expect(r.blocks).toEqual([]);
    expect(r.cleanText).toBe('visible');
  });

  it('ignores child tags with empty body', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><name>   </name></agent>');
    expect(r.blocks).toEqual([{}]);
  });

  it('extracts <skills> child into string[] (one id per line)', async () => {
    const a = await loadAgents();
    const text = '<agent><skills>\nsocial-fetch\nmulti-analysis\n</skills></agent>';
    const r = a.extractAgentFieldBlocks(text);
    expect(r.blocks[0].skill_list).toEqual(['social-fetch', 'multi-analysis']);
  });

  it('treats empty <skills> child as explicit [] (zero skills)', async () => {
    const a = await loadAgents();
    // Empty tag must be distinguishable from an absent tag — the former
    // means "this agent needs NO skills", the latter means "leave unchanged".
    const r = a.extractAgentFieldBlocks('<agent><skills>\n\n</skills></agent>');
    expect(r.blocks[0].skill_list).toEqual([]);
  });

  it('filters non-safeId entries from <skills> child', async () => {
    const a = await loadAgents();
    const text = '<agent><skills>\nok-1\n../evil\n  \ngood_2\n</skills></agent>';
    const r = a.extractAgentFieldBlocks(text);
    expect(r.blocks[0].skill_list).toEqual(['ok-1', 'good_2']);
  });

  it('does not set skill_list when no <skills> child present', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><name>A</name></agent>');
    expect('skill_list' in r.blocks[0]).toBe(false);
  });

  // <interactive> drives the input-box auto-target. Each branch matters:
  // unset must leave the existing flag alone (so unrelated turns don't wipe
  // it), and only literal `true` / `false` count — anything else falls into
  // "leave unchanged" so a typo can't silently flip the flag.
  it('extracts <interactive>true</interactive> as boolean true', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><interactive>true</interactive></agent>');
    expect(r.blocks[0].interactive).toBe(true);
  });

  it('extracts <interactive>false</interactive> as boolean false', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><interactive>false</interactive></agent>');
    expect(r.blocks[0].interactive).toBe(false);
  });

  it('accepts case-insensitive TRUE/False', async () => {
    const a = await loadAgents();
    expect(a.extractAgentFieldBlocks('<agent><interactive>TRUE</interactive></agent>')
      .blocks[0].interactive).toBe(true);
    expect(a.extractAgentFieldBlocks('<agent><interactive>False</interactive></agent>')
      .blocks[0].interactive).toBe(false);
  });

  it('omits interactive key when child is absent', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><name>A</name></agent>');
    expect('interactive' in r.blocks[0]).toBe(false);
  });

  it('omits interactive key for non-boolean bodies (no silent flip)', async () => {
    const a = await loadAgents();
    expect('interactive' in a.extractAgentFieldBlocks('<agent><interactive>yes</interactive></agent>').blocks[0]).toBe(false);
    expect('interactive' in a.extractAgentFieldBlocks('<agent><interactive>1</interactive></agent>').blocks[0]).toBe(false);
    expect('interactive' in a.extractAgentFieldBlocks('<agent><interactive></interactive></agent>').blocks[0]).toBe(false);
  });

  it('extracts safe category codes and drops unsafe ones', async () => {
    const a = await loadAgents();
    expect(a.extractAgentFieldBlocks('<agent><category>DATA</category></agent>')
      .blocks[0].category).toBe('data');
    expect(a.extractAgentFieldBlocks('<agent><category>misc</category></agent>')
      .blocks[0].category).toBe('misc');
    expect('category' in a.extractAgentFieldBlocks('<agent><category>bad category</category></agent>').blocks[0])
      .toBe(false);
  });

  it('extracts independent knowhow and standards line lists', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks([
      '<agent>',
      '<knowhow>',
      'Task framing',
      'Source synthesis',
      '</knowhow>',
      '<standards>',
      'Traceable output',
      'Clear next action',
      '</standards>',
      '</agent>',
    ].join('\n'));
    expect(r.blocks[0].knowhow).toEqual(['Task framing', 'Source synthesis']);
    expect(r.blocks[0].standards).toEqual(['Traceable output', 'Clear next action']);
    expect('profile' in r.blocks[0]).toBe(false);
  });

  it('keeps JSON array compatibility for knowhow and standards', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks([
      '<agent>',
      '<knowhow>["Task framing"]</knowhow>',
      '<standards>["Traceable output"]</standards>',
      '</agent>',
    ].join('\n'));
    expect(r.blocks[0].knowhow).toEqual(['Task framing']);
    expect(r.blocks[0].standards).toEqual(['Traceable output']);
    expect('profile' in r.blocks[0]).toBe(false);
  });

  it('keeps legacy <profile> as knowhow/standards-only compatibility', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks([
      '<agent>',
      '<profile>',
      JSON.stringify({
        knowhow: [{ title: 'Task framing', description: 'Clarifies scope.' }],
        standards: [{ title: 'Traceable output', description: 'Cites assumptions.' }],
        workflow: [{ title: 'Old structured step', description: 'Do not parse.' }],
        memory: [{ title: 'Seed memory', description: 'Do not parse.' }],
      }),
      '</profile>',
      '</agent>',
    ].join('\n'));
    expect(r.blocks[0].knowhow).toEqual(['Task framing']);
    expect(r.blocks[0].standards).toEqual(['Traceable output']);
    expect('profile' in r.blocks[0]).toBe(false);
    expect('workflow' in r.blocks[0]).toBe(false);
  });
});

describe('agents › validateAgentInputs', () => {
  it('keeps only well-formed entries', async () => {
    const a = await loadAgents();
    const raw = [
      { id: 'keywords', label: '关键词', type: 'text', default: '' },
      { id: 'lang', label: 'Lang', type: 'select', default: 'zh',
        options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'EN' }] },
      { id: 'bad', type: 'bogus' as any, default: '' },       // bad type → dropped
      { id: 'Bad-Id', type: 'text', default: '' },            // bad id → dropped
      { id: 'keywords', type: 'text', default: 'dup' },       // duplicate → dropped
    ];
    const out = a.validateAgentInputs(raw);
    const ids = out.map((x) => x.id);
    expect(ids).toEqual(['keywords', 'lang']);
    expect(out[1].options).toHaveLength(2);
  });

  it('defaults multiselect non-array default to []', async () => {
    const a = await loadAgents();
    const out = a.validateAgentInputs([
      { id: 'p', type: 'multiselect', default: 'nope' as any,
        options: [{ value: 'a', label: 'A' }] },
    ]);
    expect(out[0].default).toEqual([]);
  });

  it('select falls back to first option when default is missing or not in options', async () => {
    // prompt(chat_agent_in_group.md)允许 LLM 发"空表单(不带 default)"。
    // 老行为 drop 整个 field → fields=0 → form 不挂 → 用户看到裸 XML 标签
    // 当未知 HTML 渲染。fallback 到 options[0].value 跟浏览器 <select> 默认显示
    // 首项的渲染行为对齐,避免静默吞掉 agent 的运行时 form。
    const a = await loadAgents();
    const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
    // 1. default 缺失 → 首项
    expect(a.validateAgentInputs([{ id: 'p', type: 'select', options: opts } as any])[0].default).toBe('a');
    // 2. default = '' → 首项
    expect(a.validateAgentInputs([{ id: 'p', type: 'select', default: '', options: opts }])[0].default).toBe('a');
    // 3. default 非法(不在 options 里) → 首项
    expect(a.validateAgentInputs([{ id: 'p', type: 'select', default: 'c', options: opts }])[0].default).toBe('a');
    // 4. default 合法 → 保留
    expect(a.validateAgentInputs([{ id: 'p', type: 'select', default: 'b', options: opts }])[0].default).toBe('b');
  });

  it('requires select/multiselect to have non-empty options', async () => {
    const a = await loadAgents();
    expect(a.validateAgentInputs([{ id: 'x', type: 'select', default: 'a', options: [] }])).toEqual([]);
    expect(a.validateAgentInputs([{ id: 'x', type: 'multiselect', default: [], options: [] }])).toEqual([]);
  });

  it('drops number when default is not finite', async () => {
    const a = await loadAgents();
    expect(a.validateAgentInputs([{ id: 'n', type: 'number', default: NaN }])).toEqual([]);
    expect(a.validateAgentInputs([{ id: 'n', type: 'number', default: 'x' as any }])).toEqual([]);
  });

  it('coerces string-form numbers ("3" / "3.14") into the numeric default', async () => {
    // LLMs occasionally serialize numeric defaults as strings; we recover
    // those instead of dropping the field over a JSON-encoding quirk.
    const a = await loadAgents();
    const r = a.validateAgentInputs([
      { id: 'n1', type: 'number', default: '3' as any },
      { id: 'n2', type: 'number', default: '3.14' as any },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].default).toBe(3);
    expect(r[1].default).toBeCloseTo(3.14);
  });

  it('coerces common boolean reps ("true" / "false" / 0 / 1) instead of dropping', async () => {
    const a = await loadAgents();
    const r = a.validateAgentInputs([
      { id: 'b1', type: 'boolean', default: 'true' as any },
      { id: 'b2', type: 'boolean', default: 'false' as any },
      { id: 'b3', type: 'boolean', default: 1 as any },
      { id: 'b4', type: 'boolean', default: 0 as any },
      { id: 'b5', type: 'boolean', default: true },
      { id: 'b6', type: 'boolean', default: false },
    ]);
    expect(r).toHaveLength(6);
    expect(r.map((x) => x.default)).toEqual([true, false, true, false, true, false]);
  });

  it('falls back to false (warn) for utterly invalid boolean defaults rather than dropping', async () => {
    const a = await loadAgents();
    const r = a.validateAgentInputs([
      { id: 'b', type: 'boolean', default: 'maybe' as any },
    ]);
    // Field NOT dropped — losing a structural input over a serialisation
    // quirk silently breaks the agent's form schema (the form widget
    // would render without that checkbox). Falling back to `false` is
    // conservative + visible.
    expect(r).toHaveLength(1);
    expect(r[0].default).toBe(false);
  });

  it('accepts file fields and forces empty default', async () => {
    const a = await loadAgents();
    // Single-file: default = ""; LLM-supplied default is ignored.
    const single = a.validateAgentInputs([
      { id: 'doc', label: '文档', type: 'file', default: 'preset.pdf' as any, required: true, accept: '.pdf' },
    ]);
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ id: 'doc', type: 'file', default: '', required: true, accept: '.pdf' });
    expect(single[0].multiple).toBeUndefined();

    // Multi-file: default = [].
    const multi = a.validateAgentInputs([
      { id: 'pages', label: '截图', type: 'file', default: ['x.png'] as any, multiple: true, accept: 'image/*' },
    ]);
    expect(multi).toHaveLength(1);
    expect(multi[0]).toMatchObject({ id: 'pages', type: 'file', default: [], multiple: true, accept: 'image/*' });
  });
});

describe('agents › extractAgentFieldBlocks › inputs', () => {
  it('parses <inputs> JSON into validated schema', async () => {
    const a = await loadAgents();
    const txt = [
      'hello',
      '<agent>',
      '<inputs>',
      '[{"id":"kw","label":"关键词","type":"text","default":""}]',
      '</inputs>',
      '</agent>',
      'tail',
    ].join('\n');
    const r = a.extractAgentFieldBlocks(txt);
    expect(r.blocks[0].inputs).toEqual([
      { id: 'kw', label: '关键词', type: 'text', default: '' },
    ]);
    expect(r.cleanText).not.toContain('<agent>');
    expect(r.cleanText).not.toContain('<inputs>');
  });

  it('treats empty inputs child as explicit []', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><inputs>\n\n</inputs></agent>');
    expect(r.blocks[0].inputs).toEqual([]);
  });

  it('omits inputs key when JSON is malformed (does NOT erase existing schema)', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><inputs>\nnot-json{\n</inputs></agent>');
    expect('inputs' in r.blocks[0]).toBe(false);
  });

  it('does not set inputs when no <inputs> child present', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><name>A</name></agent>');
    expect('inputs' in r.blocks[0]).toBe(false);
  });
});

// hashTree / syncBuiltinAgents removed. Platform agents now arrive via marketplace install and live at
// `<uid>/local/marketplace/agents/<id>/` per machine — see features/marketplace_*.ts.

describe('agents › createCustomAgent', () => {
  it('creates a 12-hex-id agent with defaults', async () => {
    const a = await loadAgents();
    const agent = await a.createCustomAgent({ name: 'Alpha', description: 'desc', category: 'general' });
    expect(agent?.agent_id).toMatch(/^[0-9a-f]{12}$/);
    expect(agent?.name).toBe('Alpha');
    expect(agent?.source).toBe('custom');
    const file = path.join(customAgentsDir(), agent?.agent_id || '', 'agent.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('routes a single custom description to the current UI language slot', async () => {
    const { setLanguage } = await import('../../../src/main/features/config');
    setLanguage('zh');
    const a = await loadAgents();

    const agent = await a.createCustomAgent({
      name: '中文Agent',
      description: 'plain English while UI is zh',
      category: 'general',
    });

    expect(agent?.description_zh).toBe('plain English while UI is zh');
    expect(agent?.description_en).toBe('');
    const file = path.join(customAgentsDir(), agent?.agent_id || '', 'agent.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.description_zh).toBe('plain English while UI is zh');
    expect(raw.description_en).toBe('');
    expect(raw).not.toHaveProperty('description');
  });

  it('defaults empty name to the localized no-space fallback', async () => {
    const a = await loadAgents();
    const agent = await a.createCustomAgent({ description: 'desc', category: 'general' });
    expect(agent?.name).toBe('UntitledAgent');
  });

  it('stores workflow skill references by display name', async () => {
    writeSkillOnDisk('16e1bfcb3426', 'agent-creator');
    const a = await loadAgents();
    const agent = await a.createCustomAgent({
      name: 'Builder',
      description: 'desc',
      category: 'rnd',
      workflow: 'skill: follow the `16e1bfcb3426` skill',
    });
    expect(agent?.workflow).toBe('`agent-creator` skill');
    const file = path.join(customAgentsDir(), agent?.agent_id || '', 'agent.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).workflow).toBe('`agent-creator` skill');
  });

  it('enforces the unified display-width name limit', async () => {
    const a = await loadAgents();

    await expect(a.createCustomAgent({ name: 'A'.repeat(60), description: 'desc', category: 'general' }))
      .resolves.toBeTruthy();
    await expect(a.createCustomAgent({ name: '中'.repeat(30), description: 'desc', category: 'general' }))
      .resolves.toBeTruthy();
    await expect(a.createCustomAgent({ name: 'A'.repeat(61), description: 'desc', category: 'general' }))
      .rejects.toMatchObject({ code: 'E_AGENT_NAME_TOO_LONG' });
    await expect(a.createCustomAgent({ name: '中'.repeat(31), description: 'desc', category: 'general' }))
      .rejects.toMatchObject({ code: 'E_AGENT_NAME_TOO_LONG' });
  });

  it('rejects reserved names (collide with commander role / sidebar tab)', async () => {
    const a = await loadAgents();
    // Plain hits + case variants all collapse to the same key.
    for (const bad of ['指挥官', '总指挥', 'コマンダー', '司令官', 'commander']) {
      await expect(a.createCustomAgent({ name: bad })).rejects.toThrow(/reserved/i);
    }
    for (const bad of ['  Commander  ', '指 挥 官', 'コ マ ン ダ ー', 'Code Helper']) {
      await expect(a.createCustomAgent({ name: bad })).rejects.toMatchObject({ code: 'E_AGENT_NAME_INVALID' });
    }
    // Sanity: the guard doesn't over-reach to nearby strings.
    await expect(a.createCustomAgent({ name: '副指挥官', description: 'desc', category: 'general' })).resolves.toBeTruthy();
  });
});

describe('agents › createAgentFromBlocks', () => {
  it('backfills the default category when model-authored creates omit it', async () => {
    const a = await loadAgents();
    const missing = await a.createAgentFromBlocks({
      name: 'NoCategory',
      description_en: 'desc',
      workflow: 'Do the work.',
    });
    expect(missing?.category).toBe('general');

    const created = await a.createAgentFromBlocks({
      name: 'DataAgent',
      description_en: 'desc',
      workflow: 'Analyze the data.',
      category: 'data',
    });
    expect(created?.category).toBe('data');
    const file = path.join(customAgentsDir(), created?.agent_id || '', 'agent.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).category).toBe('data');
  });

  it('rejects creates missing mandatory name or workflow', async () => {
    const a = await loadAgents();
    await expect(a.createAgentFromBlocks({
      name: 'NoWorkflow',
      description_en: 'desc',
    })).resolves.toBeNull();
    await expect(a.createAgentFromBlocks({
      workflow: 'Do the work.',
      description_en: 'desc',
    })).resolves.toBeNull();
  });

  it('persists optional skill allowlist, input schema and interactive flag', async () => {
    writeSkillOnDisk('known-skill');
    const a = await loadAgents();
    const created = await a.createAgentFromBlocks({
      name: 'InteractiveHelper',
      description_en: 'desc',
      workflow: 'Ask for a topic, then use the selected skill.',
      category: 'writing',
      interactive: true,
      skill_list: ['known-skill', 'missing-skill'],
      inputs: [
        { id: 'topic', label: 'Topic', type: 'text', default: '', required: true },
        { id: 'bad id', label: 'Bad', type: 'text', default: '' } as any,
      ],
    });

    expect(created?.category).toBe('creation');
    expect(created?.interactive).toBe(true);
    expect(created?.skill_list).toEqual(['known-skill']);
    expect(created?.inputs).toEqual([
      { id: 'topic', label: 'Topic', type: 'text', default: '', required: true },
    ]);
  });

  it('persists knowhow and standards as top-level agent fields', async () => {
    const a = await loadAgents();
    const created = await a.createAgentFromBlocks({
      name: 'ProfiledHelper',
      description_en: 'desc',
      workflow: 'Read the task, then deliver.',
      category: 'general',
      knowhow: ['Task framing'],
      standards: ['Traceable output'],
    });
    expect(created?.profile?.knowhow).toEqual(['Task framing']);
    expect(created?.profile?.standards).toEqual(['Traceable output']);

    const file = path.join(customAgentsDir(), created?.agent_id || '', 'agent.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.knowhow).toEqual(['Task framing']);
    expect(raw.standards).toEqual(['Traceable output']);
    expect('profile' in raw).toBe(false);
  });
});

describe('agents › listAgents', () => {
  it('returns empty when both dirs are missing', async () => {
    const a = await loadAgents();
    expect(await a.listAgents()).toEqual([]);
  });

  it('lists custom and builtin with correct source', async () => {
    writeCustomAgent('c1', { name: 'Cust' });
    const builtinB1 = path.join(builtinAgentsDir(), 'b1');
    fs.mkdirSync(builtinB1, { recursive: true });
    fs.writeFileSync(path.join(builtinB1, 'agent.json'), JSON.stringify({
      agent_id: 'b1', name: 'Built', description: '', workflow: '',
      created_at: '', updated_at: '',
    }));
    const a = await loadAgents();
    const list = await a.listAgents();
    const sources = Object.fromEntries(list.map((x) => [x.agent_id, x.source]));
    expect(sources).toEqual({ c1: 'custom', b1: 'marketplace' });
  });

  it('marketplace wins when custom has same id', async () => {
    writeCustomAgent('dup', { name: 'CustDup' });
    const builtinDup = path.join(builtinAgentsDir(), 'dup');
    fs.mkdirSync(builtinDup, { recursive: true });
    fs.writeFileSync(path.join(builtinDup, 'agent.json'), JSON.stringify({
      agent_id: 'dup', name: 'BuiltDup',
    }));
    const a = await loadAgents();
    const list = await a.listAgents();
    const match = list.filter((x) => x.agent_id === 'dup');
    expect(match).toHaveLength(1);
    expect(match[0].source).toBe('marketplace');
    expect(match[0].name).toBe('BuiltDup');
  });
});

describe('agents › getAgent', () => {
  it('returns null for missing id', async () => {
    const a = await loadAgents();
    expect(await a.getAgent('ghost')).toBeNull();
    expect(await a.getAgent('')).toBeNull();
    expect(await a.getAgent(null)).toBeNull();
  });

  it('returns the custom agent when present', async () => {
    writeCustomAgent('abc', { name: 'A', description: 'D' });
    const a = await loadAgents();
    const agent = await a.getAgent('abc');
    expect(agent?.name).toBe('A');
    expect(agent?.source).toBe('custom');
  });

  it('exposes legacy workflow skill ids as display names', async () => {
    writeSkillOnDisk('16e1bfcb3426', 'agent-creator');
    writeCustomAgent('abc', {
      name: 'A',
      workflow: 'skill: follow the `16e1bfcb3426` skill',
    });
    const a = await loadAgents();
    const agent = await a.getAgent('abc');
    expect(agent?.workflow).toBe('`agent-creator` skill');
  });
});

describe('agents › updateCustomAgent', () => {
  it('updates only the supplied fields', async () => {
    writeCustomAgent('abc', { name: 'Old', description: 'oldDesc', workflow: 'wf' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { description: 'newDesc' });
    expect(updated?.name).toBe('Old');  // preserved
    expect(updated?.description_en).toBe('newDesc');
    expect(updated?.workflow).toBe('wf');  // preserved
  });

  it('routes a single description update by current UI language, preserving historical other-language text', async () => {
    const { setLanguage } = await import('../../../src/main/features/config');
    setLanguage('zh');
    writeCustomAgent('abc', { name: 'Old', description: 'old English', workflow: 'wf' });
    const a = await loadAgents();

    const updated = await a.updateCustomAgent('abc', { description: 'plain English while UI is zh' });

    expect(updated?.description_zh).toBe('plain English while UI is zh');
    expect(updated?.description_en).toBe('old English');
    const raw = JSON.parse(fs.readFileSync(path.join(customAgentsDir(), 'abc', 'agent.json'), 'utf8'));
    expect(raw.description_zh).toBe('plain English while UI is zh');
    expect(raw.description_en).toBe('old English');
    expect(raw).not.toHaveProperty('description');
  });

  it('normalizes workflow skill references on update', async () => {
    writeSkillOnDisk('efb0fe5d9664', 'skill-creator');
    writeCustomAgent('abc', { name: 'Old', workflow: 'wf' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', {
      workflow: 'skill: follow the efb0fe5d9664 skill',
    });
    expect(updated?.workflow).toBe('`skill-creator` skill');
    const file = path.join(customAgentsDir(), 'abc', 'agent.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).workflow).toBe('`skill-creator` skill');
  });

  it('backfills empty name to the localized no-space fallback', async () => {
    writeCustomAgent('abc', { name: 'Old' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { name: '' });
    expect(updated?.name).toBe('UntitledAgent');
  });

  it('rejects renaming to a reserved name', async () => {
    writeCustomAgent('abc', { name: 'Old' });
    const a = await loadAgents();
    await expect(a.updateCustomAgent('abc', { name: '指挥官' })).rejects.toThrow(/reserved/i);
    // File on disk should still hold the old name.
    const after = await a.getAgent('abc');
    expect(after?.name).toBe('Old');
  });

  it('rejects renaming past the unified display-width limit', async () => {
    writeCustomAgent('abc', { name: 'Old' });
    const a = await loadAgents();

    await expect(a.updateCustomAgent('abc', { name: '中'.repeat(31) }))
      .rejects.toMatchObject({ code: 'E_AGENT_NAME_TOO_LONG' });
    const after = await a.getAgent('abc');
    expect(after?.name).toBe('Old');
  });

  it('allows swapping which CLI backs a CLI agent (cli → cli)', async () => {
    writeCustomAgent('abc', {
      name: 'N',
      runtime: { kind: 'cli', cli: 'claude' },
    } as any);
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', {
      runtime: { kind: 'cli', cli: 'codex' },
    } as any);
    expect(updated?.runtime).toEqual({ kind: 'cli', cli: 'codex' });
  });

  it('locks runtime kind: cli agent cannot revert to in_process', async () => {
    writeCustomAgent('abc', {
      name: 'N',
      runtime: { kind: 'cli', cli: 'claude' },
    } as any);
    const a = await loadAgents();
    // Attempt with explicit null (drop) — should be ignored.
    const r1 = await a.updateCustomAgent('abc', { runtime: null } as any);
    expect(r1?.runtime).toEqual({ kind: 'cli', cli: 'claude' });
    // Attempt with kind:'in_process' — also ignored.
    const r2 = await a.updateCustomAgent('abc', {
      runtime: { kind: 'in_process' },
    } as any);
    expect(r2?.runtime).toEqual({ kind: 'cli', cli: 'claude' });
  });

  it('locks runtime kind: in_process agent cannot become cli post-create', async () => {
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    const r = await a.updateCustomAgent('abc', {
      runtime: { kind: 'cli', cli: 'claude' },
    } as any);
    expect(r?.runtime).toBeUndefined();
  });

  it('strips prompt-owned updates on a CLI agent', async () => {
    writeCustomAgent('abc', {
      name: 'N',
      runtime: { kind: 'cli', cli: 'claude' },
    } as any);
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', {
      workflow: 'should be ignored',
      skill_list: ['x'],
      knowhow: ['should be ignored'],
      standards: ['should be ignored'],
      profile: {
        knowhow: ['legacy should be ignored'],
        standards: ['legacy should be ignored'],
      },
    });
    expect(updated?.workflow).toBe('');
    expect('skill_list' in (updated as any)).toBe(false);
    expect(updated?.profile?.knowhow).toBeUndefined();
    expect(updated?.profile?.standards).toBeUndefined();

    const raw = JSON.parse(fs.readFileSync(path.join(customAgentsDir(), 'abc', 'agent.json'), 'utf8'));
    expect(raw).not.toHaveProperty('knowhow');
    expect(raw).not.toHaveProperty('standards');
    expect(raw).not.toHaveProperty('profile');
  });

  it('coerces non-string values to empty string', async () => {
    writeCustomAgent('abc', { name: 'N', description: 'D' });
    const a = await loadAgents();
    // Non-string `description` becomes empty (`'42'.trim()` would not pass
    // the typeof guard in resolveBilingualDescription's caller). Persisted
    // legacy "D" survives → migrates to description_en.
    const updated = await a.updateCustomAgent('abc', { description: 42 as any });
    // The legacy `description` update of `42` is skipped (not a string);
    // the persisted "D" still in JSON migrates to description_en on read.
    expect(updated?.description_en).toBe('D');
  });

  it('returns null for missing agent', async () => {
    const a = await loadAgents();
    expect(await a.updateCustomAgent('ghost', { name: 'x' })).toBeNull();
  });

  it('writes skill_list array and round-trips through normalize', async () => {
    writeSkillOnDisk('s1');
    writeSkillOnDisk('s2');
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { skill_list: ['s1', 's2'] });
    expect(updated?.skill_list).toEqual(['s1', 's2']);
    const reread = await a.getAgent('abc');
    expect(reread?.skill_list).toEqual(['s1', 's2']);
  });

  it('writes inputs array and round-trips through normalize', async () => {
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    const inputs = [
      { id: 'kw', label: '关键词', type: 'text' as const, default: '', required: true },
      { id: 'lang', label: 'Lang', type: 'select' as const, default: 'zh',
        options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'EN' }] },
    ];
    const updated = await a.updateCustomAgent('abc', { inputs });
    expect(updated?.inputs).toHaveLength(2);
    expect(updated?.inputs?.[0].id).toBe('kw');
    const reread = await a.getAgent('abc');
    expect(reread?.inputs).toEqual(updated?.inputs);
  });

  it('null inputs drops the field entirely', async () => {
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    await a.updateCustomAgent('abc', { inputs: [
      { id: 'k', label: 'K', type: 'text' as const, default: '' },
    ]});
    await a.updateCustomAgent('abc', { inputs: null });
    const reread = await a.getAgent('abc');
    expect('inputs' in (reread as any)).toBe(false);
  });

  it('[] inputs persists as explicit zero (three-state)', async () => {
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { inputs: [] });
    expect(updated?.inputs).toEqual([]);
    const reread = await a.getAgent('abc');
    expect(reread?.inputs).toEqual([]);
  });

  it('filters non-safeId entries on write', async () => {
    writeSkillOnDisk('ok-1');
    writeSkillOnDisk('ok_2');
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', {
      skill_list: ['ok-1', '../bad', 42 as any, 'ok_2'],
    });
    expect(updated?.skill_list).toEqual(['ok-1', 'ok_2']);
  });

  it('writes skill_list = [] as explicit zero (kept, not dropped)', async () => {
    writeSkillOnDisk('a');
    writeCustomAgent('abc', { name: 'N', skill_list: ['a'] });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { skill_list: [] });
    expect(updated?.skill_list).toEqual([]);
  });

  it('skill_list: null drops the field (revert to "no filter")', async () => {
    writeSkillOnDisk('a');
    writeSkillOnDisk('b');
    writeCustomAgent('abc', { name: 'N', skill_list: ['a', 'b'] });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { skill_list: null });
    expect('skill_list' in (updated as any)).toBe(false);
    // Raw file must also have the field removed, not preserved with old value.
    const raw = JSON.parse(fs.readFileSync(path.join(customAgentsDir(), 'abc', 'agent.json'), 'utf8'));
    expect('skill_list' in raw).toBe(false);
  });

  it('omitted skill_list leaves stored value untouched', async () => {
    writeCustomAgent('abc', { name: 'N', skill_list: ['keep-me'] });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { description: 'x' });
    expect(updated?.skill_list).toEqual(['keep-me']);
  });

  it('drops unknown skill ids from skill_list', async () => {
    writeSkillOnDisk('known');
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { skill_list: ['known', 'ghost'] });
    expect(updated?.skill_list).toEqual(['known']);
  });

  it('keeps enabled external-package skills in skill_list metadata', async () => {
    writeExternalPackageSkill('pkg-tools', 'external-helper');
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { skill_list: ['external-helper'] });
    expect(updated?.skill_list).toEqual(['external-helper']);
  });

  it('keeps skill_list verbatim when all ids are known (no closure expansion)', async () => {
    writeSkillOnDisk('a');
    writeSkillOnDisk('b');
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { skill_list: ['a'] });
    // Skills are independent — listing 'a' must NOT pull in unrelated ids.
    expect(updated?.skill_list).toEqual(['a']);
  });

  it('updates category explicitly, preserves it when omitted, and drops it when cleared', async () => {
    writeCustomAgent('abc', { name: 'N', category: 'general' });
    const a = await loadAgents();

    const changed = await a.updateCustomAgent('abc', { category: 'DATA' });
    expect(changed?.category).toBe('data');
    expect(JSON.parse(fs.readFileSync(path.join(customAgentsDir(), 'abc', 'agent.json'), 'utf8')).category)
      .toBe('data');

    const preserved = await a.updateCustomAgent('abc', { description: 'new desc' });
    expect(preserved?.category).toBe('data');

    const cleared = await a.updateCustomAgent('abc', { category: '' });
    expect(cleared?.category).toBe('');
    expect('category' in JSON.parse(fs.readFileSync(path.join(customAgentsDir(), 'abc', 'agent.json'), 'utf8')))
      .toBe(false);
  });

  it('writes output_format only for explicit constrained modes and clears auto', async () => {
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();

    const autoCreated = await a.createCustomAgent({ name: 'AutoAgent', description: 'desc', output_format: 'auto' });
    expect('output_format' in (autoCreated as any)).toBe(false);
    expect('output_format' in JSON.parse(fs.readFileSync(path.join(customAgentsDir(), autoCreated!.agent_id, 'agent.json'), 'utf8')))
      .toBe(false);

    const constrained = await a.updateCustomAgent('abc', { output_format: 'artifact' });
    expect(constrained?.output_format).toBe('artifact');
    expect(JSON.parse(fs.readFileSync(path.join(customAgentsDir(), 'abc', 'agent.json'), 'utf8')).output_format)
      .toBe('artifact');

    const text = await a.updateCustomAgent('abc', { output_format: 'text' });
    expect(text?.output_format).toBe('text');
    expect(JSON.parse(fs.readFileSync(path.join(customAgentsDir(), 'abc', 'agent.json'), 'utf8')).output_format)
      .toBe('text');

    const cleared = await a.updateCustomAgent('abc', { output_format: 'auto' });
    expect('output_format' in (cleared as any)).toBe(false);
    expect('output_format' in JSON.parse(fs.readFileSync(path.join(customAgentsDir(), 'abc', 'agent.json'), 'utf8')))
      .toBe(false);
  });
});

describe('agents › appendAgentSkill', () => {
  it('appends a new skill id to skill_list (skips updateCustomAgent unknown-id filter)', async () => {
    // No writeSkillOnDisk — this skill is System B, not in SkillLoader specs.
    // appendAgentSkill must NOT drop it the way updateCustomAgent would.
    writeCustomAgent('abc', { name: 'N', skill_list: ['existing'] });
    const a = await loadAgents();
    const ok = await a.appendAgentSkill('abc', 'learned-via-reflection');
    expect(ok).toBe(true);
    const reread = await a.getAgent('abc');
    expect(reread?.skill_list).toEqual(['existing', 'learned-via-reflection']);
  });

  it('is a no-op when skill_list metadata is undefined', async () => {
    writeCustomAgent('abc', { name: 'N' }); // no skill_list
    const a = await loadAgents();
    const ok = await a.appendAgentSkill('abc', 'new-skill');
    expect(ok).toBe(false);
    const reread = await a.getAgent('abc');
    expect(reread?.skill_list).toBeUndefined();
  });

  it('is a no-op when skill id is already present', async () => {
    writeCustomAgent('abc', { name: 'N', skill_list: ['dup'] });
    const a = await loadAgents();
    const ok = await a.appendAgentSkill('abc', 'dup');
    expect(ok).toBe(false);
  });

  it('rejects invalid skill ids', async () => {
    writeCustomAgent('abc', { name: 'N', skill_list: [] });
    const a = await loadAgents();
    expect(await a.appendAgentSkill('abc', '../escape')).toBe(false);
    expect(await a.appendAgentSkill('abc', '')).toBe(false);
  });

  it('returns false for missing agent', async () => {
    const a = await loadAgents();
    expect(await a.appendAgentSkill('ghost', 'x')).toBe(false);
  });
});

describe('agents › custom agent memory', () => {
  it('updates an existing agent memory entry', async () => {
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();

    const added = await a.addCustomAgentMemory('abc', 'old delivery preference');
    expect(added.ok).toBe(true);
    const canonicalMemoryFile = path.join(tmpDir, TEST_UID, 'cloud', 'memory', 'agents', 'abc', 'MEMORY.md');
    const legacyMemoryFile = path.join(customAgentsDir(), 'abc', 'memory', 'MEMORY.md');
    expect(fs.readFileSync(canonicalMemoryFile, 'utf8')).toContain('old delivery preference');
    expect(fs.existsSync(legacyMemoryFile)).toBe(false);

    const updated = await a.updateCustomAgentMemory('abc', 'old delivery preference', 'new delivery preference');
    expect(updated.ok).toBe(true);
    expect(updated.entries).toEqual(['new delivery preference']);

    const reread = await a.getAgent('abc');
    expect(reread?.profile?.memory?.map((entry) => entry.title)).toEqual(['new delivery preference']);
  });

  it('reads legacy agent-dir memory while new writes use the shared memory scope', async () => {
    writeCustomAgent('abc', { name: 'N' });
    const legacyMemoryFile = path.join(customAgentsDir(), 'abc', 'memory', 'MEMORY.md');
    fs.mkdirSync(path.dirname(legacyMemoryFile), { recursive: true });
    fs.writeFileSync(legacyMemoryFile, 'legacy delivery preference', 'utf8');
    const a = await loadAgents();

    const reread = await a.getAgent('abc');
    expect(reread?.profile?.memory?.map((entry) => entry.title)).toEqual(['legacy delivery preference']);

    const added = await a.addCustomAgentMemory('abc', 'new delivery preference');
    expect(added.ok).toBe(true);
    expect(added.entries).toEqual(['legacy delivery preference', 'new delivery preference']);
    const canonicalMemoryFile = path.join(tmpDir, TEST_UID, 'cloud', 'memory', 'agents', 'abc', 'MEMORY.md');
    expect(fs.readFileSync(canonicalMemoryFile, 'utf8')).toContain('new delivery preference');
  });

  it('does not expose or mutate detail memory for external CLI agents', async () => {
    writeCustomAgent('cli-agent', {
      name: 'CliAgent',
      runtime: { kind: 'cli', cli: 'codex' },
    });
    const memoryFile = path.join(customAgentsDir(), 'cli-agent', 'memory', 'MEMORY.md');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, 'existing external memory', 'utf8');
    const a = await loadAgents();

    const reread = await a.getAgent('cli-agent');
    expect(reread?.profile?.memory).toBeUndefined();

    const added = await a.addCustomAgentMemory('cli-agent', 'new external memory');
    expect(added.ok).toBe(false);
    expect(added.error).toContain('external CLI');
    expect(fs.readFileSync(memoryFile, 'utf8')).toBe('existing external memory');
  });
});

describe('agents › streamSendToAgentEditChat synthesized progress', () => {
  beforeEach(async () => {
    const { setLanguage } = await import('../../../src/main/features/config');
    setLanguage('zh');
  });

  it('emits progress events for each field block extracted from the final text', async () => {
    streamImpl.current = async function* () {
      yield {
        type: 'final',
        text: '<agent><workflow>step 1</workflow><skills>\nalpha\n</skills></agent>',
      };
    };
    writeSkillOnDisk('alpha');
    writeCustomAgent('abc', { name: 'N' });

    const a = await loadAgents();
    const events: any[] = [];
    for await (const ev of a.streamSendToAgentEditChat('u1', 'abc', 'hi')) {
      events.push(ev);
    }

    const progressTexts = events.filter((e) => e.type === 'progress').map((e) => e.text);
    expect(progressTexts).toContain('▶ 更新 workflow');
    expect(progressTexts).toContain('▶ 更新 skills · alpha');

    // Synthesized events must land in the persisted process field too, so
    // history reload paints the same rail.
    const chatPath = path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'agent', 'abc', 'chat.jsonl');
    const lines = fs.readFileSync(chatPath, 'utf8').trim().split('\n');
    const assistantMsg = JSON.parse(lines[lines.length - 1]);
    expect(assistantMsg.role).toBe('assistant');
    expect(Array.isArray(assistantMsg.process)).toBe(true);
    const persistedTexts = assistantMsg.process.map((p: any) => p.text);
    expect(persistedTexts).toContain('▶ 更新 workflow');
    expect(persistedTexts).toContain('▶ 更新 skills · alpha');
  });

  it('emits a clear-skills line when workflow declares zero skills', async () => {
    streamImpl.current = async function* () {
      yield { type: 'final', text: '<agent><skills>\n\n</skills></agent>' };
    };
    writeCustomAgent('abc', { name: 'N' });

    const a = await loadAgents();
    const events: any[] = [];
    for await (const ev of a.streamSendToAgentEditChat('u1', 'abc', 'hi')) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === 'progress').map((e) => e.text))
      .toContain('▶ 清空 skills');
  });

  it('does not synthesize progress events when no field blocks are present', async () => {
    streamImpl.current = async function* () {
      yield { type: 'final', text: 'just a plain reply' };
    };
    writeCustomAgent('abc', { name: 'N' });

    const a = await loadAgents();
    const events: any[] = [];
    for await (const ev of a.streamSendToAgentEditChat('u1', 'abc', 'hi')) {
      events.push(ev);
    }
    // Only the final event should fire — no progress noise.
    expect(events.filter((e) => e.type === 'progress')).toHaveLength(0);
  });

  it('uses modelText for the model while persisting short visible content', async () => {
    let seenOpts: any = null;
    streamImpl.current = async function* (opts: any) {
      seenOpts = opts;
      yield { type: 'final', text: 'done' };
    };
    writeCustomAgent('abc', { name: 'N' });

    const a = await loadAgents();
    for await (const _ev of a.streamSendToAgentEditChat('u1', 'abc', '帮我完善这个智能体', {
      modelText: '请基于名称和简介完善智能体工作流。',
    })) {
      // drain
    }

    expect(seenOpts.message).toBe('请基于名称和简介完善智能体工作流。');
    const chatPath = path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'agent', 'abc', 'chat.jsonl');
    const first = JSON.parse(fs.readFileSync(chatPath, 'utf8').trim().split('\n')[0]);
    expect(first.role).toBe('user');
    expect(first.content).toBe('帮我完善这个智能体');
    expect(first.model_text).toBe('请基于名称和简介完善智能体工作流。');
  });

  it('exposes open-tier skills and skill_search to the agent edit model call', async () => {
    let seenOpts: any = null;
    streamImpl.current = async function* (opts: any) {
      seenOpts = opts;
      yield { type: 'final', text: 'done' };
    };
    writeCustomAgent('abc', { name: 'N' });
    const externalRoot = writeExternalPackageSkill('pkg-tools', 'external-helper');

    const a = await loadAgents();
    for await (const _ev of a.streamSendToAgentEditChat('u1', 'abc', '帮我完善这个智能体')) {
      // drain
    }

    expect(seenOpts.extraTools.map((t: any) => t.name)).toContain('skill_search');
    expect(seenOpts.readOnlyExtraRoots).toContain(externalRoot);
  });

  it('passes edit-chat attachments into the model prompt and history', async () => {
    let seenOpts: any = null;
    streamImpl.current = async function* (opts: any) {
      seenOpts = opts;
      yield { type: 'final', text: 'read attachment' };
    };
    writeCustomAgent('abc', { name: 'N' });
    const attDir = path.join(tmpDir, TEST_UID, 'cloud', 'chat_attachments', 'agent-edit-abc');
    fs.mkdirSync(attDir, { recursive: true });
    fs.writeFileSync(path.join(attDir, 'brief.txt'), 'agent brief');

    const a = await loadAgents();
    for await (const _ev of a.streamSendToAgentEditChat('u1', 'abc', 'make changes', { attachments: ['brief.txt'] })) {
      // drain
    }

    expect(seenOpts.message).toContain('<attachments>');
    expect(seenOpts.message).toContain('brief.txt');
    expect(seenOpts.message).toContain('make changes');
    expect(seenOpts.readOnlyExtraRoots).toContain(attDir);

    const chatPath = path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'agent', 'abc', 'chat.jsonl');
    const first = JSON.parse(fs.readFileSync(chatPath, 'utf8').trim().split('\n')[0]);
    expect(first.role).toBe('user');
    expect(first.attachments).toEqual(['brief.txt']);
    expect(first.attachment_cid).toBe('agent-edit-abc');
  });
});

describe('agents › deleteCustomAgent', () => {
  it('removes the agent directory', async () => {
    writeCustomAgent('victim');
    const a = await loadAgents();
    const ok = await a.deleteCustomAgent('victim');
    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(customAgentsDir(), 'victim'))).toBe(false);
  });

  it('returns false for missing agent', async () => {
    const a = await loadAgents();
    expect(await a.deleteCustomAgent('ghost')).toBe(false);
  });

  it('drops per-user agent chat dirs on delete', async () => {
    writeCustomAgent('victim');
    const chatDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'agent', 'victim');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(path.join(chatDir, 'chat.jsonl'), '');
    const a = await loadAgents();
    await a.deleteCustomAgent('victim');
    expect(fs.existsSync(chatDir)).toBe(false);
  });

  it('purges the core-agent session jsonl so recreate starts fresh', async () => {
    writeCustomAgent('victim');
    const sessionDir = path.join(tmpDir, TEST_UID, 'cloud', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, 'agent-victim.jsonl');
    fs.writeFileSync(sessionFile, '{"role":"user","content":"old"}\n');

    const a = await loadAgents();
    await a.deleteCustomAgent('victim');
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it('does not delete existing tasks that reference the agent legacy field', async () => {
    writeCustomAgent('victim');
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const taskFile = path.join(chatsDir, 'task1.jsonl');
    fs.writeFileSync(taskFile, '{"role":"user","content":"hi"}\n');
    fs.writeFileSync(path.join(chatsDir, '_index.json'), JSON.stringify([
      {
        conversation_id: 'task1',
        title: 'Task One',
        kind: 'normal',
        agent_id: 'victim',
        session_id: 'gconv-task1',
        created_at: '2026-06-01T10:00:00.000Z',
        updated_at: '2026-06-01T10:00:00.000Z',
      },
    ]));

    const a = await loadAgents();
    await a.deleteCustomAgent('victim');

    expect(fs.existsSync(taskFile)).toBe(true);
    const rows = JSON.parse(fs.readFileSync(path.join(chatsDir, '_index.json'), 'utf8'));
    expect(rows[0].deleted_at).toBeUndefined();
  });
});

describe('agents › buildAgentEditSystemPrompt', () => {
  it('substitutes agent fields and drops the removed skills_list placeholder', async () => {
    const a = await loadAgents();
    const sys = await a.buildAgentEditSystemPrompt({
      name: 'Researcher',
      description: '一句话简介',
      category: 'rnd',
      workflow: '1. step one\n2. step two',
      knowhow: ['Evidence synthesis'],
      standards: ['Every claim cites its source'],
    });
    expect(sys).toContain('Researcher');
    expect(sys).toContain('一句话简介');
    expect(sys).toContain('step one');
    expect(sys).toContain('Evidence synthesis');
    expect(sys).toContain('Every claim cites its source');
    // Migration check: template no longer carries the redundant skills list.
    expect(sys).not.toContain('$skills_list');
    expect(sys).not.toContain('$category');
    expect(sys).not.toContain('$category_field_definition');
    expect(sys).not.toMatch(/##\s*可用的\s*skill/);
    // Not a user-message prefix anymore — no trailing input footer.
    expect(sys).not.toMatch(/##\s*用户的输入/);
  });

  it('falls back to (not provided) when fields are empty', async () => {
    const a = await loadAgents();
    const sys = await a.buildAgentEditSystemPrompt({});
    expect(sys).toContain('(not provided)');
  });
});

describe('agents › list cache invalidation', () => {
  it('picks up newly created agents on next listAgents', async () => {
    const a = await loadAgents();
    expect(await a.listAgents()).toEqual([]);
    await a.createCustomAgent({ name: 'New', description: 'desc', category: 'general' });
    const list = await a.listAgents();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('New');
  });

  it('reflects updates immediately', async () => {
    const a = await loadAgents();
    const agent = await a.createCustomAgent({ name: 'V1', description: 'desc', category: 'general' });
    await a.updateCustomAgent(agent!.agent_id, { name: 'V2' });
    const list = await a.listAgents();
    expect(list[0].name).toBe('V2');
  });

  it('cache-only invalidator picks up marketplace file rewrites', async () => {
    const parent = builtinAgentsDir();
    const dir = path.join(parent, 'platform-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: 'platform-agent',
      name: 'Old platform agent',
      description: '',
      workflow: '',
    }));
    const fixedStamp = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(parent, fixedStamp, fixedStamp);

    const a = await loadAgents();
    expect((await a.listAgents()).find((x) => x.agent_id === 'platform-agent')?.name)
      .toBe('Old platform agent');

    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: 'platform-agent',
      name: 'New platform agent',
      description: '',
      workflow: '',
    }));
    fs.utimesSync(parent, fixedStamp, fixedStamp);

    expect((await a.listAgents()).find((x) => x.agent_id === 'platform-agent')?.name)
      .toBe('Old platform agent');
    a.clearAgentListCache();
    expect((await a.listAgents()).find((x) => x.agent_id === 'platform-agent')?.name)
      .toBe('New platform agent');
  });

  it('exposes marketplace install version and freshness metadata', async () => {
    const dir = path.join(builtinAgentsDir(), 'platform-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: 'platform-agent',
      name: 'Platform agent',
      description: '',
      workflow: '',
    }));
    fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
      version: '1.2.3',
      published_at: 1747066800000,
      updated_at: 1747067800000,
      default_install: true,
    }));

    const a = await loadAgents();
    const found = (await a.listAgents()).find((x) => x.agent_id === 'platform-agent');
    expect(found?.version).toBe('1.2.3');
    expect(found?.marketplace_published_at).toBe(1747066800000);
    expect(found?.marketplace_updated_at).toBe(1747067800000);
    expect(found?.default_install).toBe(true);
  });
});

// (The legacy marketplace-sentinel sync tests are gone. Marketplace installs now live at
// `<uid>/local/marketplace/agents/<id>/` and are reconciled from
// the cloud-synced `installs.json` manifest — see features/marketplace_*.ts.)
