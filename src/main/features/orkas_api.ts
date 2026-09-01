/** Public Orkas API identifiers used by the open-source BYO-key adapters. */

export const ORKAS_API_PROVIDER = 'orkas-api';
export const ORKAS_API_BASE_URL = 'https://orkas.ai/v1';
export const ORKAS_API_KEYS_URL = 'https://orkas.ai/views/account/account.html#api-keys';

export const ORKAS_API_DEFAULT_LLM_MODEL = 'orkas-llm-1.5';
export const ORKAS_API_LLM_MODELS = [
  {
    id: ORKAS_API_DEFAULT_LLM_MODEL,
    name: 'Orkas-1.5',
    recommended: true,
    includedModels: [
      'DeepSeek V4',
      'GPT-5.6 Luna',
      'Claude-Sonnet-5',
      'Gemini-3.6 Flash',
    ],
  },
  {
    id: 'orkas-llm-1.5-pro',
    name: 'Orkas-1.5 Pro',
    includedModels: ['GPT-5.6 Sol', 'Claude Opus 5', 'Kimi K3'],
  },
];

export const ORKAS_API_IMAGE_MODEL = 'orkas-image';
export const ORKAS_API_TTS_MODEL = 'orkas-tts-1';
export const ORKAS_API_VIDEO_MODEL = 'orkas-video';
export const ORKAS_API_DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts';

/**
 * Opaque billing context shared by Orkas public-API calls made during one
 * local conversation.  Deliberately exclude the conversation title (and all
 * other user content): the open-source client only sends stable ids needed to
 * group credit consumption into the same session.
 */
export interface OrkasApiUsageContext {
  conversationId?: string;
  turnId?: string;
}

const ORKAS_API_CONTEXT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function orkasApiUsageHeaders(
  context?: OrkasApiUsageContext,
): Record<string, string> {
  const conversationId = String(context?.conversationId || '').trim();
  const turnId = String(context?.turnId || '').trim();
  return {
    ...(ORKAS_API_CONTEXT_ID_RE.test(conversationId)
      ? { 'X-Orkas-Conversation-Id': conversationId }
      : {}),
    ...(ORKAS_API_CONTEXT_ID_RE.test(turnId)
      ? { 'X-Orkas-Turn-Id': turnId }
      : {}),
  };
}
