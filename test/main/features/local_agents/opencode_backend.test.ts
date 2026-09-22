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
      const text = JSON.stringify({ hash: createHash('sha256').update(input).digest('hex'), bytes: input.length, args });
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
});
