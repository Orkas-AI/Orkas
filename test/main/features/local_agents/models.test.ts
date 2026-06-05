import { describe, it, expect } from 'vitest';

import { defaultModel, listModels } from '../../../../src/main/features/local_agents/models';

describe('local_agents/models', () => {
  it('returns curated catalogs and defaults for first-party CLI types', () => {
    const claude = listModels('claude');
    const codex = listModels('codex');

    expect(claude.map(model => model.id)).toEqual(['claude-opus-4-8', 'claude-opus-4-7']);
    expect(codex.map(model => model.id)).toContain('gpt-5.5');
    expect(defaultModel('claude')).toBe('claude-opus-4-8');
    expect(defaultModel('codex')).toBe('gpt-5.5');
  });

  it('keeps dynamic or account-routed CLIs in free-text mode', () => {
    expect(listModels('openclaw')).toEqual([]);
    expect(listModels('opencode')).toEqual([]);
    expect(listModels('hermes')).toEqual([]);
    expect(defaultModel('openclaw')).toBeNull();
    expect(defaultModel('opencode')).toBeNull();
    expect(defaultModel('hermes')).toBeNull();
  });
});
