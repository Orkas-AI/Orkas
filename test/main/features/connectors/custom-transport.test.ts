import { describe, it, expect } from 'vitest';

import {
  validateCustomTransport,
  validateDisplayName,
  deriveCustomId,
  CustomTransportError,
} from '../../../../src/main/features/connectors/custom-transport';

// The single validation gate for user-supplied MCP transports (plan §C2).
// Fixture sets per the project text-processing rule: accepted real shapes
// AND rejected look-alikes.

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (err) {
    if (err instanceof CustomTransportError) return err.code;
    throw err;
  }
  throw new Error('expected CustomTransportError');
}

describe('connectors/custom-transport › display name + id', () => {
  it('accepts realistic names and derives prefixed ids', () => {
    expect(validateDisplayName('My Notion (work)'.replace(/[()]/g, ''))).toBe('My Notion work');
    expect(deriveCustomId('My Notion work')).toBe('custom-my-notion-work');
    expect(deriveCustomId('  ---  ')).toBe('custom-server');
    // A custom id can never equal a catalog id (always `custom-` prefixed).
    expect(deriveCustomId('github')).toBe('custom-github');
  });

  it('rejects empty / oversized / control-character names', () => {
    expect(codeOf(() => validateDisplayName(''))).toBe('E_NAME');
    expect(codeOf(() => validateDisplayName('   '))).toBe('E_NAME');
    expect(codeOf(() => validateDisplayName('a'.repeat(70)))).toBe('E_NAME');
    expect(codeOf(() => validateDisplayName('bad\nname'))).toBe('E_NAME');
    expect(codeOf(() => validateDisplayName(undefined))).toBe('E_NAME');
  });
});

describe('connectors/custom-transport › streamable-http', () => {
  it('accepts https URLs with headers', () => {
    const tr = validateCustomTransport({
      kind: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer tok', 'X-Api-Key': 'k' },
    });
    expect(tr).toEqual({
      kind: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer tok', 'X-Api-Key': 'k' },
    });
  });

  it('accepts plain http ONLY on loopback hosts', () => {
    expect(validateCustomTransport({ kind: 'streamable-http', url: 'http://localhost:3845/mcp' }).kind)
      .toBe('streamable-http');
    expect(validateCustomTransport({ kind: 'streamable-http', url: 'http://127.0.0.1:8080/' }).kind)
      .toBe('streamable-http');
    // Look-alikes that must NOT pass the loopback exception:
    expect(codeOf(() => validateCustomTransport({ kind: 'streamable-http', url: 'http://localhost.evil.com/mcp' })))
      .toBe('E_URL_INSECURE');
    expect(codeOf(() => validateCustomTransport({ kind: 'streamable-http', url: 'http://192.168.1.5/mcp' })))
      .toBe('E_URL_INSECURE');
  });

  it('rejects non-http(s) schemes and malformed URLs', () => {
    expect(codeOf(() => validateCustomTransport({ kind: 'streamable-http', url: 'file:///etc/passwd' }))).toBe('E_URL');
    expect(codeOf(() => validateCustomTransport({ kind: 'streamable-http', url: 'ws://x.example' }))).toBe('E_URL');
    expect(codeOf(() => validateCustomTransport({ kind: 'streamable-http', url: 'not a url' }))).toBe('E_URL');
    expect(codeOf(() => validateCustomTransport({ kind: 'streamable-http' }))).toBe('E_URL');
  });

  it('rejects header smuggling shapes', () => {
    expect(codeOf(() => validateCustomTransport({
      kind: 'streamable-http', url: 'https://x.example', headers: { 'Bad Name': 'v' },
    }))).toBe('E_HEADERS');
    expect(codeOf(() => validateCustomTransport({
      kind: 'streamable-http', url: 'https://x.example', headers: { Authorization: 'a\r\nX-Injected: 1' },
    }))).toBe('E_HEADERS');
  });
});

describe('connectors/custom-transport › stdio', () => {
  it('accepts a realistic npx server command', () => {
    const tr = validateCustomTransport({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@scope/mcp-server'],
      env: { API_KEY: 'secret' },
    });
    expect(tr).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@scope/mcp-server'],
      env: { API_KEY: 'secret' },
    });
  });

  it('omits empty args/env instead of storing empty containers', () => {
    expect(validateCustomTransport({ kind: 'stdio', command: 'mcp-server' }))
      .toEqual({ kind: 'stdio', command: 'mcp-server', args: [] });
  });

  it('rejects missing/multiline commands and bad env names', () => {
    expect(codeOf(() => validateCustomTransport({ kind: 'stdio' }))).toBe('E_COMMAND');
    expect(codeOf(() => validateCustomTransport({ kind: 'stdio', command: 'a\nb' }))).toBe('E_COMMAND');
    expect(codeOf(() => validateCustomTransport({
      kind: 'stdio', command: 'x', env: { 'BAD-NAME': 'v' },
    }))).toBe('E_ENV');
    expect(codeOf(() => validateCustomTransport({
      kind: 'stdio', command: 'x', args: 'not-a-list' as never,
    }))).toBe('E_ARGS');
  });

  it('drops cwd silently (not part of the accepted input surface)', () => {
    const tr = validateCustomTransport({ kind: 'stdio', command: 'x', cwd: '/tmp' });
    expect('cwd' in tr).toBe(false);
  });
});

describe('connectors/custom-transport › kind gate', () => {
  it('rejects unknown kinds (e.g. the deprecated sse)', () => {
    expect(codeOf(() => validateCustomTransport({ kind: 'sse' as never, url: 'https://x.example' })))
      .toBe('E_TRANSPORT');
    expect(codeOf(() => validateCustomTransport(undefined as never))).toBe('E_TRANSPORT');
  });
});
