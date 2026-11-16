/** Native TTS request capabilities. Existing saved models are never upgraded in place.
 * Sources and protocol boundaries: docs/test/tts-generation-regression.md. */
export interface TtsModelPreset {
  id: string;
  name: string;
  defaultVoice?: string;
  formats: string[];
  speed?: [number, number];
  maxCharacters?: number;
}

export const DOUBAO_TTS_FORMATS: readonly string[] = ['mp3', 'wav', 'pcm', 'opus', 'ogg'];

export const TTS_MODELS: Readonly<Record<string, readonly TtsModelPreset[]>> = {
  minimax: [
    { id: 'speech-2.8-hd', name: 'MiniMax Speech 2.8 HD', defaultVoice: 'male-qn-qingse', formats: ['mp3', 'wav', 'pcm', 'flac', 'opus'], speed: [0.5, 2], maxCharacters: 9999 },
    { id: 'speech-2.8-turbo', name: 'MiniMax Speech 2.8 Turbo', defaultVoice: 'male-qn-qingse', formats: ['mp3', 'wav', 'pcm', 'flac', 'opus'], speed: [0.5, 2], maxCharacters: 9999 },
  ],
  aliyun: [
    { id: 'qwen-audio-3.1-tts-plus', name: 'Alibaba Qwen-Audio 3.1 TTS Plus', defaultVoice: 'longanhuan_v3.1', formats: ['mp3', 'wav', 'pcm', 'opus'], speed: [0.5, 2] },
    { id: 'qwen-audio-3.1-tts-flash', name: 'Alibaba Qwen-Audio 3.1 TTS Flash', defaultVoice: 'longanhuan_v3.1', formats: ['mp3', 'wav', 'pcm', 'opus'], speed: [0.5, 2] },
    // CosyVoice 3.5 is clone-only. Require the user's enrolled voice; no invented public default.
    { id: 'cosyvoice-v3.5-flash', name: 'Alibaba CosyVoice 3.5 Flash', formats: ['mp3', 'wav', 'pcm', 'opus'], speed: [0.5, 2], maxCharacters: 20000 },
    { id: 'cosyvoice-v3.5-plus', name: 'Alibaba CosyVoice 3.5 Plus', formats: ['mp3', 'wav', 'pcm', 'opus'], speed: [0.5, 2], maxCharacters: 20000 },
  ],
  google: [
    { id: 'gemini-3.8-flash-tts', name: 'Google Gemini 3.8 Flash TTS', defaultVoice: 'Kore', formats: ['wav', 'pcm', 'mp3', 'opus'] },
    { id: 'gemini-3.8-flash-lite-tts', name: 'Google Gemini 3.8 Flash-Lite TTS', defaultVoice: 'Kore', formats: ['wav', 'pcm', 'mp3', 'opus'] },
  ],
  elevenlabs: [
    { id: 'eleven_v4', name: 'ElevenLabs Eleven v4', formats: ['mp3', 'wav', 'pcm', 'opus'], maxCharacters: 10000 },
    { id: 'eleven_v4_turbo', name: 'ElevenLabs Eleven v4 Turbo', formats: ['mp3', 'wav', 'pcm', 'opus'], maxCharacters: 10000 },
  ],
  // Speech API models remain callable until 2027-01-06. Realtime models use a different protocol.
  openai: [
    { id: 'gpt-4o-mini-tts', name: 'OpenAI GPT-4o mini TTS', defaultVoice: 'alloy', formats: ['mp3', 'wav', 'pcm', 'opus', 'aac', 'flac'], speed: [0.25, 4], maxCharacters: 4096 },
  ],
};

export function ttsModelPreset(provider: string, model: string): TtsModelPreset | undefined {
  return Object.hasOwn(TTS_MODELS, provider) ? TTS_MODELS[provider].find(entry => entry.id === model) : undefined;
}

export function aliyunTtsBaseUrl(workspaceId: string): string | undefined {
  return /^[a-zA-Z0-9-]{1,100}$/.test(workspaceId)
    ? `https://${workspaceId}.cn-beijing.maas.aliyuncs.com` : undefined;
}
