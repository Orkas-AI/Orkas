import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindRuntimeSkillTarget, type SkillRuntimeBinding } from '../../../src/main/model/core-agent/skill-registry';

const agents = path.resolve(__dirname, '../../../resources/builtin/marketplace/agents');
const owners = ['814b61b027f0', '79df9cc89f5f', '5f890bd72ac4'];
let priorWorkspace: string | undefined;
let workspace: string;
beforeEach(async () => {
  priorWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-reference-read-'));
  process.env.ORKAS_WORKSPACE_ROOT = workspace;
  vi.resetModules();
  const { activateUser } = await import('../../../src/main/features/users');
  activateUser('studio-reference-test');
});
afterEach(() => {
  if (priorWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = priorWorkspace;
  fs.rmSync(workspace, { recursive: true, force: true });
});
function documents(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? documents(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}
function bindingsFor(owner: string) {
  const bindings = new Map<string, SkillRuntimeBinding>();
  const skills = path.join(agents, owner, 'skills');
  for (const entry of fs.readdirSync(skills, { withFileTypes: true })) {
    const root = path.join(skills, entry.name);
    const file = path.join(root, 'SKILL.md');
    if (!entry.isDirectory() || !fs.existsSync(file)) continue;
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain(`ownerAgent: ${owner}`);
    bindRuntimeSkillTarget({ id: entry.name, name: entry.name, source: 'agent', root, entry: file }, bindings);
  }
  return bindings;
}
function targetOf(file: string, href: string, bindings: Map<string, SkillRuntimeBinding>): string {
  const address = href.split('#')[0];
  if (address.startsWith('@skill/')) {
    const [ref, ...parts] = address.slice(7).split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Skill traversal');
    const binding = bindings.get(ref);
    if (!binding) throw new Error('unbound Skill');
    return parts.length ? path.join(binding.root, ...parts) : binding.entry;
  }
  const target = path.resolve(path.dirname(file), address);
  const root = [...bindings.values()].find(binding => file.startsWith(`${binding.root}${path.sep}`))!.root;
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('cross-Skill relative link');
  return target;
}

describe('Studio document dependency reads', () => {
  it.each(owners)('keeps all %s document links reachable within their bound owner', async owner => {
    const bindings = bindingsFor(owner);
    const { createFileTools } = await import('../../../src/main/model/core-agent/file-tools');
    const reader = createFileTools({ userId: 'studio-reference-test', skillRuntimeBindings: bindings })
      .find(tool => tool.name === 'read_files')!;
    for (const file of documents(path.join(agents, owner, 'skills'))) {
      const body = fs.readFileSync(file, 'utf8');
      for (const match of body.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
        const href = match[1];
        if (/^(?:https?:|#)/.test(href)) continue;
        const target = targetOf(file, href, bindings);
        expect(fs.existsSync(target), `${file}: ${href}`).toBe(true);
        if (!href.startsWith('@skill/')) continue;
        const result = await reader.execute({ paths: [{ path: href.split('#')[0] }], raw_text: true },
          { workingDir: workspace } as any);
        expect(result.isError, `${file}: ${href}`).toBeFalsy();
        expect(JSON.parse(result.content).files[0].content).toBe(fs.readFileSync(target, 'utf8'));
      }
    }
  });

  it('reads the linked VoiceStudio guide by its full address even when the workspace contains its name', async () => {
    const bindings = bindingsFor('5f890bd72ac4');
    const userId = 'studio-reference-test';
    const { setWorkspacePath } = await import('../../../src/main/features/user_workspace');
    const workingDir = path.join(workspace, 'project');
    fs.mkdirSync(workingDir);
    expect(setWorkspacePath(userId, workingDir).ok).toBe(true);
    fs.writeFileSync(path.join(workingDir, 'timeline-mixing.md'), 'workspace timeline notes');

    const { createFileTools } = await import('../../../src/main/model/core-agent/file-tools');
    const reader = createFileTools({ userId, skillRuntimeBindings: bindings })
      .find(tool => tool.name === 'read_files')!;
    const context = { workingDir } as Parameters<typeof reader.execute>[1];
    const read = async (address: string): Promise<string> => {
      const result = await reader.execute({ paths: [{ path: address }], raw_text: true }, context);
      expect(result.isError, address).toBeFalsy();
      return JSON.parse(result.content).files[0].content;
    };

    expect(await read('@skill/voice-project/references/project-format.md')).toContain('](timeline-mixing.md)');
    expect(await read('@skill/voice-project/references/timeline-mixing.md')).toBe(fs.readFileSync(
      path.join(bindings.get('voice-project')!.root, 'references', 'timeline-mixing.md'), 'utf8',
    ));
    expect(await read('timeline-mixing.md')).toBe('workspace timeline notes');
  });

  it('rejects wrong owners, nonexistent targets and sibling traversal rather than guessing another root', async () => {
    const bindings = bindingsFor('79df9cc89f5f');
    const entry = bindings.get('video-studio')!.entry;
    expect(() => targetOf(entry, '../video-craft/SKILL.md', bindings)).toThrow('cross-Skill');
    expect(() => targetOf(entry, '@skill/image-compose/references/multi-image-sets.md', bindings)).toThrow('unbound');
    const { createFileTools } = await import('../../../src/main/model/core-agent/file-tools');
    const reader = createFileTools({ userId: 'studio-reference-test', skillRuntimeBindings: bindings })
      .find(tool => tool.name === 'read_files')!;
    for (const address of ['@skill/image-compose/references/multi-image-sets.md',
      '@skill/video-craft/references/script-timing.md', '@skill/video-studio/../video-craft/SKILL.md']) {
      const result = await reader.execute({ paths: [{ path: address }], raw_text: true }, {} as any);
      expect(result.isError, address).toBe(true);
      expect(result.content).toMatch(/E_SKILL_NOT_AVAILABLE|E_NOT_FOUND|E_SKILL_REF_INVALID/);
    }
  });

  it('puts script-only craft and timing navigation before the finished-video route with one timing owner', () => {
    const root = path.join(agents, '79df9cc89f5f/skills');
    const studio = fs.readFileSync(path.join(root, 'video-studio/SKILL.md'), 'utf8');
    const script = studio.split('## Script or storyboard only')[1]?.split('## Finished video')[0] ?? '';
    for (const target of ['@skill/video-craft', '@skill/video-studio/references/script-timing.md']) {
      expect(script).toContain(`](${target})`);
    }
    expect(studio.indexOf('## Script or storyboard only')).toBeLessThan(studio.indexOf('## Finished video'));
    expect(studio.match(/@skill\/video-studio\/references\/script-timing\.md/g)).toHaveLength(1);
    const commerce = fs.readFileSync(path.join(root, 'video-craft/references/ecommerce.md'), 'utf8');
    expect(commerce).not.toContain('script-timing.md');
    expect(commerce).toContain('Shortening a line must preserve its factual meaning');
  });
});
