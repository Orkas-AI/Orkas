import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const gate = require('../../../bin/builtin-resource-gate.cjs') as {
  createBuiltinManifest(root: string, options?: { allowIgnoredJunk?: boolean }): {
    files: unknown[];
    inventory: {
      system_skills: unknown[];
      marketplace_agents: Array<{
        id: string;
        icon: string;
        color: string;
        updated_at: string;
        skill_list: string[];
        embedded_skills: string[];
      }>;
      marketplace_skills: Array<{ id: string }>;
    };
  };
  REQUIRED_BUILTIN_INVENTORY: {
    system_skills: readonly string[];
    marketplace_agents: readonly string[];
    marketplace_skills: readonly string[];
  };
  validateBuiltinAgentContract(agent: Record<string, unknown>, id: string): boolean;
  verifyBuiltinExtraResourcesConfig(extraResources: unknown): boolean;
  verifyBuiltinRoot(root: string, options?: { allowIgnoredJunk?: boolean }): string;
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-builtin-gate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function copyBuiltin(): string {
  const root = path.join(tmpDir, 'builtin');
  fs.cpSync(path.join(process.cwd(), 'resources', 'builtin'), root, { recursive: true });
  return root;
}

function readBuiltinAgent(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'resources', 'builtin', 'marketplace', 'agents', id, 'agent.json'),
    'utf8',
  ));
}

describe('builtin-resource-gate', () => {
  it('verifies every tracked file and the complete semantic inventory', () => {
    const root = path.join(process.cwd(), 'resources', 'builtin');
    const manifest = gate.createBuiltinManifest(root, { allowIgnoredJunk: true });

    expect(gate.verifyBuiltinRoot(root, { allowIgnoredJunk: true }))
      .toBe('resource:builtin:manifest-v1');
    expect(manifest.inventory.system_skills.map((row: any) => row.id).sort())
      .toEqual([...gate.REQUIRED_BUILTIN_INVENTORY.system_skills].sort());
    expect(manifest.inventory.marketplace_agents.map((row) => row.id).sort())
      .toEqual([...gate.REQUIRED_BUILTIN_INVENTORY.marketplace_agents].sort());
    expect(manifest.inventory.marketplace_skills.map((row) => row.id).sort())
      .toEqual([...gate.REQUIRED_BUILTIN_INVENTORY.marketplace_skills].sort());
    expect(manifest.inventory.marketplace_agents)
      .toContainEqual(expect.objectContaining({
        id: '173d4235a431',
        name: 'ContentWriter',
        icon: 'document',
        color: 'lavender',
        skill_list: ['9dfbd4e00c0d'],
      }));
    expect(manifest.inventory.marketplace_agents)
      .toContainEqual(expect.objectContaining({
        id: '78900d8758bc',
        icon: 'search',
        color: 'sky',
        skill_list: expect.arrayContaining(['e7f5c0e6f1be']),
      }));
    expect(manifest.inventory.marketplace_agents)
      .toContainEqual(expect.objectContaining({
        id: 'a316881746f9',
        name: 'ProductDeveloper',
        icon: 'code',
        color: 'sage',
        skill_list: [
          '68fb048b85cb',
          '88aca13869d9',
          '9b1241732f3a',
          'b1f384166705',
          'fc125b9df078',
        ],
      }));
    expect(manifest.inventory.marketplace_agents)
      .toContainEqual(expect.objectContaining({
        id: '814b61b027f0',
        icon: 'image',
        color: 'violet',
        embedded_skills: expect.arrayContaining([
          'image-router',
          'image-craft',
          'image-design-review',
        ]),
      }));
  });

  it('requires shipped agents to carry complete user-facing and runtime contracts', () => {
    const valid = readBuiltinAgent('173d4235a431');
    expect(gate.validateBuiltinAgentContract(valid, '173d4235a431')).toBe(true);

    for (const [field, value, expected] of [
      ['description_zh', '', /non-empty description_zh/],
      ['description_en', '', /non-empty description_en/],
      ['workflow', '  ', /non-empty workflow/],
      ['category', 'Bad Category', /safe marketplace category/],
      ['interactive', 'false', /interactive must be boolean/],
      ['output_format', 'html', /output_format must be/],
      ['min_app_version', 'next', /min_app_version must be semantic/],
      ['updated_at', 'not-a-date', /updated_at must be an ISO-compatible date/],
    ] as const) {
      const candidate = structuredClone(valid);
      candidate[field] = value;
      expect(() => gate.validateBuiltinAgentContract(candidate, '173d4235a431'))
        .toThrow(expected);
    }
  });

  it('rejects shipped input definitions that runtime normalization would drop or rewrite', () => {
    const valid = readBuiltinAgent('79df9cc89f5f');
    const cases: Array<[string, (agent: any) => void, RegExp]> = [
      ['duplicate ids', (agent) => { agent.inputs[1].id = agent.inputs[0].id; }, /invalid or duplicate id/],
      ['string number', (agent) => { agent.inputs[3].default = '60'; }, /finite number/],
      ['unknown select default', (agent) => { agent.inputs[1].default = 'portrait'; }, /default must match an option/],
      ['unknown locale default', (agent) => { agent.inputs[2].default_by_ui_language.zh = 'cn'; }, /invalid zh language default/],
      ['non-boolean required', (agent) => { agent.inputs[0].required = 1; }, /required must be boolean/],
      ['ignored textarea bound', (agent) => { agent.inputs[0].min = 1; }, /must not declare numeric bounds/],
    ];

    for (const [label, mutate, expected] of cases) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      expect(
        () => gate.validateBuiltinAgentContract(candidate, '79df9cc89f5f'),
        label,
      ).toThrow(expected);
    }
  });

  it('rejects missing primary files before a release can be signed', () => {
    const root = copyBuiltin();
    fs.rmSync(path.join(root, 'system', 'skills', 'agent-creator', 'SKILL.md'));

    expect(() => gate.verifyBuiltinRoot(root)).toThrow(/missing system skill agent-creator SKILL\.md/);
  });

  it('rejects deletion of a whole required builtin even if a manifest is regenerated', () => {
    const root = copyBuiltin();
    fs.rmSync(path.join(root, 'marketplace', 'agents', 'bcfcb4921dce'), { recursive: true });

    expect(() => gate.createBuiltinManifest(root))
      .toThrow(/required builtin marketplace agent inventory.*missing: bcfcb4921dce/);
  });

  it('rejects a changed reference or script when the manifest was not regenerated', () => {
    const root = copyBuiltin();
    fs.appendFileSync(
      path.join(root, 'marketplace', 'skills', '6743aa0797a2', 'references', 'brand-dna-template.md'),
      '\ntampered\n',
    );

    expect(() => gate.verifyBuiltinRoot(root)).toThrow(/builtin content tree mismatch/);
  });

  it('rejects unresolved skills in an agent semantic inventory', () => {
    const root = copyBuiltin();
    const file = path.join(root, 'marketplace', 'agents', 'e064dca9e1bd', 'agent.json');
    const agent = JSON.parse(fs.readFileSync(file, 'utf8'));
    agent.skill_list.push('missing-skill');
    fs.writeFileSync(file, `${JSON.stringify(agent, null, 2)}\n`);

    expect(() => gate.createBuiltinManifest(root)).toThrow(/references missing skill missing-skill/);
  });

  it('rejects agent avatar tokens that the renderer cannot display', () => {
    const root = copyBuiltin();
    const file = path.join(root, 'marketplace', 'agents', '78900d8758bc', 'agent.json');
    const valid = JSON.parse(fs.readFileSync(file, 'utf8'));

    for (const [field, value] of [['icon', 'not-an-icon'], ['color', 'not-a-color']]) {
      const agent = structuredClone(valid);
      agent[field] = value;
      fs.writeFileSync(file, `${JSON.stringify(agent, null, 2)}\n`);
      expect(() => gate.createBuiltinManifest(root))
        .toThrow(new RegExp(`${field} must be a supported avatar token`));
    }
  });

  it('rejects non-semantic standalone Skill release metadata', () => {
    const root = copyBuiltin();
    const file = path.join(root, 'marketplace', 'skills', '9dfbd4e00c0d', '_meta.json');
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    meta.version = 'latest';
    fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);

    expect(() => gate.createBuiltinManifest(root))
      .toThrow(/invalid version\/update metadata.*9dfbd4e00c0d/);
  });

  it('allows ignored source caches but rejects them from a copied application', () => {
    const root = copyBuiltin();
    const cache = path.join(root, 'marketplace', 'skills', '6743aa0797a2', '__pycache__', 'junk.pyc');
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, 'cache');

    expect(gate.verifyBuiltinRoot(root, { allowIgnoredJunk: true }))
      .toBe('resource:builtin:manifest-v1');
    expect(() => gate.verifyBuiltinRoot(root)).toThrow(/builtin content tree mismatch/);
  });

  it('requires explicit cache exclusions on the builtin extraResources entry', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const builtin = packageJson.build.extraResources.find((entry: { to?: string }) => entry.to === 'builtin');
    builtin.filter = builtin.filter.filter((entry: string) => entry !== '!**/*.pyc');

    expect(() => gate.verifyBuiltinExtraResourcesConfig(packageJson.build.extraResources))
      .toThrow(/missing filter !\*\*\/\*\.pyc/);
  });
});
