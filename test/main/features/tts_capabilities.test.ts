import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateSpeech } from '../../../src/main/features/tts';
import {
  listableTtsVoices,
  listTtsCapabilities,
  normalizeTtsLanguage,
  publicTtsCapabilities,
  resolveTtsSelection,
  TTS_VOICE_LISTING_LIMIT,
  ttsVoiceLanguageIsVerified,
  ttsVoiceSupportsLanguage,
  type PublicTtsVoiceCapability,
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
        // Nothing named this voice's language, so it is a candidate for any of
        // them and not verified for one. `verified` beside `und` was the claim
        // a 2026-08-10 run acted on when it abandoned narration entirely.
        languageConfidence: 'candidate',
        languageDeclared: false,
      })],
    });
    const publicRoutes = publicTtsCapabilities(routes);
    expect(publicRoutes[0].voices[0]).not.toHaveProperty('providerVoiceId');
    expect(publicRoutes[0].voices[0].voiceRef).toMatch(/^env:tts:voice:/);
  });

  it('keeps a configured voice whose id names its locale verified', async () => {
    // The host's only signal about a bring-your-own voice is the id itself.
    // When it carries one, the claim is real and must not be weakened by the
    // undeclared allowance.
    process.env.ORKAS_TTS_BASE_URL = 'https://example.invalid/v1';
    process.env.ORKAS_TTS_API_KEY = 'secret';
    process.env.ORKAS_TTS_MODEL = 'tts-model';
    process.env.ORKAS_TTS_VOICE = 'zh_configured-voice';

    const routes = await listTtsCapabilities();
    expect(routes[0].voices[0]).toMatchObject({
      nativeLocale: 'zh-CN',
      languageConfidence: 'verified',
      languageDeclared: true,
    });
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

// A narrator choosing a voice reads this listing. The managed catalog is ~100
// voices, of which one deliverable can use exactly one; the incident that
// prompted the projection was every speech.capabilities call spilling out of
// the model's inline budget, so the catalog reached it as a searchable stub.
describe('Agent-facing voice listing', () => {
  const catalogVoice = (index: number, over: Partial<PublicTtsVoiceCapability> = {}) => ({
    voiceRef: `managed:orkas-voice:voice:v${index}`,
    displayName: `Voice ${index}`,
    locale: 'zh-CN',
    nativeLocale: 'zh-CN',
    supportedLocales: ['zh-CN'],
    mixedLanguageSupport: false,
    languageConfidence: 'verified' as const,
    styleTags: [],
    useCases: ['general'],
    isDefault: false,
    ...over,
  });

  /** Mirrors the shipped managed catalog: a large `general` majority, a long
   *  `role-play` tail, and a handful of voices carrying the use cases a promo
   *  narration actually wants. */
  const managedCatalog = (): PublicTtsVoiceCapability[] => [
    catalogVoice(0, { displayName: 'Vivi', isDefault: true, supportedLocales: ['zh-CN', 'en'], mixedLanguageSupport: true }),
    ...Array.from({ length: 52 }, (_unused, i) => catalogVoice(i + 1)),
    ...Array.from({ length: 27 }, (_unused, i) => catalogVoice(i + 60, { useCases: ['role-play'] })),
    ...Array.from({ length: 9 }, (_unused, i) => catalogVoice(i + 90, { useCases: ['dubbing'] })),
    catalogVoice(200, { useCases: ['narration'], styleTags: ['cinematic'] }),
    catalogVoice(201, { useCases: ['advertising'], styleTags: ['commercial'] }),
    catalogVoice(202, {
      displayName: 'Dacey',
      locale: 'en-US',
      nativeLocale: 'en-US',
      supportedLocales: ['en-US'],
      useCases: ['narration'],
    }),
    catalogVoice(203, {
      displayName: 'Aspirational English',
      supportedLocales: ['zh-CN', 'en-US'],
      languageConfidence: 'candidate',
      mixedLanguageSupport: true,
    }),
  ];

  it('keeps a rare narration voice reachable instead of returning the head of the catalog', () => {
    const listing = listableTtsVoices(managedCatalog(), { language: 'zh-CN' });

    // Only the en-US voice cannot narrate Chinese.
    expect(listing.eligible).toBe(managedCatalog().length - 1);
    expect(listing.voices.length).toBeLessThanOrEqual(TTS_VOICE_LISTING_LIMIT);
    const refs = listing.voices.map((voice) => voice.voiceRef);
    // The two voices a promo narration would pick sit at catalog positions 89
    // and 90; a plain head-of-catalog cut drops both.
    expect(refs).toContain('managed:orkas-voice:voice:v200');
    expect(refs).toContain('managed:orkas-voice:voice:v201');
    expect(refs).toContain('managed:orkas-voice:voice:v0');
    expect(listing.voices.some((voice) => voice.useCases.includes('role-play'))).toBe(true);
    expect(listing.voices.some((voice) => voice.useCases.includes('dubbing'))).toBe(true);
  });

  it('leaves out voices that cannot narrate the deliverable language', () => {
    const zh = listableTtsVoices(managedCatalog(), { language: 'zh-CN', limit: Infinity });
    const en = listableTtsVoices(managedCatalog(), { language: 'en-US', limit: Infinity });

    // An en-US voice cannot read Chinese; a candidate non-native locale is not
    // production-safe, so the same voice is listable for its native zh-CN and
    // withheld from English, while a verified bilingual voice serves both.
    expect(zh.voices.map((voice) => voice.displayName)).not.toContain('Dacey');
    expect(zh.voices.map((voice) => voice.displayName)).toContain('Aspirational English');
    expect(en.voices.map((voice) => voice.displayName)).toEqual(['Vivi', 'Dacey']);
    expect(listableTtsVoices(managedCatalog(), { language: 'fr-FR' })).toEqual({
      voices: [],
      eligible: 0,
    });
  });

  // A configured-only route (an env-configured endpoint, or a provider voice
  // whose name carries no language hint) lands on `und`. Withholding it under a
  // language query turns "the host does not know" into "you have no voice" — an
  // account whose only route is configured-only would lose narration entirely
  // the moment the deliverable language is named.
  it('keeps a voice whose catalog declares no language at all', () => {
    const undeclared: PublicTtsVoiceCapability = {
      voiceRef: 'env:tts:voice:abc',
      displayName: 'alloy',
      locale: 'und',
      nativeLocale: 'und',
      supportedLocales: ['und'],
      mixedLanguageSupport: false,
      languageConfidence: 'verified',
      styleTags: [],
      useCases: [],
      isDefault: true,
    };
    expect(listableTtsVoices([undeclared], { language: 'zh-CN' }).voices).toHaveLength(1);
    expect(listableTtsVoices([undeclared], { language: 'fr-FR' }).voices).toHaveLength(1);
    // A catalog that does name a language is still held to it.
    const declared = { ...undeclared, nativeLocale: 'en-US', locale: 'en-US', supportedLocales: ['en-US'] };
    expect(listableTtsVoices([declared], { language: 'zh-CN' }).voices).toHaveLength(0);
  });

  it('returns a small catalog whole and the full eligible set on request', () => {
    const small = managedCatalog().slice(0, 4);
    expect(listableTtsVoices(small, { language: 'zh-CN' })).toMatchObject({
      voices: small,
      eligible: 4,
    });
    // The user named a voice the sample omits; the listing must still reach it.
    const everything = listableTtsVoices(managedCatalog(), { language: 'zh-CN', limit: Infinity });
    expect(everything.voices).toHaveLength(everything.eligible);
    expect(everything.voices.map((voice) => voice.voiceRef)).toContain('managed:orkas-voice:voice:v95');
  });
});

describe('bring-your-own voice with no declared language', () => {
  // 2026-08-10: a driven run pointed the container at an OpenAI-compatible
  // endpoint. speech.capabilities answered `available` and listed one voice as
  // locale "und", supported_locales ["und"], language_confidence "verified".
  // The model read that under a zh-CN request, concluded there was no evidence
  // the voice speaks Chinese, and stopped the whole production to ask the user
  // to configure a different one. Its reading was right: the host keeps such a
  // voice BECAUSE it cannot be ruled out, and published the opposite.
  const undeclared = (): PublicTtsVoiceCapability => ({
    voiceRef: 'env:tts:voice:abc',
    displayName: 'Tingting',
    locale: 'und',
    nativeLocale: 'und',
    supportedLocales: ['und'],
    mixedLanguageSupport: false,
    languageConfidence: 'candidate',
    languageDeclared: false,
    styleTags: [],
    useCases: [],
    isDefault: true,
  });

  it('stays listed for any language it cannot be ruled out for', () => {
    for (const language of ['zh-CN', 'en', 'ja']) {
      const listing = listableTtsVoices([undeclared()], { language });
      expect(listing.voices, language).toHaveLength(1);
      expect(listing.eligible, language).toBe(1);
    }
  });

  it('carries the fact that nothing declared its language', () => {
    const listing = listableTtsVoices([undeclared()], { language: 'zh-CN' });
    // `verified` beside `und` was the claim the model acted on. Undeclared is
    // a candidate, and languageDeclared separates it from a voice genuinely
    // catalogued as und.
    expect(listing.voices[0].languageConfidence).toBe('candidate');
    expect(listing.voices[0].languageDeclared).toBe(false);
  });

  it('does not weaken a voice whose locale IS declared', () => {
    const declared: PublicTtsVoiceCapability = {
      ...undeclared(),
      locale: 'zh-CN',
      nativeLocale: 'zh-CN',
      supportedLocales: ['zh-CN'],
      languageConfidence: 'verified',
      languageDeclared: true,
    };
    expect(listableTtsVoices([declared], { language: 'zh-CN' }).voices).toHaveLength(1);
    // A declared locale still excludes a language it does not cover — the
    // undeclared allowance must not become a blanket pass.
    expect(listableTtsVoices([declared], { language: 'ja' }).voices).toHaveLength(0);
  });
});
