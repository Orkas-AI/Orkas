import { describe, expect, it } from 'vitest';

import {
  nativeSearchToolForApi,
  nativeSearchToolForProvider,
  nativeSearchToolName,
} from '../../../src/main/model/core-agent/native-search-tools';

describe('nativeSearchToolForApi', () => {
  it('returns GA web_search for all OpenAI Responses variants (direct / Azure / Codex)', () => {
    // 2026-04 起统一用 GA 版 `web_search`（不再用旧的 `web_search_preview`）。
    // Codex 后端拒 preview，直连账户两个都能通；GA 是正式版，优先用。
    for (const api of ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']) {
      expect(nativeSearchToolForApi(api)).toEqual({ type: 'web_search' });
    }
  });

  it('does NOT inject for Anthropic Messages (OAuth path rejects server tools)', () => {
    // 官方 docs 有 `web_search_20250305`，但 Orkas 的 `anthropic` provider 多数
    // 用户走 OAuth（Claude Pro/Max），后端按 `claude-code-20250219` beta header
    // 限权，server tool 会被拒→对话整挂。保守剔出，走内置 web_search 兜底。
    expect(nativeSearchToolForApi('anthropic-messages')).toBeUndefined();
  });

  it('returns google_search for Gemini and Vertex', () => {
    expect(nativeSearchToolForApi('google-generative-ai')).toEqual({ google_search: {} });
    expect(nativeSearchToolForApi('google-vertex')).toEqual({ google_search: {} });
  });

  it('returns undefined for unsupported / unknown api', () => {
    for (const api of [
      'openai-completions',    // Moonshot / OpenRouter 走这个
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
    expect(nativeSearchToolForProvider('google')).toEqual({ google_search: {} });
    expect(nativeSearchToolForProvider('google-vertex')).toEqual({ google_search: {} });
  });

  it('returns undefined for anthropic (OAuth path would reject server tools)', () => {
    expect(nativeSearchToolForProvider('anthropic')).toBeUndefined();
  });

  it('returns undefined for unsupported / unknown providers', () => {
    // OpenRouter 绑 `openai-completions` api（Chat Completions 协议），Chat
    // Completions 里没有 server-side web search tool 可注入，本函数自然返回 undefined。
    for (const p of ['moonshot', 'kimi-coding', 'openrouter', 'zai', 'minimax-cn', 'groq', '']) {
      expect(nativeSearchToolForProvider(p)).toBeUndefined();
    }
  });
});

describe('nativeSearchToolName', () => {
  it('pulls `type` field when present', () => {
    expect(nativeSearchToolName({ type: 'web_search_preview' })).toBe('web_search_preview');
    expect(nativeSearchToolName({ type: 'web_search_20250305', name: 'web_search' })).toBe('web_search_20250305');
  });

  it('recognises google_search entry shape', () => {
    expect(nativeSearchToolName({ google_search: {} })).toBe('google_search');
  });

  it('returns undefined for undefined input', () => {
    expect(nativeSearchToolName(undefined)).toBeUndefined();
  });
});
