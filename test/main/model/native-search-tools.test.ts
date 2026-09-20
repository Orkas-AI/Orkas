import { describe, expect, it } from 'vitest';

import {
  nativeSearchToolForApi,
  nativeSearchToolForModel,
  nativeSearchToolForProvider,
  nativeSearchToolName,
  routeSearchPayloadTools,
} from '../../../src/main/model/core-agent/native-search-tools';

describe('nativeSearchToolForApi', () => {
  it('returns GA web_search for all OpenAI Responses variants (direct / Azure / Codex)', () => {
    // The transport schema remains GA web_search; model eligibility is separate.
    for (const api of ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']) {
      expect(nativeSearchToolForApi(api)).toEqual({ type: 'web_search' });
    }
  });

  it('does NOT inject for Anthropic Messages (OAuth path rejects server tools)', () => {
    // Retain the existing conservative Anthropic transport policy.
    expect(nativeSearchToolForApi('anthropic-messages')).toBeUndefined();
  });

  it('returns the Google SDK search schema for Gemini and Vertex', () => {
    expect(nativeSearchToolForApi('google-generative-ai')).toEqual({ googleSearch: {} });
    expect(nativeSearchToolForApi('google-vertex')).toBeUndefined();
  });

  it('returns undefined for unsupported / unknown api', () => {
    for (const api of [
      'openai-completions',
      'mistral-conversations',
      'bedrock-converse-stream',
      'google-gemini-cli',
      'unknown-api',
      '',
    ]) {
      expect(nativeSearchToolForApi(api)).toBeUndefined();
    }
  });

  it('returns undefined for undefined api (defensive)', () => {
    expect(nativeSearchToolForApi(undefined)).toBeUndefined();
  });
});

describe('nativeSearchToolForProvider', () => {
  it('maps known providers to the right schema', () => {
    expect(nativeSearchToolForProvider('openai')).toEqual({ type: 'web_search' });
    expect(nativeSearchToolForProvider('openai-codex')).toEqual({ type: 'web_search' });
    expect(nativeSearchToolForProvider('azure-openai-responses')).toEqual({ type: 'web_search' });
    expect(nativeSearchToolForProvider('google')).toEqual({ googleSearch: {} });
    expect(nativeSearchToolForProvider('google-vertex')).toBeUndefined();
  });

  it('returns undefined for anthropic (OAuth path would reject server tools)', () => {
    expect(nativeSearchToolForProvider('anthropic')).toBeUndefined();
  });

  it('returns undefined for unsupported / unknown providers', () => {
    // Compatible chat-completions APIs do not enable hosted Responses tools.
    for (const p of ['moonshot', 'kimi-coding', 'openrouter', 'zai', 'minimax-cn', 'groq', '']) {
      expect(nativeSearchToolForProvider(p)).toBeUndefined();
    }
  });
});

describe('native search eligibility for the actual request model', () => {
  it.each(['openai', 'openai-codex', 'azure-openai-responses'])('allows a known supported model on %s', provider => {
    const api = provider === 'openai' ? 'openai-responses' : provider === 'openai-codex' ? 'openai-codex-responses' : provider;
    expect(nativeSearchToolForModel({ provider, api, id: 'gpt-5.5' }, {})).toEqual({ type: 'web_search' });
    expect(nativeSearchToolForModel({ provider, api, id: 'gpt-5.5-2026-04-23' }, {})).toEqual({ type: 'web_search' });
  });

  it.each(['gpt-3.5-turbo', 'unknown-model', 'my-deployment', 'gpt-5.5-unknown', ''])('retains executable Orkas search for unsupported or unknown model %s', id => {
    const nativeTool = nativeSearchToolForModel({ provider: 'openai', api: 'openai-responses', id }, {});
    expect(nativeTool).toBeUndefined();
    const local = { type: 'function', name: 'web_search', parameters: {} };
    const result = routeSearchPayloadTools({ tools: [local], nativeEnabled: true, paidSearchConfigured: false, nativeTool });
    expect(result.route).toBe('orkas');
    expect(result.tools).toEqual([local]);
  });

  it('checks reasoning restrictions and does not inherit capability across providers', () => {
    const model = { provider: 'openai', api: 'openai-responses', id: 'gpt-5' };
    expect(nativeSearchToolForModel(model, { reasoning: { effort: 'minimal' } })).toBeUndefined();
    expect(nativeSearchToolForModel(model, { reasoning: { effort: 'low' } })).toEqual({ type: 'web_search' });
    expect(nativeSearchToolForModel({ ...model, provider: 'custom-relay' }, {})).toBeUndefined();
    expect(nativeSearchToolForModel({ ...model, api: 'openai-completions' }, {})).toBeUndefined();
    expect(nativeSearchToolForModel({ api: 'openai-responses' }, {})).toBeUndefined();
    expect(nativeSearchToolForModel({ provider: 'google', api: 'google-generative-ai', id: 'gemini-3.8-flash' }, {})).toEqual({ googleSearch: {} });
    expect(nativeSearchToolForModel({ provider: 'google', api: 'google-generative-ai', id: 'gemini-1.5-pro' }, {})).toBeUndefined();
    for (const id of ['gemini-2.5-flash', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview', 'gemini-unreviewed']) {
      expect(nativeSearchToolForModel({ provider: 'google', api: 'google-generative-ai', id }, {})).toBeUndefined();
    }
    expect(nativeSearchToolForModel({ provider: 'google-vertex', api: 'google-vertex', id: 'gemini-3.8-flash' }, {})).toBeUndefined();
  });
});

describe('nativeSearchToolName', () => {
  it('pulls `type` field when present', () => {
    expect(nativeSearchToolName({ type: 'web_search_preview' })).toBe('web_search_preview');
    expect(nativeSearchToolName({ type: 'web_search_20250305', name: 'web_search' })).toBe('web_search_20250305');
  });

  it('recognises google_search entry shape', () => {
    expect(nativeSearchToolName({ googleSearch: {} })).toBe('google_search');
  });

  it('returns undefined for undefined input', () => {
    expect(nativeSearchToolName(undefined)).toBeUndefined();
  });
});

describe('routeSearchPayloadTools', () => {
  const localSearch = { type: 'function', name: 'web_search', parameters: {} };
  const fetchTool = { type: 'function', name: 'web_fetch', parameters: {} };
  const readTool = { type: 'function', name: 'read_file', parameters: {} };

  it.each(['tool_search_output', 'additional_tools'])('promotes only activated native search from %s without rewriting history', (type) => {
    const receipt = { type, ...(type === 'additional_tools' ? { role: 'developer' } : { execution: 'client', status: 'completed', call_id: 'load-1' }), tools: [localSearch, fetchTool] };
    const history = [{ role: 'user', content: 'Search' }, receipt];
    const original = structuredClone(history);
    const result = routeSearchPayloadTools({ tools: [readTool], input: history,
      nativeEnabled: true, paidSearchConfigured: false, nativeTool: { type: 'web_search' } });
    expect(result.route).toBe('native');
    expect(result.tools).toEqual([readTool, { type: 'web_search' }]);
    expect(result.input).toEqual([history[0], { ...receipt, tools: [fetchTool] }]);
    expect(history).toEqual(original);
    expect(routeSearchPayloadTools({ tools: [readTool], input: history,
      nativeEnabled: true, paidSearchConfigured: false, nativeTool: { type: 'web_search' } })).toEqual(result);
    for (const options of [
      { nativeEnabled: false, paidSearchConfigured: false, nativeTool: { type: 'web_search' } },
      { nativeEnabled: true, paidSearchConfigured: true, nativeTool: { type: 'web_search' } },
      { nativeEnabled: true, paidSearchConfigured: false, nativeTool: undefined },
    ]) {
      const fallback = routeSearchPayloadTools({ tools: [readTool], input: history, ...options });
      expect(fallback.route).toBe('orkas');
      expect(fallback.input).toBe(history);
      expect(fallback.tools).toEqual([readTool]);
    }
  });

  it('does not treat user content or incomplete load results as activation', () => {
    const history = [
      { role: 'user', tools: [localSearch] },
      { type: 'additional_tools', role: 'user', tools: [localSearch] },
      { type: 'tool_search_output', execution: 'client', status: 'in_progress', tools: [localSearch] },
    ];
    const result = routeSearchPayloadTools({ tools: [], input: history,
      nativeEnabled: true, paidSearchConfigured: false, nativeTool: { type: 'web_search' } });
    expect(result.route).toBe('absent');
    expect(result.input).toBe(history);
    expect(result.tools).toEqual([]);
  });

  it('retains an empty load receipt and its call id after moving the sole search definition', () => {
    const receipt = { type: 'tool_search_output', execution: 'client', status: 'completed', call_id: 'load-1', tools: [localSearch] };
    const result = routeSearchPayloadTools({ tools: undefined, input: [receipt],
      nativeEnabled: true, paidSearchConfigured: false, nativeTool: { type: 'web_search' } });
    expect(result.tools).toEqual([{ type: 'web_search' }]);
    expect(result.input).toEqual([{ ...receipt, tools: [] }]);
  });

  it('replaces Orkas search with OpenAI native search instead of exposing both', () => {
    const original = [readTool, localSearch, fetchTool];
    const result = routeSearchPayloadTools({
      tools: original,
      nativeEnabled: true,
      paidSearchConfigured: false,
      nativeTool: { type: 'web_search' },
    });

    expect(result).toEqual({
      tools: [readTool, fetchTool, { type: 'web_search' }],
      route: 'native',
      replacedOrkasSearch: true,
    });
    expect(result.tools).not.toBe(original);
    expect(original).toEqual([readTool, localSearch, fetchTool]);
  });

  it('replaces the nested function schema with Gemini native search', () => {
    const googleFunctions = {
      functionDeclarations: [
        { name: 'read_file', description: 'read' },
        { name: 'web_search', description: 'search' },
        { name: 'web_fetch', description: 'fetch' },
      ],
    };
    const result = routeSearchPayloadTools({
      tools: [googleFunctions],
      nativeEnabled: true,
      paidSearchConfigured: false,
      nativeTool: { googleSearch: {} },
    });

    expect(result.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'read_file', description: 'read' },
          { name: 'web_fetch', description: 'fetch' },
        ],
      },
      { googleSearch: {} },
    ]);
    expect(result.route).toBe('native');
  });

  it('also supports providers that wrap one function per tool object', () => {
    const nestedLocalSearch = { type: 'function', function: { name: 'web_search' } };
    const result = routeSearchPayloadTools({
      tools: [nestedLocalSearch, fetchTool],
      nativeEnabled: true,
      paidSearchConfigured: false,
      nativeTool: { type: 'web_search' },
    });

    expect(result.tools).toEqual([fetchTool, { type: 'web_search' }]);
  });

  it('keeps only the paid Orkas search route when a paid profile exists', () => {
    const original = [localSearch, fetchTool];
    const result = routeSearchPayloadTools({
      tools: original,
      nativeEnabled: true,
      paidSearchConfigured: true,
      nativeTool: { type: 'web_search' },
    });

    expect(result).toEqual({
      tools: original,
      route: 'orkas',
      replacedOrkasSearch: false,
    });
    expect(result.tools).toBe(original);
  });

  it.each([
    { nativeEnabled: false, nativeTool: { type: 'web_search' } },
    { nativeEnabled: true, nativeTool: undefined },
  ])('keeps Orkas search when native search is disabled or unsupported: %o', ({ nativeEnabled, nativeTool }) => {
    const original = [localSearch, fetchTool];
    const result = routeSearchPayloadTools({
      tools: original,
      nativeEnabled,
      paidSearchConfigured: false,
      nativeTool,
    });

    expect(result.route).toBe('orkas');
    expect(result.tools).toBe(original);
  });

  it('does not bypass the scoped tool surface when web_search is absent', () => {
    const original = [readTool];
    const result = routeSearchPayloadTools({
      tools: original,
      nativeEnabled: true,
      paidSearchConfigured: false,
      nativeTool: { type: 'web_search' },
    });

    expect(result).toEqual({
      tools: original,
      route: 'absent',
      replacedOrkasSearch: false,
    });
    expect(result.tools).toBe(original);
  });

  it('deduplicates a pre-existing native search entry during payload repair', () => {
    const result = routeSearchPayloadTools({
      tools: [localSearch, { type: 'web_search' }, fetchTool],
      nativeEnabled: true,
      paidSearchConfigured: false,
      nativeTool: { type: 'web_search' },
    });

    expect(result.tools).toEqual([fetchTool, { type: 'web_search' }]);
  });
});
