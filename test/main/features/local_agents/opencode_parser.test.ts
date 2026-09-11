import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  buildOpencodeArgs,
  buildOpencodeEnv,
  mapOpencodeEvent,
  extractOpencodeUsage,
} from '../../../../src/main/features/local_agents/backends/opencode';

describe('OpenCode run-scoped MCP configuration', () => {
  const bridge = {
    mcpConfigPath: '/private/run/mcp.json',
    server: { command: '/runtime/node', args: ['/app/orkas-bridge.cjs'], env: { ORKAS_BRIDGE_ENV_FILE: '/private/run/env.json' } },
  };

  it('preserves inherited JSONC settings while replacing only the run-owned Orkas server', () => {
    const inherited = { OPENCODE_CONFIG: '/custom/config.jsonc', OPENCODE_CONFIG_CONTENT: `{
      // User-selected model and an unrelated server must survive.
      "model": "provider/model", "label": "https://example.test/a//b/*c*/",
      "mcp": {"other": {"type": "remote", "url": "https://example.test/mcp"}, "orkas": {"enabled": false},},
    }` };
    const env = buildOpencodeEnv(bridge, inherited);
    expect(env.OPENCODE_CONFIG).toBe(inherited.OPENCODE_CONFIG);
    expect(inherited.OPENCODE_CONFIG_CONTENT).toContain('// User-selected');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      model: 'provider/model', label: 'https://example.test/a//b/*c*/',
      mcp: {
        other: { type: 'remote', url: 'https://example.test/mcp' },
        orkas: { type: 'local', command: ['/runtime/node', '/app/orkas-bridge.cjs'], environment: bridge.server.env, enabled: true },
      },
    });
  });

  it('leaves inline configuration untouched when no bridge is granted', () => {
    const inherited = { OPENCODE_CONFIG_CONTENT: 'invalid native config remains native-owned' };
    expect(buildOpencodeEnv(undefined, inherited).OPENCODE_CONFIG_CONTENT).toBe(inherited.OPENCODE_CONFIG_CONTENT);
  });

  it.each(['[]', 'null', '{"mcp":[]}', '{"mcp":null}', '{"private-key": "secret", broken}', '{ /* unfinished'])
    ('rejects malformed config rather than discarding it or exposing it: %s', (raw) => {
      expect(() => buildOpencodeEnv(bridge, { OPENCODE_CONFIG_CONTENT: raw }))
        .toThrow('OpenCode inline configuration must be a JSON/JSONC object with an object-valued mcp section');
    });
});

describe('local_agents/backends/opencode › mapOpencodeEvent', () => {
  it('captures sessionID at the top level', () => {
    const r = mapOpencodeEvent({ type: 'step_start', sessionID: 's1' });
    expect(r?.captureSessionId).toBe('s1');
    expect((r?.event as any)?.status).toBe('running');
  });

  it('captures sessionID nested under .part', () => {
    const r = mapOpencodeEvent({ type: 'text', part: { sessionID: 's2', text: 'hi' } });
    expect(r?.captureSessionId).toBe('s2');
    expect(r?.event).toEqual({ type: 'text-delta', text: 'hi' });
  });

  it('keeps only path metadata from an in-progress file tool input', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: {
        tool: 'write',
        callID: 'c1',
        state: {
          status: 'pending',
          input: { filePath: 'x.md', content: 'private file body', description: 'write a file' },
        },
      },
    });
    expect(r?.event).toMatchObject({ type: 'tool-event', tool: 'write', phase: 'use', callId: 'c1' });
    expect((r?.event as any).input).toEqual({ filePath: 'x.md' });
    expect(JSON.stringify(r?.event)).not.toContain('private file body');
  });

  it('preserves command and duration from a real result-only completed tool state', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: {
        tool: 'bash',
        callID: 'c1',
        state: {
          status: 'completed',
          input: { command: 'ls -la ./src', description: 'inspect files' },
          output: 'file body',
          time: { start: 1_000, end: 1_075 },
        },
      },
    });
    expect(r?.event).toEqual({
      type: 'tool-event',
      tool: 'bash',
      callId: 'c1',
      phase: 'result',
      input: { command: 'ls -la ./src' },
      output: 'file body',
      durationMs: 75,
    });
  });

  it('bounds retained command metadata from a completed tool state', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: {
        tool: 'bash',
        callID: 'long-command',
        state: { status: 'completed', input: { command: 'x'.repeat(10_000) }, output: 'ok' },
      },
    });

    expect((r?.event as any).input.command).toHaveLength(4_096);
  });

  it('preserves only the target path from a completed write and never its content', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: {
        tool: 'write',
        callID: 'c2',
        state: {
          status: 'completed',
          input: {
            filePath: '/workspace/snake.html',
            content: '<html>private body</html>',
            files: [{ filePath: '/workspace/score.json', content: 'nested private body' }],
          },
          output: 'Wrote file successfully.',
          time: { start: 2_000, end: 2_010 },
        },
      },
    });

    expect((r?.event as any).input).toEqual({
      filePath: '/workspace/snake.html',
      files: [{ filePath: '/workspace/score.json' }],
    });
    expect((r?.event as any).output).toBe('Wrote file successfully.');
    expect(JSON.stringify(r?.event)).not.toContain('<html>private body</html>');
    expect(JSON.stringify(r?.event)).not.toContain('nested private body');
  });

  it('maps an errored tool state to a result with recoverable error details', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: {
        tool: 'read',
        callID: 'c3',
        state: {
          status: 'error',
          input: { path: '/workspace/missing.txt' },
          error: 'File not found',
          time: { start: 3_000, end: 3_025 },
        },
      },
    });

    expect(r?.event).toEqual({
      type: 'tool-event',
      tool: 'read',
      callId: 'c3',
      phase: 'result',
      input: { path: '/workspace/missing.txt' },
      output: '',
      durationMs: 25,
      error: 'File not found',
      isError: true,
    });
  });

  it('stringifies non-string tool outputs', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: { tool: 'library', callID: 'c1', state: { status: 'completed', output: { hits: 4 } } },
    });
    expect((r?.event as any).output).toBe('{"hits":4}');
  });

  it('maps completed image attachments without replacing the tool result', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: {
        tool: 'image_generate',
        callID: 'image-1',
        state: {
          status: 'completed',
          output: 'generated',
          attachments: [
            { type: 'file', mime: 'image/png', filename: 'result.png', url: 'data:image/png;base64,AAAA' },
            { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///tmp/notes.txt' },
          ],
        },
      },
    });
    expect(r?.event).toMatchObject({ type: 'tool-event', callId: 'image-1', output: 'generated' });
    expect(r?.events).toEqual([
      expect.objectContaining({ type: 'tool-event', callId: 'image-1' }),
      {
        type: 'media-output',
        source: 'opencode',
        callId: 'image-1',
        items: [{
          uri: 'data:image/png;base64,AAAA',
          mediaType: 'image/png',
          name: 'result.png',
        }],
      },
    ]);
  });

  it('error type produces a terminal failed status with message', () => {
    const r = mapOpencodeEvent({ type: 'error', error: { data: { message: 'auth fail' } } });
    expect(r?.terminal).toEqual({ status: 'failed', error: 'auth fail' });
  });

  it('step_finish with extractable usage produces status:usage (not log)', () => {
    const r = mapOpencodeEvent({
      type: 'step_finish',
      part: { tokens: { input: 100, output: 50, cache: 25 }, model: 'gpt-5' },
    });
    expect(r?.event).toEqual({
      type: 'status',
      status: 'usage',
      usage: { input: 100, output: 50, cacheRead: 25, model: 'gpt-5' },
    });
  });

  it('step_finish without usage falls back to a debug log so the row is still visible', () => {
    const r = mapOpencodeEvent({ type: 'step_finish', part: { foo: 'bar' } });
    expect((r?.event as any).type).toBe('log');
    expect((r?.event as any).level).toBe('debug');
    expect((r?.event as any).message).toContain('step_finish');
  });

  it('unknown event type becomes an info log so wire-format drift is visible', () => {
    const r = mapOpencodeEvent({ type: 'mystery_new_event', payload: 1 });
    expect((r?.event as any).type).toBe('log');
    expect((r?.event as any).level).toBe('info');
    expect((r?.event as any).message).toContain('mystery_new_event');
  });
});

describe('local_agents/backends/opencode › extractOpencodeUsage', () => {
  it('reads from part.tokens nested block (canonical shape)', () => {
    const u = extractOpencodeUsage({ tokens: { input: 10, output: 20, cache: 5 } });
    expect(u).toEqual({ input: 10, output: 20, cacheRead: 5 });
  });

  it('also accepts a flat shape with snake_case keys', () => {
    const u = extractOpencodeUsage({ input_tokens: 10, output_tokens: 20 });
    expect(u).toEqual({ input: 10, output: 20 });
  });

  it('attaches model when present', () => {
    const u = extractOpencodeUsage({ tokens: { input: 1, output: 1 }, model: 'gpt-5' });
    expect(u?.model).toBe('gpt-5');
  });

  it('returns undefined when no numeric counter is present', () => {
    expect(extractOpencodeUsage({})).toBeUndefined();
    expect(extractOpencodeUsage({ tokens: {} })).toBeUndefined();
    expect(extractOpencodeUsage(null)).toBeUndefined();
  });
});

describe('local_agents/backends/opencode › fixed full access', () => {
  it('always enables OpenCode auto mode in the selected absolute directory', () => {
    const cwd = path.join('fixtures', 'selected project');
    const args = buildOpencodeArgs({ prompt: 'hi', cwd });
    expect(args).not.toContain('--model');
    expect(args).toEqual([
      'run',
      '--auto',
      '--format',
      'json',
      '--dir',
      path.resolve(cwd),
      'hi',
    ]);
  });

  it('maps per-Agent model and thinking overrides to model and variant flags', () => {
    const args = buildOpencodeArgs({
      prompt: 'hi',
      cwd: '/workspace/project',
      modelOverride: 'openai/gpt-5.4',
      thinkingLevel: 'high',
    });
    expect(args).toEqual([
      'run', '--auto', '--format', 'json',
      '--model', 'openai/gpt-5.4', '--variant', 'high',
      '--dir', path.resolve('/workspace/project'), 'hi',
    ]);
  });

  it('removes split and equals-form custom directories so only the selected directory reaches OpenCode', () => {
    const selected = path.resolve('/workspace/selected');
    const args = buildOpencodeArgs({
      prompt: 'hi',
      cwd: selected,
      customArgs: [
        '--dir', '/workspace/stale-a',
        '--model', 'custom/model',
        '--dir=/workspace/stale-b',
        '--directory', '/workspace/not-a-dir-flag',
        '--dir', '/workspace/stale-c',
      ],
    });

    const directoryFlags = args.filter((arg) => arg === '--dir' || arg.startsWith('--dir='));
    expect(directoryFlags).toEqual(['--dir']);
    expect(args.indexOf('--dir')).toBeLessThan(args.indexOf('--model'));
    expect(args.at(-1)).toBe('hi');
    expect(args).not.toContain('/workspace/stale-a');
    expect(args).not.toContain('--dir=/workspace/stale-b');
    expect(args).not.toContain('/workspace/stale-c');
    expect(args).toContain('--model');
    expect(args).toContain('custom/model');
    expect(args).toContain('--directory');
    expect(args).toContain('/workspace/not-a-dir-flag');
  });

  it('drops a dangling custom --dir instead of letting it compete with the host-owned flag', () => {
    const selected = path.resolve('/workspace/selected');
    const args = buildOpencodeArgs({
      prompt: 'hi',
      cwd: selected,
      customArgs: ['--verbose', '--dir'],
    });

    expect(args).toEqual([
      'run', '--auto', '--format', 'json',
      '--dir', selected, '--verbose', 'hi',
    ]);
  });

  it('preserves the option following a malformed custom --dir without a value', () => {
    const selected = path.resolve('/workspace/selected');
    const args = buildOpencodeArgs({
      prompt: 'hi',
      cwd: selected,
      customArgs: ['--dir', '--verbose'],
    });

    expect(args).toEqual([
      'run', '--auto', '--format', 'json',
      '--dir', selected, '--verbose', 'hi',
    ]);
  });

  it('keeps the authoritative directory before a custom option terminator', () => {
    const selected = path.resolve('/workspace/selected');
    const args = buildOpencodeArgs({
      prompt: 'hi',
      cwd: selected,
      customArgs: ['--verbose', '--'],
    });

    expect(args).toEqual([
      'run', '--auto', '--format', 'json',
      '--dir', selected, '--verbose', '--', 'hi',
    ]);
    expect(args.indexOf('--dir')).toBeLessThan(args.indexOf('--'));
  });
});
