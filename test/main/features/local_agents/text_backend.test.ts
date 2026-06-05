import { describe, it, expect } from 'vitest';

import { makeTextBackend } from '../../../../src/main/features/local_agents/backends/_text';

describe('local_agents/backends/_text', () => {
  it('streams stdout, emits stderr lines, and reports completion', async () => {
    const backend = makeTextBackend({
      logName: 'local-agents:test-text',
      promptOnStdin: true,
      buildArgs: () => ['-e', `
        let body = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { body += chunk; });
        process.stdin.on('end', () => {
          process.stderr.write('warn line\\n');
          process.stdout.write('reply:' + body);
        });
      `],
    });
    const events: any[] = [];

    await backend.run({
      binPath: process.execPath,
      prompt: 'hello',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      onEvent: event => events.push(event),
    });

    expect(events[0]).toMatchObject({ type: 'process-info', cmd: process.execPath });
    expect(events.some(event => event.type === 'stderr-line' && event.line === 'warn line')).toBe(true);
    expect(events.some(event => event.type === 'text-delta' && String(event.text).includes('reply:hello'))).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'reply:hello',
    });
  });

  it('reports non-zero exits with partial output and stderr tail', async () => {
    const backend = makeTextBackend({
      logName: 'local-agents:test-text',
      promptOnStdin: false,
      buildArgs: () => ['-e', `
        process.stdout.write('partial');
        process.stderr.write('fatal line\\n');
        setTimeout(() => process.exit(7), 0);
      `],
    });
    const events: any[] = [];

    await backend.run({
      binPath: process.execPath,
      prompt: '',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      onEvent: event => events.push(event),
    });

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'failed',
      error: 'cli exited with code 7',
      output: 'partial',
    });
    expect(String(events.at(-1)?.stderrTail)).toContain('fatal line');
  });
});
