import { describe, it, expect } from 'vitest';
import { isTransientError } from '../../../src/main/util/transient-errors';

// Pinned per CLAUDE.md §9 — text-classifier with set A (must match) +
// set B (must NOT match). Mirrors the patterns formerly local to
// plan_executor.ts:75 + now shared with expert_signals/turn_hooks.ts.

describe('isTransientError — set A (network-class blips)', () => {
  it.each([
    'fetch failed at provider',
    'undici terminated',
    'connect ECONNRESET 1.2.3.4:443',
    'ETIMEDOUT during read',
    'connect ECONNREFUSED',
    'getaddrinfo EAI_AGAIN',
    'socket hang up',
    'EPIPE',
    'network error',
    'Connection closed unexpectedly',
    'Codex SSE response headers timed out after 10000ms',
    'SSE response headers timed out',
    'UND_ERR_HEADERS_TIMEOUT',
    'WebSocket closed unexpectedly',
    'stream disconnected before completion',
    '504 Gateway Timeout',
    'rate limit exceeded',
  ])('matches transient pattern: %s', (msg) => {
    expect(isTransientError(msg)).toBe(true);
  });

  it('case-insensitive', () => {
    expect(isTransientError('Fetch Failed')).toBe(true);
    expect(isTransientError('econnreset')).toBe(true);
  });
});

describe('isTransientError — set B (permanent / non-network)', () => {
  it.each([
    'agent specification missing',
    'parse failure: invalid JSON in tool output',
    'sandbox: path out of scope',
    'no model configured',
    'tool rejected: bad arguments',
    'permission denied',
    'aborted by user',
  ])('does NOT match: %s', (msg) => {
    expect(isTransientError(msg)).toBe(false);
  });
});

describe('isTransientError — edge cases', () => {
  it('empty / null / undefined → false', () => {
    expect(isTransientError('')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});
