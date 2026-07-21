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
      marketplace_agents: Array<{ id: string; skill_list: string[]; embedded_skills: string[] }>;
      marketplace_skills: Array<{ id: string }>;
    };
  };
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

describe('builtin-resource-gate', () => {
  it('verifies every tracked file and the complete semantic inventory', () => {
    const root = path.join(process.cwd(), 'resources', 'builtin');
    const manifest = gate.createBuiltinManifest(root, { allowIgnoredJunk: true });

    expect(gate.verifyBuiltinRoot(root, { allowIgnoredJunk: true }))
      .toBe('resource:builtin:manifest-v1');
    expect(manifest.files).toHaveLength(129);
    expect(manifest.inventory.system_skills).toHaveLength(5);
    expect(manifest.inventory.marketplace_agents).toHaveLength(4);
    expect(manifest.inventory.marketplace_skills).toHaveLength(4);
    expect(manifest.inventory.marketplace_skills)
      .toContainEqual(expect.objectContaining({ id: 'e7f5c0e6f1be' }));
    expect(manifest.inventory.marketplace_agents)
      .toContainEqual(expect.objectContaining({
        id: '78900d8758bc',
        skill_list: expect.arrayContaining(['e7f5c0e6f1be']),
      }));
    expect(manifest.inventory.marketplace_agents)
      .toContainEqual(expect.objectContaining({
        id: '79df9cc89f5f',
        skill_list: [
          'composition-design-review',
          'design-system-importer',
          'frontend-design',
          'gate-control',
          'stage-assemble',
          'stage-compose',
          'stage-consistency',
          'stage-decide',
          'stage-edit',
          'stage-generate',
          'stage-plan',
          'video-craft',
          'video-router',
        ],
        embedded_skills: expect.arrayContaining([
          'video-router',
          'gate-control',
          'frontend-design',
          'design-system-importer',
          'composition-design-review',
          'video-craft',
          'stage-compose',
          'stage-edit',
          'stage-decide',
          'stage-generate',
          'stage-consistency',
          'stage-plan',
          'stage-assemble',
        ]),
      }));
  });

  it('rejects missing primary files before a release can be signed', () => {
    const root = copyBuiltin();
    fs.rmSync(path.join(root, 'system', 'skills', 'coding', 'SKILL.md'));

    expect(() => gate.verifyBuiltinRoot(root)).toThrow(/missing system skill coding SKILL\.md/);
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
