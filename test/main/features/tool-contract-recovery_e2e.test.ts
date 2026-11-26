import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner, ProviderRegistry, createConfig, createPiProvider } from '#core-agent';

let root: string;
let previousRoot: string | undefined;
const uid = 'tool-recovery-fixture', cid = 'tool-recovery-chat';
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-tool-recovery-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(uid);
  (await import('../../../src/main/features/permissions')).setLocalExecMode('workspace_approval');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

// These controlled decisions exercise the real SDK, advertised schema, native
// executor and next-request receipts. Browser pixels and live model recovery are
// independent acceptance seams; the browser and interaction smoke are isolated.
for (const api of ['openai-completions', 'openai-responses'] as const) {
  for (const scenario of ['local-preview', 'app-preview', 'unknown-revision'] as const) {
    it(`preserves the rejection and accepts one explicit correction (${api}/${scenario})`, async () => {
      const workspace = path.join(root, 'workspace');
      fs.mkdirSync(workspace);
      const selected = (await import('../../../src/main/features/user_workspace')).setWorkspacePath(uid, workspace);
      expect(selected.ok).toBe(true);
      const html = '<!doctype html><button>Delivered fixture</button>';
      fs.writeFileSync(path.join(workspace, 'index.html'), html);
      const previewFeature = await import('../../../src/main/features/html_preview');
      const render = vi.spyOn(previewFeature, 'renderResponsiveHtmlPreview').mockResolvedValue({
        evidence: { ok: true, entryPath: path.join(workspace, 'index.html'), viewports: [], blockers: [] }, screenshots: [],
      } as any);
      const apps: Array<{ id: string }> = [];
      const { createLocalTools } = await import('../../../src/main/model/core-agent/local-tools');
      const isPreview = scenario !== 'unknown-revision';
      const name = isPreview ? 'html_preview' : 'create_artifact';
      const tool = createLocalTools({ userId: uid, cid, agentId: 'builder',
        onArtifactCreated: app => apps.push(app),
        artifactInteractionSmoke: async () => ({ ok: true, blockers: [] }),
      }).find(item => item.name === name)!;
      const files = [{ path: 'index.html', content: html }];
      let expectedEntry = path.join(workspace, 'index.html');
      let good: Record<string, unknown> = { files };
      let bad: Record<string, unknown> = { ...good, artifact_id: 'invented-new-app' };
      if (scenario === 'local-preview') {
        good = { path: 'index.html' };
        bad = { ...good, artifact_id: '' };
      } else if (scenario === 'app-preview') {
        const artifacts = await import('../../../src/main/features/chat_artifacts');
        const saved = await artifacts.createArtifact(uid, cid, 'builder', { files });
        if (!saved.ok) throw new Error('Could not create preview fixture');
        const entry = artifacts.resolveArtifactFilePath(uid, cid, saved.artifactId, 'index.html');
        if (!entry.ok) throw new Error('Could not resolve preview fixture');
        expectedEntry = entry.absPath;
        good = { artifact_id: saved.artifactId };
        bad = { ...good, path: 'index.html' };
      }
      const beforePreview = fs.readFileSync(expectedEntry);
      const observed: Array<{ input: unknown; result: any }> = [];
      const execute = tool.execute.bind(tool);
      tool.execute = async (input, ctx) => {
        const result = await execute(input, ctx);
        observed.push({ input: structuredClone(input), result });
        return result;
      };
      const wire: any[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).hostname).toBe('fixture.invalid');
        const body = JSON.parse(await request.text());
        wire.push(body);
        const round = wire.length;
        expect(round).toBeLessThanOrEqual(3);
        if (round === 2) {
          expect(render).not.toHaveBeenCalled();
          expect(apps).toEqual([]);
          const receipt = api === 'openai-completions'
            ? body.messages.find((entry: any) => entry.role === 'tool' && entry.tool_call_id === 'call_1')?.content
            : body.input.find((entry: any) => entry.type === 'function_call_output' && entry.call_id === 'call_1')?.output;
          if (isPreview) {
            expect(JSON.parse(receipt)).toMatchObject({ code: 'E_BAD_INPUT', issues: [
              { field: 'path', reason: 'conflicting_sources', expected: expect.stringMatching(/local HTML.*omit artifact_id/i) },
              { field: 'artifact_id', reason: 'conflicting_sources', expected: expect.stringMatching(/app in this conversation.*omit path/i) },
            ] });
            expect(receipt).not.toContain('index.html');
            if (scenario === 'app-preview') expect(receipt).not.toContain(good.artifact_id);
          } else {
            expect(receipt).toContain('application to revise was not found in this conversation');
          }
        }
        const args = round === 1 ? bad : good;
        const id = `call_${round}`;
        if (api === 'openai-completions') return new Response(`data: ${JSON.stringify({ choices: [{ index: 0,
          delta: round < 3 ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
            function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Done.' },
          finish_reason: round < 3 ? 'tool_calls' : 'stop',
        }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        const item = round < 3 ? { type: 'function_call', id: `fc_${round}`, call_id: id, name,
          arguments: JSON.stringify(args) } : { type: 'message', id: 'msg_final', role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
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
      const result = await runner.run({ message: 'Deliver the fixture result.', workingDir: workspace });
      expect(result.meta.error).toBeUndefined();
      expect(wire).toHaveLength(3);
      expect(observed).toHaveLength(2);
      expect(observed[0].input).toEqual(bad);
      expect(observed[0].result.isError).toBe(true);
      expect(observed[1].input).toEqual(good);
      expect(observed[1].result.isError).toBeFalsy();
      const declared = wire[0].tools.map((entry: any) => entry.function ?? entry).find((entry: any) => entry.name === name);
      expect(declared.strict).not.toBe(true);
      expect(declared.parameters.required).toEqual(isPreview ? [] : ['files']);
      if (isPreview) {
        expect(declared.parameters.properties.path.description).toMatch(/omit artifact_id/i);
        expect(declared.parameters.properties.artifact_id.description).toMatch(/omit path/i);
        expect(render).toHaveBeenCalledOnce();
        expect(render.mock.calls[0][0]).toBe(expectedEntry);
        expect(fs.readFileSync(expectedEntry)).toEqual(beforePreview);
        expect(apps).toEqual([]);
      } else {
        expect(apps).toHaveLength(1);
        const parent = path.join(root, uid, 'cloud/chat_artifacts', cid);
        expect(fs.readdirSync(parent)).toEqual([apps[0].id]);
        expect(fs.readFileSync(path.join(parent, apps[0].id, 'index.html'), 'utf8')).toContain(html);
        expect(JSON.stringify(wire[2])).toContain(apps[0].id);
      }
    });
  }
}
