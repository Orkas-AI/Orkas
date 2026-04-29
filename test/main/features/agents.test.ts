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
let prevBuiltinRoot: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-agents-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevBuiltinRoot = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Point builtin source at an empty tmp so startup sync reads nothing.
  process.env.ORKAS_BUILTIN_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  process.env.ORKAS_BUILTIN_ROOT = prevBuiltinRoot;
  streamImpl.current = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

// Builtin agents are top-level data/builtin/agents (shared across uids).
function builtinAgentsDir(): string {
  return path.join(tmpDir, 'builtin', 'agents');
}

function writeCustomAgent(agentId: string, fields: Partial<Record<string, any>> = {}): void {
  // Agent 目录形态:`agents/<aid>/agent.json`(详见 docs/plans/agent-as-directory.md)
  const dir = path.join(customAgentsDir(), agentId);
  fs.mkdirSync(dir, { recursive: true });
  const data: Record<string, any> = {
    agent_id: agentId,
    name: fields.name ?? agentId,
    description: fields.description ?? '',
    workflow: fields.workflow ?? '',
    created_at: '2026-04-18T10:00:00',
    updated_at: '2026-04-18T10:00:00',
  };
  if ('skill_list' in fields) data.skill_list = fields.skill_list;
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(data));
}

function customSkillsDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'skills');
}

function writeSkillOnDisk(id: string): void {
  const dir = path.join(customSkillsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${id}`, `description: test skill ${id}`, '---', '', 'body'];
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'));
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
    }, 'builtin');
    expect(norm).toEqual({
      agent_id: 'x', name: 'N',
      description_zh: '', description_en: 'D',
      workflow: 'W',
      source: 'builtin', created_at: 't1', updated_at: 't2',
      // computed-at-load default; overridden by listAgents/getAgent at the boundary
      enabled: true,
    });
    // skill_list omitted from raw → not set on norm (undefined sentinel,
    // NOT []); runtime uses this to bypass filtering entirely.
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
  it('returns original text with empty fields when no marker', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('just prose');
    expect(r.fields).toEqual({});
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
    expect(r.fields).toEqual({
      name: 'Planner',
      description: 'Plans things',
      workflow: 'step 1\nstep 2',
    });
    expect(r.cleanText).toContain('before');
    expect(r.cleanText).toContain('after');
    expect(r.cleanText).not.toContain('<agent>');
    expect(r.cleanText).not.toContain('</agent>');
  });

  it('ignores child tags with empty body', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><name>   </name></agent>');
    expect(r.fields).toEqual({});
  });

  it('extracts <skills> child into string[] (one id per line)', async () => {
    const a = await loadAgents();
    const text = '<agent><skills>\nsocial-fetch\nmulti-analysis\n</skills></agent>';
    const r = a.extractAgentFieldBlocks(text);
    expect(r.fields.skill_list).toEqual(['social-fetch', 'multi-analysis']);
  });

  it('treats empty <skills> child as explicit [] (zero skills)', async () => {
    const a = await loadAgents();
    // Empty tag must be distinguishable from an absent tag — the former
    // means "this agent needs NO skills", the latter means "leave unchanged".
    const r = a.extractAgentFieldBlocks('<agent><skills>\n\n</skills></agent>');
    expect(r.fields.skill_list).toEqual([]);
  });

  it('filters non-safeId entries from <skills> child', async () => {
    const a = await loadAgents();
    const text = '<agent><skills>\nok-1\n../evil\n  \ngood_2\n</skills></agent>';
    const r = a.extractAgentFieldBlocks(text);
    expect(r.fields.skill_list).toEqual(['ok-1', 'good_2']);
  });

  it('does not set skill_list when no <skills> child present', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><name>A</name></agent>');
    expect('skill_list' in r.fields).toBe(false);
  });

  // <interactive> drives the input-box auto-target. Each branch matters:
  // unset must leave the existing flag alone (so unrelated turns don't wipe
  // it), and only literal `true` / `false` count — anything else falls into
  // "leave unchanged" so a typo can't silently flip the flag.
  it('extracts <interactive>true</interactive> as boolean true', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><interactive>true</interactive></agent>');
    expect(r.fields.interactive).toBe(true);
  });

  it('extracts <interactive>false</interactive> as boolean false', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><interactive>false</interactive></agent>');
    expect(r.fields.interactive).toBe(false);
  });

  it('accepts case-insensitive TRUE/False', async () => {
    const a = await loadAgents();
    expect(a.extractAgentFieldBlocks('<agent><interactive>TRUE</interactive></agent>')
      .fields.interactive).toBe(true);
    expect(a.extractAgentFieldBlocks('<agent><interactive>False</interactive></agent>')
      .fields.interactive).toBe(false);
  });

  it('omits interactive key when child is absent', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><name>A</name></agent>');
    expect('interactive' in r.fields).toBe(false);
  });

  it('omits interactive key for non-boolean bodies (no silent flip)', async () => {
    const a = await loadAgents();
    expect('interactive' in a.extractAgentFieldBlocks('<agent><interactive>yes</interactive></agent>').fields).toBe(false);
    expect('interactive' in a.extractAgentFieldBlocks('<agent><interactive>1</interactive></agent>').fields).toBe(false);
    expect('interactive' in a.extractAgentFieldBlocks('<agent><interactive></interactive></agent>').fields).toBe(false);
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
    expect(r.fields.inputs).toEqual([
      { id: 'kw', label: '关键词', type: 'text', default: '' },
    ]);
    expect(r.cleanText).not.toContain('<agent>');
    expect(r.cleanText).not.toContain('<inputs>');
  });

  it('treats empty inputs child as explicit []', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><inputs>\n\n</inputs></agent>');
    expect(r.fields.inputs).toEqual([]);
  });

  it('omits inputs key when JSON is malformed (does NOT erase existing schema)', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><inputs>\nnot-json{\n</inputs></agent>');
    expect('inputs' in r.fields).toBe(false);
  });

  it('does not set inputs when no <inputs> child present', async () => {
    const a = await loadAgents();
    const r = a.extractAgentFieldBlocks('<agent><name>A</name></agent>');
    expect('inputs' in r.fields).toBe(false);
  });
});

describe('agents › hashTree', () => {
  it('returns empty for missing dir', async () => {
    const a = await loadAgents();
    expect(a.hashTree(path.join(tmpDir, 'nope'))).toBe('');
  });

  it('hashes per-agent agent.json files only and is stable across calls', async () => {
    const a = await loadAgents();
    const dir = path.join(tmpDir, 'mixed');
    fs.mkdirSync(path.join(dir, 'agent-a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-a', 'agent.json'), '{"a":1}');
    const h1 = a.hashTree(dir);
    // Stability: same content → same hash
    expect(a.hashTree(dir)).toBe(h1);
    // Subdir without agent.json doesn't affect the hash
    fs.mkdirSync(path.join(dir, 'no-spec'));
    fs.writeFileSync(path.join(dir, 'no-spec', 'README.md'), 'docs');
    expect(a.hashTree(dir)).toBe(h1);
  });
});

describe('agents › createCustomAgent', () => {
  it('creates a 12-hex-id agent with defaults', async () => {
    const a = await loadAgents();
    const agent = await a.createCustomAgent({ name: 'Alpha', description: 'desc' });
    expect(agent?.agent_id).toMatch(/^[0-9a-f]{12}$/);
    expect(agent?.name).toBe('Alpha');
    expect(agent?.source).toBe('custom');
    const file = path.join(customAgentsDir(), agent?.agent_id || '', 'agent.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('defaults empty name to 未命名智能体', async () => {
    const a = await loadAgents();
    const agent = await a.createCustomAgent();
    expect(agent?.name).toBe('未命名智能体');
  });

  it('rejects reserved names (collide with commander role / sidebar tab)', async () => {
    const a = await loadAgents();
    // Plain hits + whitespace + case variants all collapse to the same key.
    for (const bad of ['指挥官', '总指挥', 'commander', '  Commander  ', '指 挥 官']) {
      await expect(a.createCustomAgent({ name: bad })).rejects.toThrow(/reserved/i);
    }
    // Sanity: the guard doesn't over-reach to nearby strings.
    await expect(a.createCustomAgent({ name: '副指挥官' })).resolves.toBeTruthy();
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
    expect(sources).toEqual({ c1: 'custom', b1: 'builtin' });
  });

  it('custom wins when builtin has same id', async () => {
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
    expect(match[0].source).toBe('custom');
    expect(match[0].name).toBe('CustDup');
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
});

describe('agents › updateCustomAgent', () => {
  it('updates only the supplied fields', async () => {
    writeCustomAgent('abc', { name: 'Old', description: 'oldDesc', workflow: 'wf' });
    const a = await loadAgents();
    // Legacy `description` updates route through Chinese-character heuristic.
    // English string ("newDesc") goes to `description_en`.
    const updated = await a.updateCustomAgent('abc', { description: 'newDesc' });
    expect(updated?.name).toBe('Old');  // preserved
    expect(updated?.description_en).toBe('newDesc');
    expect(updated?.workflow).toBe('wf');  // preserved
  });

  it('backfills empty name to 未命名智能体', async () => {
    writeCustomAgent('abc', { name: 'Old' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { name: '' });
    expect(updated?.name).toBe('未命名智能体');
  });

  it('rejects renaming to a reserved name', async () => {
    writeCustomAgent('abc', { name: 'Old' });
    const a = await loadAgents();
    await expect(a.updateCustomAgent('abc', { name: '指挥官' })).rejects.toThrow(/reserved/i);
    // File on disk should still hold the old name.
    const after = await a.getAgent('abc');
    expect(after?.name).toBe('Old');
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

  it('keeps skill_list verbatim when all ids are known (no closure expansion)', async () => {
    writeSkillOnDisk('a');
    writeSkillOnDisk('b');
    writeCustomAgent('abc', { name: 'N' });
    const a = await loadAgents();
    const updated = await a.updateCustomAgent('abc', { skill_list: ['a'] });
    // Skills are independent — listing 'a' must NOT pull in unrelated ids.
    expect(updated?.skill_list).toEqual(['a']);
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

  it('is a no-op when skill_list is undefined (unrestricted agent)', async () => {
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

describe('agents › streamSendToAgentEditChat synthesized progress', () => {
  beforeEach(async () => {
    const { setCurrentLang } = await import('../../../src/main/i18n');
    setCurrentLang('zh');
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
    const sessionFile = path.join(sessionDir, `${TEST_UID}-agent-victim.jsonl`);
    fs.writeFileSync(sessionFile, '{"role":"user","content":"old"}\n');

    const a = await loadAgents();
    await a.deleteCustomAgent('victim');
    expect(fs.existsSync(sessionFile)).toBe(false);
  });
});

describe('agents › buildAgentEditSystemPrompt', () => {
  it('substitutes agent fields and drops the removed skills_list placeholder', async () => {
    const a = await loadAgents();
    const sys = a.buildAgentEditSystemPrompt({
      name: 'Researcher',
      description: '一句话简介',
      workflow: '1. step one\n2. step two',
    });
    expect(sys).toContain('Researcher');
    expect(sys).toContain('一句话简介');
    expect(sys).toContain('step one');
    // Migration check: template no longer carries the redundant skills list.
    expect(sys).not.toContain('$skills_list');
    expect(sys).not.toMatch(/##\s*可用的\s*skill/);
    // Not a user-message prefix anymore — no trailing input footer.
    expect(sys).not.toMatch(/##\s*用户的输入/);
  });

  it('falls back to (未填写) when fields are empty', async () => {
    const a = await loadAgents();
    const sys = a.buildAgentEditSystemPrompt({});
    expect(sys).toContain('(未填写)');
  });
});

describe('agents › list cache invalidation', () => {
  it('picks up newly created agents on next listAgents', async () => {
    const a = await loadAgents();
    expect(await a.listAgents()).toEqual([]);
    await a.createCustomAgent({ name: 'New' });
    const list = await a.listAgents();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('New');
  });

  it('reflects updates immediately', async () => {
    const a = await loadAgents();
    const agent = await a.createCustomAgent({ name: 'V1' });
    await a.updateCustomAgent(agent!.agent_id, { name: 'V2' });
    const list = await a.listAgents();
    expect(list[0].name).toBe('V2');
  });
});
