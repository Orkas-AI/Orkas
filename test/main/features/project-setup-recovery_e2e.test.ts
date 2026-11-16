import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner, ProviderRegistry, createConfig, createPiProvider } from '#core-agent';

// Controlled provider decisions test error/receipt continuity and actual durable
// project creation. They do not establish that a live model chooses the repair.
vi.mock('../../../src/main/features/agents', () => ({ getAgent: async () => undefined }));
let root: string;
let previousRoot: string | undefined;
const uid = 'project-recovery-fixture';
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-recovery-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(async () => {
  await (await import('../../../src/main/features/search/indexer')).flushAll();
  vi.unstubAllGlobals();
  process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

for (const api of ['openai-completions', 'openai-responses'] as const) {
  for (const invalidTarget of ['existing-target', null]) {
    it(`preserves rejected create input and error before one durable correction (${api}/${invalidTarget === null ? 'null' : 'destination'})`, async () => {
      const chats = await import('../../../src/main/features/chats');
      const projects = await import('../../../src/main/features/projects');
      const tasks = await import('../../../src/main/features/project_tasks');
      const filing = await import('../../../src/main/features/conversation_filing');
      const { createProjectSetupTool } = await import('../../../src/main/features/project_setup_tool');
      const conv = await chats.createConversation(uid, { title: 'Project recovery' });
      const tool = createProjectSetupTool({ userId: uid, cid: conv.conversation_id });
      const wire: any[] = [];
      const observed: { input: unknown; result: any }[] = [];
      const execute = tool.execute.bind(tool);
      tool.execute = async (input, ctx) => {
        const result = await execute(input, ctx);
        observed.push({ input: structuredClone(input), result });
        return result;
      };
      const good = { action: 'create', name: 'Recovery project', todos: ['Check the result'] };
      const bad = { ...good, target_project: invalidTarget };
      vi.stubGlobal('fetch', vi.fn(async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).hostname).toBe('fixture.invalid');
        const body = JSON.parse(await request.text());
        wire.push(body);
        const round = wire.length;
        expect(round).toBeLessThanOrEqual(3);
        if (round === 2) {
          expect(await projects.listProjects(uid)).toEqual([]);
          expect(JSON.stringify(body)).toContain('target_project');
          if (invalidTarget === null) expect(JSON.stringify(body)).toMatch(/expected string/i);
          else expect(JSON.stringify(body)).toContain('only valid for move_conversation');
        }
        if (round === 3) {
          expect(await projects.listProjects(uid)).toHaveLength(1);
          expect(JSON.stringify(body)).toContain('todos_created');
        }
        const args = round === 1 ? bad : good;
        const id = `call_${round}`;
        if (api === 'openai-completions') return new Response(`data: ${JSON.stringify({ choices: [{ index: 0,
          delta: round < 3 ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Project created.' },
          finish_reason: round < 3 ? 'tool_calls' : 'stop',
        }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        const item = round < 3 ? { type: 'function_call', id: `fc_${round}`, call_id: id,
          name: tool.name, arguments: JSON.stringify(args) } : { type: 'message', id: 'msg_final', role: 'assistant',
          content: [{ type: 'output_text', text: 'Project created.', annotations: [] }] };
        const events = [{ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', content: [] } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: `resp_${round}`, status: 'completed', output: [item],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }];
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } });
      }));
      const provider = createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
        id: 'fixture', name: 'Fixture', provider: 'custom', api, baseUrl: 'https://fixture.invalid/v1',
        reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } });
      const providers = new ProviderRegistry();
      providers.registerFactory('custom', () => provider);
      const runner = new AgentRunner({ providers, tools: [tool], evolution: { enabled: false },
        config: createConfig({ agent: { defaultProvider: 'custom', defaultModel: 'fixture', maxRetries: 0 } }),
      });
      const result = await runner.run({ message: 'Create a project for this conversation with its next step.' });
      expect(result.meta.error).toBeUndefined();
      expect(wire).toHaveLength(3);
      expect(observed).toHaveLength(2);
      expect(observed[0].input).toEqual(bad);
      expect(observed[0].result.isError).toBe(true);
      const receipt = JSON.parse(observed[1].result.content);
      expect(receipt).toMatchObject({ ok: true, project_name: good.name, todos_created: 1, applies: 'when_this_turn_ends' });
      expect((await tasks.listTasks(uid, receipt.project_id)).map(task => task.content)).toEqual(good.todos);
      expect(await tasks.listTasks(uid, '')).toEqual([]);
      await filing.drainConversationFiling(uid, conv.conversation_id);
      expect((await chats.getConversationMetadata(uid, conv.conversation_id))?.project_id).toBe(receipt.project_id);
      expect((await projects.listProjects(uid)).map(project => project.project_id)).toEqual([receipt.project_id]);
      const declared = wire[0].tools.map((entry: any) => entry.function ?? entry).find((entry: any) => entry.name === tool.name);
      // Unsupported strict-sampling metadata may be omitted. The contract is
      // that optional destination fields are not forced into nullable inputs.
      expect(declared.strict).not.toBe(true);
      expect(declared.parameters.required).toEqual(['action']);
      expect(declared.parameters.properties.target_project.type).toBe('string');
    });
  }
}
