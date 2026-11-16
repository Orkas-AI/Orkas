import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../../../src/core-agent/src/agent/runner';
import { createConfig } from '../../../src/core-agent/src/config/loader';
import { ProviderRegistry } from '../../../src/core-agent/src/providers/registry';
import { toToolDefinition } from '../../../src/core-agent/src/tools/base';
import { createProgrammaticToolPolicy } from '../../../src/main/model/core-agent/programmatic-tool-policy';

vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const uid = 'app-id-user', cid = 'app-id-chat';
let root: string, previous: string | undefined;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-app-id-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

// The scripted provider injects the incident input, not a model-quality oracle.
// Delivery is checked through native execution, its receipt and real bundle bytes.
it.each([undefined, null, '', ' \t\n'].flatMap(artifactId =>
  (['direct', 'programmatic'] as const).map(mode => ({ mode, artifactId })),
))('delivers and revises one app through $mode calls (artifact_id=$artifactId)', async ({ mode, artifactId }) => {
  const { createLocalTools } = await import('../../../src/main/model/core-agent/local-tools');
  const created: Array<{ id: string; revision?: number }> = [];
  const tool = createLocalTools({
    userId: uid, cid, agentId: 'builder', onArtifactCreated: app => created.push(app),
    artifactInteractionSmoke: async () => ({ ok: true, blockers: [] }),
  }).find(t => t.name === 'create_artifact')!;
  const schema = toToolDefinition(tool).inputSchema as any;
  const receipts: any[] = [], requests: any[] = [];
  let round = 0;
  const provider: any = {
    id: 'app-id-fixture', name: 'Scripted no-network provider',
    async complete() { throw new Error('Unexpected auxiliary model request'); },
    async *stream(request: any) {
      requests.push(structuredClone(request));
      const current = round++;
      const input = {
        ...(current === 0 ? (artifactId === undefined ? {} : { artifact_id: artifactId }) : { artifact_id: created[0]?.id }),
        files: [{ path: 'index.html', content: `<button>${current === 0 ? 'Draft' : 'Delivered'}</button>` }],
      };
      yield { type: 'message_start' };
      yield {
        type: 'message_end', model: 'fixture',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: current < 2 ? 'tool_use' : 'end_turn',
        content: current < 2 ? [{
          type: 'tool_use', id: `app-${current}`, name: mode === 'direct' ? 'create_artifact' : 'run_program',
          input: mode === 'direct' ? input : {
            code: `const result = await tools.create_artifact(${JSON.stringify(input)}); if (!result.ok) throw Error(result.content); text(result.content);`,
          },
        }] : [{ type: 'text', text: 'The app is ready.' }],
      };
    },
    async validateAuth() { return true; },
  };
  const providers = new ProviderRegistry();
  providers.registerFactory(provider.id, () => provider);
  const runner = new AgentRunner({
    config: createConfig({ agent: { defaultProvider: provider.id, defaultModel: 'fixture', maxToolLoops: 4 } }),
    providers, tools: [tool], evolution: { enabled: false },
    ...(mode === 'programmatic' ? { programmaticToolPolicy: createProgrammaticToolPolicy({ userId: uid }) } : {}),
  });
  for await (const event of runner.runStream({ message: 'Create a small interactive app.', workingDir: root })) {
    if (event.type === 'tool_end') receipts.push(event);
  }
  expect(receipts).toHaveLength(2);
  expect(receipts.every(receipt => !receipt.isError)).toBe(true);
  expect(created).toHaveLength(2);
  expect(created[0]).toMatchObject({ id: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/), revision: 1 });
  expect(created[1]).toEqual({ ...created[0], revision: 2 });
  expect(receipts[0].result).toContain(`created (id ${created[0].id}); revision 1`);
  expect(receipts[1].result).toContain(`updated (id ${created[0].id}); revision 2`);
  expect(JSON.stringify(requests[1].messages)).toContain(JSON.stringify(receipts[0].result).slice(1, -1));
  const parent = path.join(root, uid, 'cloud/chat_artifacts', cid);
  expect(fs.readdirSync(parent)).toEqual([created[0].id]);
  expect(fs.readFileSync(path.join(parent, created[0].id, 'index.html'), 'utf8')).toContain('<button>Delivered</button>');
  expect(schema.properties.artifact_id.type).toEqual(['string', 'null']);
});

it('refuses a programmatic revision by another creator without replacing the app or delivering a card', async () => {
  const artifacts = await import('../../../src/main/features/chat_artifacts');
  const original = await artifacts.createArtifact(uid, cid, 'owner', {
    files: [{ path: 'index.html', content: '<h1>Original</h1>' }],
  });
  if (!original.ok) throw Error(original.error);
  const { createLocalTools } = await import('../../../src/main/model/core-agent/local-tools');
  const created = vi.fn(), preview = vi.fn();
  const tool = createLocalTools({ userId: uid, cid, agentId: 'other', onArtifactCreated: created,
    artifactInteractionSmoke: preview,
  }).find(tool => tool.name === 'create_artifact')!;
  let round = 0;
  const provider: any = {
    id: 'app-owner-fixture', name: 'Scripted no-network provider',
    async complete() { throw Error('Unexpected auxiliary model request'); },
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'message_end', model: 'fixture', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: round === 0 ? 'tool_use' : 'end_turn', content: round++ === 0 ? [{
          type: 'tool_use', id: 'foreign-app', name: 'run_program', input: {
            code: `const result = await tools.create_artifact(${JSON.stringify({ artifact_id: original.artifactId,
              files: [{ path: 'index.html', content: '<h1>Replaced</h1>' }],
            })}); json({ ok: result.ok, error: result.content });`,
          },
        }] : [{ type: 'text', text: 'The existing app was preserved.' }],
      };
    },
    async validateAuth() { return true; },
  };
  const providers = new ProviderRegistry(); providers.registerFactory(provider.id, () => provider);
  const runner = new AgentRunner({
    config: createConfig({ agent: { defaultProvider: provider.id, defaultModel: 'fixture', maxToolLoops: 2 } }),
    providers, tools: [tool], evolution: { enabled: false }, programmaticToolPolicy: createProgrammaticToolPolicy({ userId: uid }),
  });
  const receipts: any[] = [];
  for await (const event of runner.runStream({ message: 'Revise the application.', workingDir: root })) {
    if (event.type === 'tool_end') receipts.push(event);
  }
  expect(receipts).toHaveLength(1);
  expect(receipts[0].isError).not.toBe(true);
  expect(receipts[0].result).toContain('"ok":false');
  expect(receipts[0].result).toContain('E_BAD_ARTIFACT');
  expect(created).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
  const directory = path.join(root, uid, 'cloud/chat_artifacts', cid);
  expect(fs.readdirSync(directory)).toEqual([original.artifactId]);
  expect(fs.readFileSync(path.join(directory, original.artifactId, 'index.html'), 'utf8')).toContain('<h1>Original</h1>');
  expect(artifacts.readArtifactMeta(uid, cid, original.artifactId)?.revision).toBe(1);
});
