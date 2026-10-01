import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';

const postJson = vi.hoisted(() => vi.fn());
const warnings = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/features/marketplace', async () => ({
  postJson,
  extractBundleSafely: (await import('../../../src/main/features/marketplace_bundle')).extractBundleSafely,
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: warnings, error: (...args: unknown[]) => { throw new Error(`Unexpected error: ${args[0]}`); } }),
}));
vi.mock('electron', () => ({ app: { getVersion: () => '1.7.0' } }));
vi.mock('../../../src/main/features/devtools', () => ({ isDevEnv: () => false }));
let root: string;
let previousRoot: string | undefined;
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 15));
const url = (id: string) => `https://marketplace.example.test/${id}`;
const dir = (kind: 'agents' | 'skills', id: string) => path.join(root, 'u1', 'local', 'marketplace', kind, id);
const skillRow = (id: string) => ({ id, version: '2.0.0', published_at: 200, installed_at: 100, bundle_url: url(id), status: 'approved' });
const agentRow = (id: string) => ({ id, version: '2.0.0', published_at: 200, installed_at: 100, agent_json_url: url(id) });
function localAgent(id: string) {
  fs.mkdirSync(dir('agents', id), { recursive: true });
  fs.writeFileSync(path.join(dir('agents', id), 'agent.json'), JSON.stringify({ agent_id: id, name: 'Old agent' }));
  fs.writeFileSync(path.join(dir('agents', id), '_install.json'), JSON.stringify({ version: '1.0.0', installed_at: 100 }));
}
async function setup(agentIds: string[], skillIds: string[], dependencies: string[] = []) {
  const installs = await import('../../../src/main/features/marketplace_installs');
  const reconcile = await import('../../../src/main/features/marketplace_reconcile');
  await installs.writeInstalls('u1', { version: 1, agents: agentIds.map(agentRow), skills: skillIds.map(skillRow) });
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  let denied = '';
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from('---\nname: updated-skill\n---\nUpdated content\n'));
  const bytes = zip.toBuffer();
  const fetcher = vi.fn(async (input: unknown) => {
    const id = new URL(String(input)).pathname.slice(1);
    calls.push(id);
    peak = Math.max(peak, ++active);
    await delay();
    active--;
    if (id === denied) return new Response('denied', { status: 403 });
    if (agentIds.includes(id)) return Response.json({ agent_id: id, name: 'Updated agent', skill_list: dependencies });
    return new Response(new Uint8Array(bytes));
  });
  vi.stubGlobal('fetch', fetcher);
  postJson.mockImplementation(async (endpoint: string, body: { ids?: string[]; id?: string }) => {
    if (endpoint === '/marketplace/skills/list') return { list: body.ids!.map(skillRow), total: body.ids!.length };
    if (endpoint === '/marketplace/skills/bundle') return skillRow(body.id!);
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });
  return { installs, reconcile, calls, fetcher, peak: () => peak, deny: (id: string) => { denied = id; } };
}
function expectInstalled(kind: 'agents' | 'skills', ids: string[]) {
  for (const id of ids) {
    expect(JSON.parse(fs.readFileSync(path.join(dir(kind, id), '_install.json'), 'utf8')).version).toBe('2.0.0');
    expect(fs.readFileSync(path.join(dir(kind, id), kind === 'agents' ? 'agent.json' : 'SKILL.md'), 'utf8')).toContain('Updated');
  }
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-scheduler-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  postJson.mockReset();
  warnings.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
describe('marketplace update scheduling end to end', () => {
  it('bounds mixed update downloads and installs every selected resource', async () => {
    const agents = Array.from({ length: 12 }, (_, i) => `agent-${i}`);
    const skills = Array.from({ length: 32 }, (_, i) => `skill-${i}`);
    const ctx = await setup(agents, skills);
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_agents: 12, pulled_skills: 32, failed: [] });
    expectInstalled('agents', agents);
    expectInstalled('skills', skills);
    expect(ctx.peak()).toBeLessThanOrEqual(4);
    expect(ctx.calls).toHaveLength(44);
    expect(warnings).not.toHaveBeenCalled();
  });
  it('lets four agents share a selected dependency without queue deadlock or duplicate transfer', async () => {
    const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];
    const ctx = await setup(agents, ['shared'], ['shared']);
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_agents: 4, pulled_skills: 1, failed: [] });
    expectInstalled('agents', agents);
    expectInstalled('skills', ['shared']);
    expect(ctx.calls.filter(id => id === 'shared')).toHaveLength(1);
    expect(postJson).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });
  it('batches missing dependency metadata and shares installs across agents', async () => {
    const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];
    const dependencies = ['dep-1', 'dep-2', 'dep-3'];
    const ctx = await setup(agents, [], dependencies);
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_agents: 4, failed: [] });
    expectInstalled('agents', agents);
    expectInstalled('skills', dependencies);
    expect(postJson).toHaveBeenCalledExactlyOnceWith('/marketplace/skills/list', { ids: dependencies, page: 1, size: 100 });
    for (const id of dependencies) expect(ctx.calls.filter(call => call === id)).toHaveLength(1);
    expect(warnings).not.toHaveBeenCalled();
  });
  it('retains old agents after a shared dependency failure and retries only unfinished installs', async () => {
    const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];
    const ctx = await setup(agents, ['shared', 'independent'], ['shared']);
    agents.forEach(localAgent);
    ctx.deny('shared');
    const failed = await ctx.reconcile.reconcileInstalls('u1');
    expect(failed.failed.sort()).toEqual([...agents.map(id => `agent:${id}`), 'skill:shared'].sort());
    expect(failed.pulled_skills).toBe(1);
    expectInstalled('skills', ['independent']);
    for (const id of agents) expect(fs.readFileSync(path.join(dir('agents', id), 'agent.json'), 'utf8')).toContain('Old agent');
    expect(ctx.calls.filter(id => id === 'shared')).toHaveLength(1);
    expect(warnings).toHaveBeenCalledTimes(5);
    warnings.mockClear();
    ctx.deny('');
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_agents: 4, pulled_skills: 1, failed: [] });
    expectInstalled('agents', agents);
    expectInstalled('skills', ['shared']);
    expect(ctx.calls.filter(id => id === 'independent')).toHaveLength(1);
    expect(ctx.calls.filter(id => id === 'shared')).toHaveLength(2);
    expect(warnings).not.toHaveBeenCalled();
  });
  it('shares the global limit across overlapping passes and skips installs completed while waiting', async () => {
    const skills = Array.from({ length: 12 }, (_, i) => `skill-${i}`);
    const ctx = await setup([], skills);
    const results = await Promise.all([ctx.reconcile.reconcileInstalls('u1'), ctx.reconcile.reconcileInstalls('u1')]);
    expect(results.every(result => result.failed.length === 0)).toBe(true);
    expectInstalled('skills', skills);
    expect(ctx.peak()).toBeLessThanOrEqual(4);
    for (const id of skills) expect(ctx.calls.filter(call => call === id)).toHaveLength(1);
    expect(warnings).not.toHaveBeenCalled();
  });
  it('cancels queued updates when the account becomes inactive', async () => {
    const skills = Array.from({ length: 12 }, (_, i) => `skill-${i}`);
    const ctx = await setup([], skills);
    let active = true;
    const fetcher = ctx.fetcher.getMockImplementation()!;
    ctx.fetcher.mockImplementation(async input => {
      const response = await fetcher(input);
      active = false;
      return response;
    });
    expect(await ctx.reconcile.reconcileInstalls('u1', { shouldContinue: () => active })).toMatchObject({ pulled_skills: 0, failed: [] });
    expect(ctx.calls.length).toBeLessThanOrEqual(4);
    for (const id of skills) expect(fs.existsSync(path.join(dir('skills', id), 'SKILL.md'))).toBe(false);
    expect(warnings).not.toHaveBeenCalled();
  });
  it('keeps agent-private bundles private while batching public dependencies', async () => {
    const ctx = await setup(['agent-1'], [], ['private-skill', 'dep-1', 'dep-2']);
    await ctx.installs.writeInstalls('u1', { version: 1, agents: [{ ...agentRow('agent-1'), agent_skills_bundle_url: url('private-bundle') }], skills: [] });
    const zip = new AdmZip();
    zip.addFile('private-skill/SKILL.md', Buffer.from('---\nname: private-skill\n---\nPrivate content'));
    const fetcher = ctx.fetcher.getMockImplementation()!;
    ctx.fetcher.mockImplementation(async input => String(input) === url('private-bundle')
      ? new Response(new Uint8Array(zip.toBuffer())) : fetcher(input));
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_agents: 1, failed: [] });
    expectInstalled('skills', ['dep-1', 'dep-2']);
    expect(fs.readFileSync(path.join(dir('agents', 'agent-1'), 'skills', 'private-skill', 'SKILL.md'), 'utf8')).toContain('Private content');
    expect((await ctx.installs.readInstalls('u1')).skills.map(row => row.id).sort()).toEqual(['dep-1', 'dep-2']);
    expect(postJson).toHaveBeenCalledExactlyOnceWith('/marketplace/skills/list', { ids: ['dep-1', 'dep-2'], page: 1, size: 100 });
    expect(warnings).not.toHaveBeenCalled();
  });

  it('uses one legacy detail lookup per missing dependency when catalog addresses are absent', async () => {
    const ctx = await setup(['agent-1', 'agent-2'], [], ['shared']);
    postJson.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/marketplace/skills/list') return { list: [{ id: 'shared', version: '2.0.0', status: 'approved' }], total: 1 };
      if (endpoint === '/marketplace/skills/bundle') return skillRow('shared');
      throw new Error('Unexpected endpoint');
    });
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_agents: 2, failed: [] });
    expectInstalled('agents', ['agent-1', 'agent-2']);
    expectInstalled('skills', ['shared']);
    expect(postJson.mock.calls.map(call => call[0])).toEqual(['/marketplace/skills/list', '/marketplace/skills/bundle']);
    expect(ctx.calls.filter(id => id === 'shared')).toHaveLength(1);
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each(['missing', 'empty address', 'unapproved', 'incompatible', 'invalid version'])(
    'rejects a %s dependency without installing the agent or falling back to per-item lookup', async failure => {
      const ctx = await setup(['agent-1'], [], ['shared']);
      localAgent('agent-1');
      const row = { ...skillRow('shared'),
        ...(failure === 'empty address' ? { bundle_url: '' } : {}),
        ...(failure === 'unapproved' ? { status: 'pending' } : {}),
        ...(failure === 'incompatible' ? { min_app_version: '99.0.0' } : {}),
        ...(failure === 'invalid version' ? { version: 'invalid' } : {}),
      };
      postJson.mockResolvedValue({ list: failure === 'missing' ? [] : [row], total: failure === 'missing' ? 0 : 1 });
      expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_agents: 0, failed: ['agent:agent-1'] });
      expect(fs.readFileSync(path.join(dir('agents', 'agent-1'), 'agent.json'), 'utf8')).toContain('Old agent');
      expect((await ctx.installs.readInstalls('u1')).skills).toEqual([]);
      expect(ctx.calls).toEqual(['agent-1']);
      expect(postJson).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(warnings.mock.calls[0][0]).toContain('agent agent-1 pull failed:');
    },
  );

  it('does not resurrect a dependency removed while its catalog request was pending', async () => {
    const ctx = await setup(['agent-1', 'agent-2'], [], ['shared']);
    postJson.mockImplementation(async () => {
      await ctx.installs.removeSkillInstall('u1', 'shared');
      return { list: [skillRow('shared')], total: 1 };
    });
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_agents: 0, failed: [] });
    expect(ctx.calls.sort()).toEqual(['agent-1', 'agent-2']);
    expect((await ctx.installs.readInstalls('u1')).skills).toEqual([]);
    expect(fs.existsSync(dir('skills', 'shared'))).toBe(false);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('leaves queued resources uninstalled after an uninstall and continues unrelated work', async () => {
    const skills = Array.from({ length: 12 }, (_, i) => `skill-${i}`);
    const ctx = await setup([], skills);
    const fetcher = ctx.fetcher.getMockImplementation()!;
    ctx.fetcher.mockImplementation(async input => {
      if (String(input) === url('skill-0')) await ctx.installs.removeSkillInstall('u1', 'skill-11');
      return fetcher(input);
    });
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_skills: 11, failed: [] });
    expectInstalled('skills', skills.slice(0, 11));
    expect(ctx.calls).not.toContain('skill-11');
    expect(fs.existsSync(dir('skills', 'skill-11'))).toBe(false);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('does not seed dependencies after cancellation during metadata resolution', async () => {
    const ctx = await setup(['agent-1'], [], ['shared']);
    let active = true;
    postJson.mockImplementation(async () => {
      active = false;
      return { list: [skillRow('shared')], total: 1 };
    });
    expect(await ctx.reconcile.reconcileInstalls('u1', { shouldContinue: () => active })).toMatchObject({ pulled_agents: 0, failed: [] });
    expect((await ctx.installs.readInstalls('u1')).skills).toEqual([]);
    expect(ctx.calls).toEqual(['agent-1']);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('keeps a newer manifest dependency when an older catalog supplies its missing address', async () => {
    const ctx = await setup(['agent-1'], ['shared'], ['shared']);
    await ctx.installs.writeInstalls('u1', { version: 1, agents: [agentRow('agent-1')], skills: [{ ...skillRow('shared'), version: '3.0.0', bundle_url: '' }] });
    const result = await ctx.reconcile.reconcileInstalls('u1');
    expect(result).toMatchObject({ pulled_agents: 0, pulled_skills: 0 });
    expect(result.failed.sort()).toEqual(['agent:agent-1', 'skill:shared']);
    expect((await ctx.installs.readInstalls('u1')).skills[0]).toMatchObject({ version: '3.0.0', bundle_url: '' });
    expect(ctx.calls).toEqual(['agent-1']);
    expect(warnings).toHaveBeenCalledTimes(2);
  });

  it('rejects a legacy detail response for a different dependency identity', async () => {
    const ctx = await setup(['agent-1'], [], ['shared']);
    postJson.mockImplementation(async (endpoint: string) => endpoint === '/marketplace/skills/list'
      ? { list: [{ id: 'shared', version: '2.0.0', status: 'approved' }], total: 1 }
      : skillRow('other-skill'));
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ pulled_agents: 0, failed: ['agent:agent-1'] });
    expect((await ctx.installs.readInstalls('u1')).skills).toEqual([]);
    expect(ctx.calls).toEqual(['agent-1']);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0][0]).toContain('identity mismatch');
  });

});
