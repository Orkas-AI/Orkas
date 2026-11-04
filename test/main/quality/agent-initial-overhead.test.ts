import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';

it('keeps every shipped Agent within the uniform initial-overhead budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sync-overhead-'));
  const previous = { workspace: process.env.ORKAS_WORKSPACE_ROOT, skills: process.env.ORKAS_TEST_GLOBAL_SKILLS_ROOT, mode: process.env.ORKAS_TOOL_LOADING_MODE };
  process.env.ORKAS_WORKSPACE_ROOT = root;
  process.env.ORKAS_TEST_GLOBAL_SKILLS_ROOT = path.join(root, 'global-skills');
  process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
  vi.resetModules();
  const closeLogs = await captureMainLogWorkers();
  const rows: any[] = [];
  let selected: any;
  vi.doMock('#core-agent', async () => {
    const actual = await vi.importActual<any>('#core-agent');
    return { ...actual, createPiProvider: () => ({
      id: 'custom', name: 'No-network request observation',
      validateAuth: async () => true,
      complete: async () => { throw new Error('Probe must not make secondary model calls'); },
      async *stream(params: any) {
        const initial = { ...params, messages: [] };
        rows.push({ ...selected, F: actual.estimateCompletionRequestInputTokens(initial), systemChars: params.systemPrompt.length,
          systemSha256: createHash('sha256').update(params.systemPrompt).digest('hex'),
          toolsSha256: createHash('sha256').update(JSON.stringify(params.tools)).digest('hex'),
          toolNames: params.tools.map((tool: any) => tool.name), toolCount: params.tools.length,
          fixture: { locale: 'en', model: 'budget-fixture', contextWindow: 262144, maxTokens: 8192,
            messagesMeasured: 0, userMemory: [], projectMemory: [], explicitLoads: [] } });
        yield { type: 'text_delta', text: 'Fixture complete.' };
        yield { type: 'message_end', model: 'budget-fixture', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    }) };
  });
  const conversations: string[] = [];
  try {
    const users = await import('../../../src/main/features/users');
    users.activateUser('initial-overhead-fixture');
    const config = await import('../../../src/main/features/config');
    expect(config.setLanguage('en')).toBe('en');
    const auth = await import('../../../src/main/features/auth');
    await auth.addCustomModelEntry({ model: 'budget-fixture', protocol: 'openai', baseUrl: 'https://model.example.test/v1', apiKey: 'synthetic-probe-key', contextWindow: 262144, maxTokens: 8192 });
    const bundled = await import('../../../src/main/features/bundled_content_startup');
    const seeded = await bundled.syncBundledContentForUser('initial-overhead-fixture', { reason: 'first-window' });
    expect(seeded.failed).toEqual([]);
    const agents = await import('../../../src/main/features/agents');
    const entries = (await agents.listAgents()).filter(agent => agent.runtime?.kind !== 'cli');
    expect(entries.length).toBeGreaterThanOrEqual(16);
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const bus = await import('../../../src/main/features/group_chat/bus');
    for (const agent of [{ agent_id: 'commander', name: 'Commander', tool_list: undefined }, ...entries]) {
      selected = { agentId: agent.agent_id, name: agent.name, configuredGroups: agent.tool_list };
      const cid = `overhead-${agent.agent_id}`;
      await chats.createConversation('initial-overhead-fixture', { conversationId: cid, title: 'Initial overhead measurement' });
      conversations.push(cid);
      if (agent.agent_id !== 'commander') await state.ensureAgentMember('initial-overhead-fixture', cid, agent.agent_id, agent.name);
      const before = rows.length;
      await bus.enqueue({ uid: 'initial-overhead-fixture', cid, fromActorId: 'user', text: 'Return the fixture reply.', forceTo: [agent.agent_id] });
      await vi.waitFor(() => expect(bus.isQuiescent('initial-overhead-fixture', cid)).toBe(true), { timeout: 20000 });
      expect(rows.length, agent.agent_id).toBe(before + 1);
      expect(rows.at(-1).toolNames).toContain('tool_result');
    }
    const reportPath = process.env.ORKAS_INITIAL_OVERHEAD_REPORT;
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify({ sourceRevision: process.env.ORKAS_INITIAL_OVERHEAD_SOURCE_REVISION || null,
      targetRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      estimatorSha256: createHash('sha256').update(fs.readFileSync('src/core-agent/src/agent/runner.ts')).digest('hex'),
      resourceManifestSha256: createHash('sha256').update(fs.readFileSync('resources/builtin/_manifest.json')).digest('hex'),
      fixture: 'Clean isolated workspace, shipped resources, no connections, no explicit loading, real bus/client/runner/estimator; provider transport alone observed without network.', rows }, null, 2));
    console.log('[initial-overhead]', rows.map(row => `${row.name}=${row.F}`).join(' '));
    // The product-owner-selected engineering limit applies to complete initial
    // resident overhead, identically for every actor. It is not provider capacity.
    expect(rows.filter(row => row.F > 20_000).map(row => ({ name: row.name, F: row.F }))).toEqual([]);
  } finally {
    const bus = await import('../../../src/main/features/group_chat/bus');
    for (const cid of conversations) await bus.dropConv('initial-overhead-fixture', cid);
    await drainMainRuntimeForTest();
    await closeLogs();
    vi.doUnmock('#core-agent');
    for (const [key, value] of Object.entries({ ORKAS_WORKSPACE_ROOT: previous.workspace, ORKAS_TEST_GLOBAL_SKILLS_ROOT: previous.skills, ORKAS_TOOL_LOADING_MODE: previous.mode })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
