import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { opencodeBackend } from '../../../../src/main/features/local_agents/backends/opencode';
import type { LocalEvent } from '../../../../src/main/features/local_agents/backends/base';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-opencode-input-'));
  directories.push(cwd);
  // Node executes the backend's `run` subcommand as this script on both OSes.
  // Independent pipe consumer: no model/network, no prompt in fixture or env.
  fs.writeFileSync(path.join(cwd, 'run'), `
    const { createHash } = require('node:crypto');
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      const input = Buffer.concat(chunks);
      const args = process.argv.slice(2);
      const eofMode = args.find(arg => arg.startsWith('--fixture-eof='))?.split('=')[1];
      if (eofMode) {
        if (eofMode === 'malformed') {
          process.stdout.write('{"type":"error","error":');
          process.exitCode = 1;
          return;
        }
        const failed = eofMode === 'error';
        const prefix = failed
          ? { type: 'text', part: { text: 'Partial answer' } }
          : { type: 'step_finish', part: { tokens: { input: 13, output: 2 } } };
        process.stdout.write(JSON.stringify(prefix) + '\\n');
        const record = failed
          ? { type: 'error', sessionID: 'eof-session', error: { data: { message: 'configured model unavailable' } } }
          : { type: 'text', sessionID: 'eof-session', part: { text: 'Final answer 中文 🧪' } };
        const bytes = Buffer.from(JSON.stringify(record));
        // Independent producer ends at EOF, including a split UTF8 code point.
        const split = failed ? 17 : bytes.indexOf(Buffer.from('中')) + 1;
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
        process.exitCode = failed ? 1 : 0;
        return;
      }
      if (args.includes('--fixture-silent-fail')) {
        process.stderr.write('startup failed before JSON output\\n');
        process.exitCode = 1;
        return;
      }
      if (args.includes('--fixture-protocol-error')) {
        process.stdout.write(JSON.stringify({ type: 'error', error: { data: { message: 'configured model unavailable' } } }) + '\\n');
        process.exitCode = 1;
        return;
      }
      const text = JSON.stringify({
        hash: createHash('sha256').update(input).digest('hex'), bytes: input.length, args,
        pwd: process.env.PWD ?? null, cwd: process.cwd(),
      });
      process.stdout.write(JSON.stringify({ type: 'text', part: { text } }) + '\\n');
      if (args.includes('--fixture-wait')) { setInterval(() => {}, 1000); return; }
      process.exitCode = args.includes('--fixture-fail') ? 7 : 0;
    });
  `);
  return cwd;
}

describe('OpenCode prompt pipe transport', () => {
  it.each([false, true])('delivers the entire prompt without argv leakage (long resumed task: %s)', async (long) => {
    const cwd = fixture();
    const prompt = '--literal "quotes" & %PATH% $()\r\n中文 🧪\n' + (long ? 'history 中文\n'.repeat(100_000) : 'short task');
    const events: LocalEvent[] = [];
    await opencodeBackend.run({
      binPath: process.env.ORKAS_TEST_NODE || process.execPath,
      cwd, prompt, resumeSessionId: long ? 'resume-fixture' : undefined,
      modelOverride: 'provider/model', thinkingLevel: 'high', customArgs: ['--title', 'fixture'],
      signal: new AbortController().signal, timeoutMs: 10_000,
      onEvent: event => events.push(event),
    });
    expect(events.filter(event => event.type === 'stderr-line')).toEqual([]);
    const terminals = events.filter(event => event.type === 'done');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].status).toBe('completed');
    const result = JSON.parse(String(terminals[0].output));
    expect(result.hash).toBe(createHash('sha256').update(prompt).digest('hex'));
    expect(result.bytes).toBe(Buffer.byteLength(prompt));
    expect(result.args).toEqual([
      '--auto', '--format', 'json', ...(long ? ['--session', 'resume-fixture'] : []),
      '--model', 'provider/model', '--variant', 'high', '--dir', cwd, '--title', 'fixture',
    ]);
    expect(events.find(event => event.type === 'process-info')?.args).not.toContain(prompt);
  });

  it('starts a 2.x run in the selected directory through PWD, without the rejected --dir', async () => {
    const cwd = fixture();
    const inheritedPwd = process.env.PWD;
    // A stale launch directory must not win; 2.x reads PWD before process.cwd().
    process.env.PWD = os.tmpdir();
    const events: LocalEvent[] = [];
    try {
      await opencodeBackend.run({
        binPath: process.env.ORKAS_TEST_NODE || process.execPath,
        cwd, prompt: 'where am I', customArgs: ['--dir', '/stale/project'],
        cliFlags: ['--continue', '--session', '--model', '--format', '--auto', '--standalone', '--server'],
        signal: new AbortController().signal, timeoutMs: 10_000,
        onEvent: event => events.push(event),
      });
    } finally {
      if (inheritedPwd === undefined) delete process.env.PWD;
      else process.env.PWD = inheritedPwd;
    }
    const done = events.find(event => event.type === 'done');
    expect(done?.status).toBe('completed');
    const result = JSON.parse(String(done?.output));
    expect(result.args).toEqual(['--auto', '--format', 'json', '--standalone']);
    expect(result.pwd).toBe(path.resolve(cwd));
    expect(fs.realpathSync(result.cwd)).toBe(fs.realpathSync(cwd));
  });

  it.each(['cancel', 'fail'] as const)('preserves one terminal result when the pipe consumer ends by %s', async (mode) => {
    const events: LocalEvent[] = [];
    const controller = new AbortController();
    await opencodeBackend.run({
      binPath: process.env.ORKAS_TEST_NODE || process.execPath,
      cwd: fixture(), prompt: 'read then terminate',
      customArgs: [mode === 'cancel' ? '--fixture-wait' : '--fixture-fail'],
      signal: controller.signal, timeoutMs: 10_000,
      onEvent: event => {
        events.push(event);
        if (mode === 'cancel' && event.type === 'text-delta') controller.abort();
      },
    });
    expect(events.filter(event => event.type === 'stderr-line')).toEqual([]);
    const terminals = events.filter(event => event.type === 'done');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].status).toBe(mode === 'cancel' ? 'cancelled' : 'failed');
    if (mode === 'fail') expect(terminals[0].error).toBe('opencode exited with code 7');
  });

  it('retains content-free evidence for a CLI that exits before its first protocol record', async () => {
    const events: LocalEvent[] = [];
    await opencodeBackend.run({
      binPath: process.env.ORKAS_TEST_NODE || process.execPath,
      cwd: fixture(), prompt: 'list files', customArgs: ['--fixture-silent-fail'],
      signal: new AbortController().signal, timeoutMs: 10_000,
      onEvent: event => events.push(event),
    });
    const done = events.find(event => event.type === 'done');
    expect(done).toMatchObject({
      status: 'failed', exitCode: 1, protocolRecordCount: 0,
      protocolErrorSeen: false,
    });
    expect(events.some(event => event.type === 'stderr-line')).toBe(true);
  });

  it('distinguishes a structured CLI error from a silent startup failure', async () => {
    const events: LocalEvent[] = [];
    await opencodeBackend.run({
      binPath: process.env.ORKAS_TEST_NODE || process.execPath,
      cwd: fixture(), prompt: 'list files', customArgs: ['--fixture-protocol-error'],
      signal: new AbortController().signal, timeoutMs: 10_000,
      onEvent: event => events.push(event),
    });
    expect(events.find(event => event.type === 'done')).toMatchObject({
      status: 'failed', exitCode: 1, protocolRecordCount: 1,
      protocolErrorSeen: true, error: 'configured model unavailable',
    });
    expect(events.some(event => event.type === 'stderr-line')).toBe(false);
  });

  it.each(['success', 'error', 'malformed', 'cancel'] as const)(
    'retains the final unterminated stdout record before settling %s', async mode => {
      const events: LocalEvent[] = [];
      const controller = new AbortController();
      await opencodeBackend.run({
        binPath: process.env.ORKAS_TEST_NODE || process.execPath,
        cwd: fixture(), prompt: 'read then terminate', customArgs: [`--fixture-eof=${mode}`],
        signal: controller.signal, timeoutMs: 10_000,
        onEvent: event => {
          events.push(event);
          if (mode === 'cancel' && event.type === 'text-delta') controller.abort();
        },
      });
      const terminals = events.filter(event => event.type === 'done');
      expect(terminals).toHaveLength(1);
      const done = terminals[0];
      expect(events.at(-1)).toBe(done);
      if (mode === 'malformed') {
        expect(events.filter(event => event.type === 'raw-line').map(event => event.line))
          .toEqual(['{"type":"error","error":']);
        expect(done).toMatchObject({ status: 'failed', protocolRecordCount: 0, protocolErrorSeen: false });
        expect(events.some(event => event.type === 'text-delta')).toBe(false);
      } else {
        expect(done.sessionId).toBe('eof-session');
        expect(events.filter(event => event.type === 'text-delta').map(event => event.text))
          .toEqual([mode === 'error' ? 'Partial answer' : 'Final answer 中文 🧪']);
        expect(done.output).toBe(mode === 'error' ? 'Partial answer' : 'Final answer 中文 🧪');
        if (mode === 'error') {
          expect(done).toMatchObject({
            status: 'failed', error: 'configured model unavailable', exitCode: 1,
            protocolRecordCount: 2, protocolErrorSeen: true,
          });
        } else {
          expect(done.status).toBe(mode === 'cancel' ? 'cancelled' : 'completed');
          expect(done.usage).toMatchObject({ input: 13, output: 2 });
        }
      }
    },
  );
});
