/**
 * Public, provider-neutral model catalog shared by Orkas and the open-source
 * build. Keep provider execution, authentication, routing, and managed Orkas
 * entries out of this file so it can be mirrored byte-for-byte.
 */

export interface ProviderModelEntry {
  id: string;
  name: string;
  /** Bundled model metadata to clone when this advertised id is newer than
   * the model runtime shipped by a client. The request still uses `id`. */
  template?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export const PUBLIC_PROVIDER_MODELS: Readonly<Record<string, readonly ProviderModelEntry[]>> = {
  anthropic: [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  ],
  'openai-codex': [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', template: 'gpt-5.5', contextWindow: 372000, maxTokens: 128000 },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', template: 'gpt-5.5', contextWindow: 372000, maxTokens: 128000 },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', template: 'gpt-5.5', contextWindow: 272000, maxTokens: 128000 },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
  ],
  openai: [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', template: 'gpt-5.5', contextWindow: 272000, maxTokens: 128000 },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', template: 'gpt-5.5', contextWindow: 272000, maxTokens: 128000 },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', template: 'gpt-5.5', contextWindow: 272000, maxTokens: 128000 },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
  ],
  google: [
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
  ],
  zai: [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'glm-5.1', name: 'GLM-5.1' },
  ],
  moonshot: [
    { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1048576, maxTokens: 131072 },
    { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
  ],
  'kimi-coding': [
    { id: 'k3', name: 'Kimi K3', template: 'kimi-for-coding', contextWindow: 1048576, maxTokens: 131072 },
    { id: 'k2p7', name: 'Kimi K2.7 Code' },
  ],
  'minimax-cn': [
    { id: 'MiniMax-M3', name: 'MiniMax 3' },
    { id: 'MiniMax-M2.7', name: 'MiniMax 2.7' },
  ],
  'minimax-portal': [
    { id: 'MiniMax-M3', name: 'MiniMax 3' },
    { id: 'MiniMax-M2.7', name: 'MiniMax 2.7' },
  ],
  'minimax-portal-cn': [
    { id: 'MiniMax-M3', name: 'MiniMax 3' },
    { id: 'MiniMax-M2.7', name: 'MiniMax 2.7' },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  ],
  doubao: [
    { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao Seed 2.0 Pro' },
    { id: 'doubao-seed-2-0-lite-260428', name: 'Doubao Seed 2.0 Lite' },
  ],
  openrouter: [
    { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8' },
    { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7' },
    { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', template: 'openai/gpt-5.5' },
    { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra', template: 'openai/gpt-5.5' },
    { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', template: 'openai/gpt-5.5' },
    { id: 'openai/gpt-5.5', name: 'GPT-5.5' },
    { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)' },
    { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'moonshotai/kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'qwen/qwen3.7-max', name: 'Qwen3.7 Max' },
    { id: 'qwen/qwen3-coder-next', name: 'Qwen3 Coder Next' },
    { id: 'z-ai/glm-5.2', name: 'GLM-5.2' },
    { id: 'z-ai/glm-5.1', name: 'GLM-5.1' },
    { id: 'minimax/minimax-m3', name: 'MiniMax 3' },
    { id: 'minimax/minimax-m2.7', name: 'MiniMax 2.7' },
    { id: 'xiaomi/mimo-v2.5-pro', name: 'Xiaomi MiMo V2.5 Pro' },
    { id: 'xiaomi/mimo-v2.5', name: 'Xiaomi MiMo V2.5' },
  ],
};
