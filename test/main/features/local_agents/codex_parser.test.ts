import { describe, it, expect } from 'vitest';
import { extractThreadId } from '../../../../src/main/features/local_agents/backends/codex';

describe('local_agents/backends/codex › extractThreadId', () => {
  it('returns top-level threadId when present', () => {
    expect(extractThreadId({ threadId: 'th-1', other: 1 })).toBe('th-1');
  });

  it('falls back to nested .thread.id', () => {
    expect(extractThreadId({ thread: { id: 'th-2' } })).toBe('th-2');
  });

  it('returns undefined for missing / malformed input', () => {
    expect(extractThreadId(null)).toBeUndefined();
    expect(extractThreadId(undefined)).toBeUndefined();
    expect(extractThreadId({})).toBeUndefined();
    expect(extractThreadId({ threadId: '' })).toBeUndefined();
    expect(extractThreadId({ threadId: 42 as any })).toBeUndefined();
    expect(extractThreadId({ thread: { id: 0 as any } })).toBeUndefined();
  });

  it('prefers top-level over nested when both present', () => {
    expect(extractThreadId({ threadId: 'top', thread: { id: 'nested' } })).toBe('top');
  });
});
