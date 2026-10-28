import { it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const logs = vi.hoisted(() => [] as Array<{ level: string; message: string; data?: any }>);
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level =>
    [level, (message: string, data?: any) => logs.push({ level, message, data })])),
}));
vi.mock('../../../../src/main/util/system-activity', () => ({ getAgentIdleClock: async () => () => Date.now() }));

// Opt in with an installed native CLI. Only assistant protocol frames are
// simulated by a loopback API; the runner, MCP host, child and tool reads are real.
// This exercises transport compatibility, not model quality or paid inference.
it.runIf(!!process.env.ORKAS_CLAUDE_MCP_CANARY_PATH)(
  'real Claude CLI completes cold/resumed MCP reads and honors native permission denial', async () => {
    const cliPath = process.env.ORKAS_CLAUDE_MCP_CANARY_PATH!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-claude-mcp-canary-'));
    const prior = { ...process.env };
    const observations: Array<{ scenario: string; verified: boolean }> = [];
    let scenario = '', phase = '', toolId = '', issued = false;
    let requests = 0;
    let fatal: string | undefined;
    let streamingResponse: http.ServerResponse | undefined;
    const streamEmit = (event: string, data: Record<string, unknown>) => streamingResponse!.write(
      'event: ' + event + '\ndata: ' + JSON.stringify({ type: event, ...data }) + '\n\n');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 4_000_000) req.destroy(); });
      req.on('end', () => {
        if (!req.url?.startsWith('/v1/messages')) {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return;
        }
        if (++requests > 14) { fatal = 'API fixture request budget exceeded'; res.writeHead(429); res.end('{}'); return; }
        let payload: any;
        try { payload = JSON.parse(body); }
        catch { fatal = 'Malformed request to API fixture'; res.writeHead(400); res.end('{}'); return; }
        if (phase.startsWith('stream-')) {
          if (!payload.stream) { fatal = 'Streaming fixture received a nonstreaming request'; res.writeHead(400); res.end('{}'); return; }
          streamingResponse = res;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          streamEmit('message_start', { message: { id: 'msg_stream', type: 'message', role: 'assistant',
            model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 50, output_tokens: 0 } } });
          if (phase === 'stream-thinking') {
            streamEmit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
            streamEmit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture reasoning.' } });
            streamEmit('content_block_stop', { index: 0 });
          }
          const index = phase === 'stream-thinking' ? 1 : 0;
          streamEmit('content_block_start', { index, content_block: { type: 'text', text: '' } });
          streamEmit('content_block_delta', { index, delta: { type: 'text_delta', text: 'First ' } });
          // Leave the response open: the test releases the next chunk only
          // after the real CLI and runner have delivered this prefix.
          return;
        }
        let block: any, stop: string;
        if (!issued) {
          const suffix = phase === 'list' ? 'orkas_list_skills' : 'orkas_read_skill';
          const tool = (payload.tools || []).find((t: any) => phase === 'denied'
            ? t.name === 'Write' : phase === 'cancel-tool' ? t.name === 'Bash' : t.name?.endsWith('__' + suffix));
          if (!tool) { fatal = 'Expected tool missing from actual CLI request'; res.writeHead(400); res.end('{}'); return; }
          issued = true;
          block = { type: 'tool_use', id: toolId, name: tool.name, input: phase === 'denied'
            ? { file_path: path.join(root, 'must-not-exist.txt'), content: 'Unapproved write' }
            : phase === 'cancel-tool' ? {
              command: `${JSON.stringify(process.env.ORKAS_TEST_NODE || process.execPath)} ${JSON.stringify(path.join(root, 'cancel-tool.cjs'))}`,
              timeout: 10000,
            }
            : phase === 'list' ? {} : { id: 'compat-probe-skill' } };
          stop = 'tool_use';
        } else {
          const result = (payload.messages || []).flatMap((m: any) => Array.isArray(m.content) ? m.content : [])
            .find((b: any) => b.type === 'tool_result' && b.tool_use_id === toolId);
          const verified = phase === 'denied'
            ? result && result.is_error && !fs.existsSync(path.join(root, 'must-not-exist.txt'))
            : result && !result.is_error && JSON.stringify(result.content).includes(phase === 'list' ? 'compat-probe-skill' : 'COMPAT_BODY');
          observations.push({ scenario, verified: !!verified });
          if (!verified) fatal = 'Actual tool result failed the independent fixture oracle';
          if (verified && phase !== 'denied') {
            if (!payload.stream) { fatal = 'Post-tool fixture received a nonstreaming request'; res.writeHead(400); res.end('{}'); return; }
            streamingResponse = res;
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            streamEmit('message_start', { message: { id: 'msg_' + toolId, type: 'message', role: 'assistant',
              model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 50, output_tokens: 0 } } });
            // The resumed journey includes reasoning before its final reply.
            // Neither the text block nor the response ends until the consumer
            // has independently observed both prefixes from the real CLI.
            if (phase === 'read') {
              streamEmit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
              streamEmit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture reasoning.' } });
              streamEmit('content_block_stop', { index: 0 });
            }
            const index = phase === 'read' ? 1 : 0;
            streamEmit('content_block_start', { index, content_block: { type: 'text', text: '' } });
            streamEmit('content_block_delta', { index, delta: { type: 'text_delta', text: 'ORKAS_COMPAT_' } });
            return;
          }
          block = { type: 'text', text: verified ? 'ORKAS_COMPAT_VERIFIED' : 'ORKAS_COMPAT_FAILED' }; stop = 'end_turn';
        }
        const message = { id: 'msg_' + toolId, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } };
        if (payload.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const emit = (event: string, data: any) => res.write('event: ' + event + '\ndata: ' + JSON.stringify({ type: event, ...data }) + '\n\n');
          emit('message_start', { message });
          emit('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
          emit('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
          emit('content_block_stop', { index: 0 });
          emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
          emit('message_stop', {}); res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...message, content: [block], stop_reason: stop, usage: { input_tokens: 50, output_tokens: 20 } }));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_') || key.startsWith('MCP_') || key.startsWith('ORKAS_BRIDGE_')) delete process.env[key];
      }
      Object.assign(process.env, { ORKAS_WORKSPACE_ROOT: root, ORKAS_CLAUDE_PATH: cliPath,
        ORKAS_CLAUDE_STREAM_DIAGNOSTICS: '1',
        ORKAS_LOCAL_AGENT_TIMEOUT_MS: '45000', ORKAS_LOCAL_AGENT_IDLE_KILL_MS: '30000',
        ANTHROPIC_API_KEY: 'non-secret-local-fixture', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + (server.address() as any).port,
        CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'), DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ENABLE_TOOL_SEARCH: 'false' });
      vi.resetModules(); logs.length = 0;
      const users = await import('../../../../src/main/features/users'); users.activateUser('compat-user');
      const skillDir = path.join(root, 'compat-user', 'cloud', 'skills', 'compat-probe-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: compat-probe-skill\ndescription: Compatibility probe\n---\nCOMPAT_BODY');
      const runner = await import('../../../../src/main/features/local_agents/runner');
      for (const mode of ['default', 'legacy']) {
        if (mode === 'legacy') process.env.MCP_PROTOCOL_NEGOTIATION = 'legacy'; else delete process.env.MCP_PROTOCOL_NEGOTIATION;
        const cwd = path.join(root, mode); fs.mkdirSync(cwd, { recursive: true });
        let sessionId: string | undefined;
        for (const turn of ['cold', 'resume']) {
          scenario = mode + '-' + turn; phase = turn === 'cold' ? 'list' : 'read'; toolId = 'call_' + scenario; issued = false;
          streamingResponse = undefined;
          const events: any[] = [];
          const controller = new AbortController();
          const running = runner.run({ uid: 'compat-user', cid: 'compat-' + mode, agentId: 'compat-agent',
            currentMessageId: 'trigger-' + scenario, cli: 'claude', cwd, permissionPolicy: 'inherit',
            prompt: turn === 'cold' ? 'What Orkas skills are available?' : 'Read the compatibility probe skill.',
            customArgs: ['--allowedTools', 'mcp__orkas__orkas_list_skills,mcp__orkas__orkas_read_skill', '--setting-sources', ''],
            ...(sessionId ? { resumeSessionId: sessionId } : {}), signal: controller.signal, onEvent: e => events.push(e) });
          let result: Awaited<typeof running>;
          try {
            await vi.waitFor(() => expect(events.filter(e => e.type === 'text-delta').map(e => e.text)).toEqual(['ORKAS_COMPAT_']),
              { timeout: 10_000, interval: 20 });
            expect(events.some(e => e.type === 'done')).toBe(false);
            const index = turn === 'resume' ? 1 : 0;
            streamEmit('content_block_delta', { index, delta: { type: 'text_delta', text: 'VERIFIED' } });
            await vi.waitFor(() => expect(events.filter(e => e.type === 'text-delta').map(e => e.text)).toEqual(['ORKAS_COMPAT_', 'VERIFIED']),
              { timeout: 3_000, interval: 20 });
            expect(events.some(e => e.type === 'done')).toBe(false);
            streamEmit('content_block_stop', { index });
            streamEmit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
            streamEmit('message_stop', {});
            streamingResponse!.end();
            result = await running;
          } finally {
            controller.abort();
            streamingResponse?.destroy();
            await running;
          }
          expect(fatal).toBeUndefined(); expect(result.status).toBe('completed'); expect(result.output?.trim()).toBe('ORKAS_COMPAT_VERIFIED');
          expect(events.some(e => e.type === 'tool-event' && e.phase === 'use' && e.tool?.endsWith(phase === 'list' ? 'orkas_list_skills' : 'orkas_read_skill'))).toBe(true);
          expect(events.filter(e => e.type === 'stderr-line' || e.type === 'raw-line' || (e.type === 'log' && ['warn', 'error'].includes(e.level)))).toHaveLength(0);
          expect(events.filter(e => e.type === 'done')).toHaveLength(1);
          expect(logs.filter(l => l.message === 'claude stdout delivery summary').at(-1)?.data)
            .toMatchObject({ partialTextDeltas: 2, fallbackTextRecords: 0,
              lastStreamedText: { chars: 21, deltas: 2, reads: 2, maxDeltasPerRead: 1 } });
          sessionId = events.find(e => e.type === 'done')?.sessionId; expect(sessionId).toBeTruthy();
        }
      }
      delete process.env.MCP_PROTOCOL_NEGOTIATION;
      scenario = 'default-permission-denied'; phase = 'denied'; toolId = 'call_denied'; issued = false;
      const permissions = await import('../../../../src/main/features/local_agents/cli_permissions');
      let permissionRequests = 0;
      permissions._setBroadcastForTest((channel, payload: any) => {
        if (channel === 'local-agent:permission') { permissionRequests++; queueMicrotask(() => permissions.respond(payload.request_id, 'deny')); }
        return true;
      });
      const events: any[] = [];
      const denied = await runner.run({ uid: 'compat-user', cid: 'compat-denied', agentId: 'compat-agent',
        currentMessageId: 'trigger-denied', cli: 'claude', cwd: path.join(root, 'default'), permissionPolicy: 'ask',
        prompt: 'Save a test note in this temporary workspace.', customArgs: ['--setting-sources', ''],
        signal: new AbortController().signal, onEvent: e => events.push(e) });
      expect(fatal).toBeUndefined(); expect(denied.status).toBe('completed'); expect(denied.output?.trim()).toBe('ORKAS_COMPAT_VERIFIED');
      expect(permissionRequests).toBe(1); expect(fs.existsSync(path.join(root, 'must-not-exist.txt'))).toBe(false);
      expect(events.some(e => e.type === 'permission-request' && e.decision === 'deny')).toBe(true);
      expect(events.filter(e => e.type === 'stderr-line' || e.type === 'raw-line' || (e.type === 'log' && ['warn', 'error'].includes(e.level)))).toHaveLength(0);
      expect(observations).toHaveLength(5); expect(observations.every(o => o.verified)).toBe(true);
      const streamingScenarios: string[] = [];
      for (const shape of ['stream-text', 'stream-thinking']) {
        phase = shape;
        streamingResponse = undefined;
        const streamed: any[] = [];
        const controller = new AbortController();
        const running = runner.run({ uid: 'compat-user', cid: shape, agentId: 'compat-agent',
          currentMessageId: 'trigger-' + shape, cli: 'claude', cwd: path.join(root, 'default'),
          permissionPolicy: 'inherit', prompt: 'Describe the fixture.', customArgs: ['--setting-sources', ''],
          signal: controller.signal, onEvent: e => streamed.push(e) });
        try {
          await vi.waitFor(() => expect(streamed.filter(e => e.type === 'text-delta').map(e => e.text)).toEqual(['First ']),
            { timeout: 10_000, interval: 20 });
          expect(streamed.some(e => e.type === 'done')).toBe(false);
          const index = shape === 'stream-thinking' ? 1 : 0;
          streamEmit('content_block_delta', { index, delta: { type: 'text_delta', text: 'second.' } });
          await vi.waitFor(() => expect(streamed.filter(e => e.type === 'text-delta').map(e => e.text)).toEqual(['First ', 'second.']),
            { timeout: 3_000, interval: 20 });
          expect(streamed.some(e => e.type === 'done')).toBe(false);
          streamEmit('content_block_stop', { index });
          streamEmit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
          streamEmit('message_stop', {});
          streamingResponse!.end();
          const result = await running;
          expect(fatal).toBeUndefined();
          expect(result.status).toBe('completed');
          expect(result.output).toBe('First second.');
          expect(streamed.filter(e => e.type === 'text-delta').map(e => e.text)).toEqual(['First ', 'second.']);
          expect(streamed.filter(e => e.type === 'stderr-line' || e.type === 'raw-line' || (e.type === 'log' && ['warn', 'error'].includes(e.level)))).toHaveLength(0);
          streamingScenarios.push(shape);
        } finally {
          controller.abort();
          streamingResponse?.destroy();
          await running;
        }
      }
      phase = 'cancel-tool'; scenario = phase; toolId = 'call_cancel'; issued = false;
      fs.writeFileSync(path.join(root, 'cancel-tool.cjs'), [
        "const fs = require('node:fs'); const path = require('node:path');",
        "fs.writeFileSync(path.join(__dirname, 'tool-started'), 'ready');",
        "setTimeout(() => fs.writeFileSync(path.join(__dirname, 'late-effect'), 'survived'), 2000);",
      ].join('\n'));
      const cancelledEvents: any[] = [];
      const cancellation = new AbortController();
      const pending = runner.run({ uid: 'compat-user', cid: 'cancel-native-tool', agentId: 'compat-agent',
        currentMessageId: 'trigger-cancel-native-tool', cli: 'claude', cwd: path.join(root, 'default'),
        permissionPolicy: 'full_access', prompt: 'Run the requested foreground fixture command.',
        customArgs: ['--setting-sources', ''], signal: cancellation.signal, onEvent: event => cancelledEvents.push(event) });
      try {
        await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'tool-started'))).toBe(true), { timeout: 10000, interval: 20 });
        cancellation.abort();
        const result = await pending;
        expect(result.status).toBe('cancelled');
        await new Promise(resolve => setTimeout(resolve, 2200));
        expect(fs.existsSync(path.join(root, 'late-effect'))).toBe(false);
        expect(cancelledEvents.filter(event => event.type === 'done')).toHaveLength(1);
        expect(cancelledEvents.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
      } finally { cancellation.abort(); await pending; }
      expect(fatal).toBeUndefined();
      expect(logs.filter(l => l.level === 'warn' || l.level === 'error')).toEqual([]);
      console.log(JSON.stringify({ version: denied.cliVersion, verifiedScenarios: observations, streamingScenarios,
        cancellationVerified: true, paidModelCalls: 0, apiFixtureRequests: requests }));
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      try { (await import('../../../../src/main/features/local_agents/cli_permissions'))._resetForTest(); } catch {}
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env, prior);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180000);
