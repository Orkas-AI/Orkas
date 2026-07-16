import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateSpeech } from '../../../src/main/features/tts';
import {
  listTtsCapabilities,
  normalizeTtsLanguage,
  publicTtsCapabilities,
  resolveTtsSelection,
  ttsVoiceLanguageIsVerified,
  ttsVoiceSupportsLanguage,
} from '../../../src/main/features/tts_capabilities';

const envKeys = [
  'ORKAS_TTS_BASE_URL',
  'ORKAS_TTS_API_KEY',
  'ORKAS_TTS_MODEL',
  'ORKAS_TTS_VOICE',
  'ORKAS_TTS_FORMAT',
] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of envKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('TTS runtime capabilities', () => {
  it('normalizes language tags and keeps candidate non-native locales out of production', () => {
    const candidate = {
      nativeLocale: 'zh-CN',
      supportedLocales: ['zh-CN', 'en-US'],
      languageConfidence: 'candidate' as const,
    };
    expect(normalizeTtsLanguage('cn')).toBe('zh-CN');
    expect(normalizeTtsLanguage('en_us')).toBe('en-US');
    expect(ttsVoiceSupportsLanguage(candidate, 'en-GB')).toBe(true);
    expect(ttsVoiceLanguageIsVerified(candidate, 'zh-CN')).toBe(true);
    expect(ttsVoiceLanguageIsVerified(candidate, 'en-US')).toBe(false);
  });

  it('publishes only a stable voice_ref and keeps the provider voice id host-side', async () => {
    process.env.ORKAS_TTS_BASE_URL = 'https://example.invalid/v1';
    process.env.ORKAS_TTS_API_KEY = 'secret';
    process.env.ORKAS_TTS_MODEL = 'tts-model';
    process.env.ORKAS_TTS_VOICE = 'configured-voice';

    const routes = await listTtsCapabilities();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      routeRef: 'env:tts',
      catalogStatus: 'configured-only',
      voices: [expect.objectContaining({
        providerVoiceId: 'configured-voice',
        nativeLocale: 'und',
        supportedLocales: ['und'],
        languageConfidence: 'verified',
      })],
    });
    const publicRoutes = publicTtsCapabilities(routes);
    expect(publicRoutes[0].voices[0]).not.toHaveProperty('providerVoiceId');
    expect(publicRoutes[0].voices[0].voiceRef).toMatch(/^env:tts:voice:/);
  });

  it('rejects an arbitrary legacy voice before a provider request', async () => {
    process.env.ORKAS_TTS_BASE_URL = 'https://example.invalid/v1';
    process.env.ORKAS_TTS_API_KEY = 'secret';
    process.env.ORKAS_TTS_MODEL = 'tts-model';
    process.env.ORKAS_TTS_VOICE = 'configured-voice';

    await expect(resolveTtsSelection({ legacyVoice: 'zh-CN-YunxiNeural' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_TTS_VOICE_UNRESOLVED',
    });
  });

  it('does not send HTTP or mark a charge when generateSpeech receives an unresolved voice', async () => {
    process.env.ORKAS_TTS_BASE_URL = 'https://example.invalid/v1';
    process.env.ORKAS_TTS_API_KEY = 'secret';
    process.env.ORKAS_TTS_MODEL = 'tts-model';
    process.env.ORKAS_TTS_VOICE = 'configured-voice';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await generateSpeech({
      text: 'hello',
      outputAbsPath: '/tmp/should-not-exist.mp3',
      voice: 'zh-CN-YunxiNeural',
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'E_TTS_VOICE_UNRESOLVED',
      requestDisposition: 'rejected_preflight',
      chargeStatus: 'not_charged',
      retryPolicy: 'safe_after_plan_fix',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the exact signed route and voice pair', async () => {
    process.env.ORKAS_TTS_BASE_URL = 'https://example.invalid/v1';
    process.env.ORKAS_TTS_API_KEY = 'secret';
    process.env.ORKAS_TTS_MODEL = 'tts-model';
    process.env.ORKAS_TTS_VOICE = 'configured-voice';

    const [route] = await listTtsCapabilities();
    const result = await resolveTtsSelection({
      routeRef: route.routeRef,
      voiceRef: route.defaultVoiceRef,
    });
    expect(result).toMatchObject({
      ok: true,
      selection: {
        routeRef: 'env:tts',
        providerVoiceId: 'configured-voice',
        language: 'und',
      },
    });
  });

  it('rejects a signed language that the configured voice does not support', async () => {
    process.env.ORKAS_TTS_BASE_URL = 'https://example.invalid/v1';
    process.env.ORKAS_TTS_API_KEY = 'secret';
    process.env.ORKAS_TTS_MODEL = 'tts-model';
    process.env.ORKAS_TTS_VOICE = 'configured-voice';

    const [route] = await listTtsCapabilities();
    await expect(resolveTtsSelection({
      routeRef: route.routeRef,
      voiceRef: route.defaultVoiceRef,
      language: 'zh-CN',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_TTS_LANGUAGE_UNSUPPORTED',
    });
  });
});
