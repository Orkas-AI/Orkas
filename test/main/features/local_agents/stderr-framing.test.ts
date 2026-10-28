import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexBackend } from '../../../../src/main/features/local_agents/backends/codex';
import { opencodeBackend } from '../../../../src/main/features/local_agents/backends/opencode';
import { makeAcpBackend } from '../../../../src/main/features/local_agents/backends/_acp';
import { LineSplitter, type LocalEvent } from '../../../../src/main/features/local_agents/backends/base';
import { createModelEvalLogCollector } from '../../../../scripts/model-eval-log-policy.mjs';
import { ingestLocalAgentLogEvent } from '../../../../scripts/local-agent-live-support.mjs';

const info = JSON.stringify({ timestamp: '2031-04-17T01:02:03Z', level: 'INFO', target: 'fixture::transport', fields: { message: '中文 diagnostic' } });
const warning = JSON.stringify({ timestamp: '2031-04-17T01:02:04Z', level: 'WARN', target: 'fixture::transport', fields: { message: 'Synthetic warning' } });

describe('CLI diagnostic record boundaries', () => {
  it.each(['codex', 'opencode', 'hermes'] as const)('preserves split UTF-8 records and an unterminated final warning before %s settles', async cli => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-stderr-framing-'));
    const source = `
      const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
      let started = false;
      const complete = async id => {
        if (started) return; started = true;
        const bytes = Buffer.from(${JSON.stringify(info + '\r\n')});
        for (let at = 0; at < bytes.length; at += 13) {
          process.stderr.write(bytes.subarray(at, at + 13));
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        process.stderr.write(${JSON.stringify(warning)});
        await new Promise(resolve => setTimeout(resolve, 40));
        if (${JSON.stringify(cli)} === 'codex') {
          send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } });
        } else if (${JSON.stringify(cli)} === 'hermes') send({ id, result: { stopReason: 'end_turn' } });
      };
      if (${JSON.stringify(cli)} === 'opencode') {
        process.stdin.resume(); process.stdin.on('end', () => complete());
      } else require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, userAgent: 'fixture' } });
        if (m.method === 'account/read') send({ id: m.id, result: { account: { type: 'chatgpt' } } });
        if (m.method === 'config/read') send({ id: m.id, result: { config: { model: 'gpt-6.1-sol', model_provider: 'openai' } } });
        if (m.method === 'model/list') send({ id: m.id, result: { data: [] } });
        if (m.method === 'thread/start') send({ id: m.id, result: { threadId: 'fixture-thread' } });
        if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'fixture-session' } });
        if (m.method === 'turn/start') {
          send({ id: m.id, result: { turn: { id: 'fixture-turn' } } }); complete(m.id);
        }
        if (m.method === 'session/prompt') complete(m.id);
      });
    `;
    fs.writeFileSync(path.join(cwd, cli === 'codex' ? 'app-server' : 'run'), source);
    const backend = cli === 'codex' ? codexBackend : cli === 'opencode' ? opencodeBackend
      : makeAcpBackend({ logName: 'local-agents:stderr-fixture', clientName: 'fixture', argv: ['-e', source] });
    const events: LocalEvent[] = [];
    try {
      await backend.run({ binPath: process.env.ORKAS_TEST_NODE!, cwd, prompt: 'Complete the protocol fixture',
        cliVersion: '0.160.1', signal: new AbortController().signal, timeoutMs: 5000,
        onEvent: event => events.push(event) });
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
      expect(events.filter(event => event.type === 'stderr-line').map(event => event.line)).toEqual([info, warning]);
      const logs = createModelEvalLogCollector(`${cli}/framing`);
      for (const event of events) ingestLocalAgentLogEvent(logs, event);
      expect(logs.finish()).toMatchObject({ passed: true, requiresReview: true, coveragePassed: true,
        levelCounts: { warn: 1, error: 0 } });
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('bounds unterminated diagnostics, reports overflow once and resumes at the next record', () => {
    const splitter = new LineSplitter(64);
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) splitter.push('PRIVATE'.repeat(100), line => lines.push(line));
    splitter.push('\nnext\r\nfinal', line => lines.push(line));
    splitter.flush(line => lines.push(line));
    splitter.flush(line => lines.push(line));
    expect(lines).toHaveLength(3);
    expect(lines[0].includes('exceeded')).toBe(true);
    expect(lines[0].includes('PRIVATE')).toBe(false);
    expect(lines.slice(1)).toEqual(['next', 'final']);
    const logs = createModelEvalLogCollector('overflow');
    logs.ingest('stderr', lines[0] + '\n');
    expect(logs.finish().passed).toBe(false);
  });
});
