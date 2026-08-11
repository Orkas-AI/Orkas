import * as crypto from 'node:crypto';

import type { TtsProfile } from './auth';
import { DEFAULT_TTS_FORMAT, listUsableTtsProfiles } from './tts_auth';
import { createLogger } from '../logger';

const log = createLogger('tts-capabilities');

export type TtsCatalogStatus = 'configured-only' | 'unavailable';
export type TtsLanguageConfidence = 'verified' | 'candidate';
export type TtsAvailabilityReason =
  | 'available'
  | 'user_disabled'
  | 'service_disabled'
  | 'sign_in_required'
  | 'not_configured';

export type TtsAvailabilityDetails = {
  available: boolean;
  reason: TtsAvailabilityReason;
  errorCode?: string;
  message?: string;
  nextAction?: string;
};

export type TtsVoiceCapability = {
  voiceRef: string;
  displayName: string;
  locale: string;
  nativeLocale: string;
  supportedLocales: string[];
  mixedLanguageSupport: boolean;
  languageConfidence: TtsLanguageConfidence;
  /** False when nothing named this voice's language — a configured-only route
   *  whose id carries no locale hint. Absent means declared (catalog routes).
   *  Distinguishes "we know it speaks und" from "nobody said". */
  languageDeclared?: boolean;
  accent?: string;
  gender?: string;
  styleTags: string[];
  useCases: string[];
  isDefault: boolean;
  providerVoiceId: string;
};

export type TtsRouteCapability = {
  routeRef: string;
  provider: string;
  model: string;
  displayName: string;
  catalogStatus: TtsCatalogStatus;
  defaultVoiceRef?: string;
  voices: TtsVoiceCapability[];
  supports: { speed: boolean; formats: string[]; languageContract: boolean };
};

export type PublicTtsVoiceCapability = Omit<TtsVoiceCapability, 'providerVoiceId'>;
export type PublicTtsRouteCapability = Omit<TtsRouteCapability, 'voices'> & {
  voices: PublicTtsVoiceCapability[];
};

export type ResolvedTtsSelection = {
  routeRef: string;
  voiceRef: string;
  providerVoiceId: string;
  displayName: string;
  provider: string;
  model: string;
  catalogStatus: TtsCatalogStatus;
  language: string;
};

export type TtsSelectionResult =
  | { ok: true; selection: ResolvedTtsSelection }
  | { ok: false; errorCode: string; message: string };

/**
 * Explain why no locally configured speech route can be used without probing
 * an upstream voice catalog. Orkas has no managed speech provider, so the
 * only recovery is to configure a BYO endpoint or profile.
 */
export function getTtsAvailabilityDetails(knownUsable?: boolean): TtsAvailabilityDetails {
  if (knownUsable === true) return { available: true, reason: 'available' };
  if (knownUsable !== false) {
    if (process.env.ORKAS_TTS_BASE_URL
      && process.env.ORKAS_TTS_API_KEY
      && process.env.ORKAS_TTS_MODEL) {
      return { available: true, reason: 'available' };
    }
    try {
      if (listUsableTtsProfiles().length > 0) {
        return { available: true, reason: 'available' };
      }
    } catch (err) {
      log.warn(`resolve TTS availability: ${(err as Error).message}`);
    }
  }
  return {
    available: false,
    reason: 'not_configured',
    errorCode: 'E_TTS_NOT_CONFIGURED',
    message: 'No text-to-speech service is configured. Open Settings > Credentials and add a text-to-speech service before using narration.',
    nextAction: 'ask_user_to_configure_a_speech_provider',
  };
}
function voiceRef(routeRef: string, providerVoiceId: string): string {
  const digest = crypto.createHash('sha256')
    .update(`${routeRef}\0${providerVoiceId}`)
    .digest('hex')
    .slice(0, 20);
  return `${routeRef}:voice:${digest}`;
}

export function normalizeTtsLanguage(value: unknown): string {
  const raw = String(value || '').trim().replaceAll('_', '-');
  if (!raw) return '';
  const aliases: Record<string, string> = {
    cn: 'zh-CN',
    zh: 'zh-CN',
    'zh-cn': 'zh-CN',
    en: 'en',
    'en-us': 'en-US',
    'en-gb': 'en-GB',
  };
  const alias = aliases[raw.toLowerCase()];
  if (alias) return alias;
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(raw)) return '';
  return raw.split('-').map((part, index) => (
    index === 0 ? part.toLowerCase() : part.length === 2 ? part.toUpperCase() : part
  )).join('-');
}

export function ttsVoiceSupportsLanguage(
  voice: Pick<TtsVoiceCapability, 'supportedLocales'>,
  language: string,
): boolean {
  const normalized = normalizeTtsLanguage(language);
  if (!normalized) return false;
  const base = normalized.split('-', 1)[0];
  return voice.supportedLocales.some((item) => {
    const supported = normalizeTtsLanguage(item);
    return !!supported && (supported === normalized || supported.split('-', 1)[0] === base);
  });
}

/** Whether the catalog says anything about this voice's language at all.
 *  `und` is what a configured-only route yields when nothing named a locale. */
export function ttsVoiceCatalogDeclaresLanguage(
  voice: Pick<TtsVoiceCapability, 'nativeLocale' | 'supportedLocales'>,
): boolean {
  const declared = [voice.nativeLocale, ...(voice.supportedLocales || [])]
    .map((item) => normalizeTtsLanguage(item))
    .filter((item) => !!item && item !== 'und');
  return declared.length > 0;
}

export function ttsVoiceLanguageIsVerified(
  voice: Pick<TtsVoiceCapability, 'nativeLocale' | 'languageConfidence'>,
  language: string,
): boolean {
  const normalized = normalizeTtsLanguage(language);
  const native = normalizeTtsLanguage(voice.nativeLocale);
  if (!normalized || !native) return false;
  return normalized.split('-', 1)[0] === native.split('-', 1)[0]
    || voice.languageConfidence === 'verified';
}

function configuredVoice(routeRef: string, providerVoiceId: string): TtsVoiceCapability {
  const nativeLocale = normalizeTtsLanguage(
    providerVoiceId.startsWith('zh_') ? 'zh-CN' : providerVoiceId.startsWith('en_') ? 'en' : 'und',
  ) || 'und';
  return {
    voiceRef: voiceRef(routeRef, providerVoiceId),
    displayName: providerVoiceId,
    locale: nativeLocale,
    nativeLocale,
    supportedLocales: [nativeLocale],
    mixedLanguageSupport: false,
    // A bring-your-own endpoint exposes no voice catalog, so unless the voice
    // id itself names a locale the host knows nothing about what it speaks.
    // Publishing `verified` next to `und` claimed the opposite of what the
    // host meant: it keeps such a voice in a language-filtered listing because
    // it CANNOT be ruled out, and a model reading `supported_locales:["und"]`
    // under `language_confidence:"verified"` reasonably concluded there was no
    // evidence of Chinese and abandoned the whole production (2026-08-10).
    // Undeclared is a candidate, and `language_declared` says which case this
    // is so the two are not read as one.
    languageConfidence: nativeLocale === 'und' ? 'candidate' : 'verified',
    languageDeclared: nativeLocale !== 'und',
    styleTags: [],
    useCases: [],
    isDefault: true,
    providerVoiceId,
  };
}

function profileRoute(profile: TtsProfile): TtsRouteCapability {
  const configured = String(profile.voice || '').trim();
  const voices = configured ? [configuredVoice(profile.id, configured)] : [];
  return {
    routeRef: profile.id,
    provider: profile.provider || 'custom',
    model: profile.model || '',
    displayName: profile.label || profile.provider || 'custom',
    catalogStatus: voices.length ? 'configured-only' : 'unavailable',
    ...(voices[0] ? { defaultVoiceRef: voices[0].voiceRef } : {}),
    voices,
    supports: {
      speed: true,
      formats: [profile.format || DEFAULT_TTS_FORMAT],
      languageContract: false,
    },
  };
}

export async function listTtsCapabilities(_signal?: AbortSignal): Promise<TtsRouteCapability[]> {
  const envBase = process.env.ORKAS_TTS_BASE_URL;
  const envKey = process.env.ORKAS_TTS_API_KEY;
  const envModel = process.env.ORKAS_TTS_MODEL;
  if (envBase && envKey && envModel) {
    const routeRef = 'env:tts';
    const configured = String(process.env.ORKAS_TTS_VOICE || '').trim();
    const voices = configured ? [configuredVoice(routeRef, configured)] : [];
    return [{
      routeRef,
      provider: 'openai-compatible',
      model: envModel,
      displayName: 'Environment TTS',
      catalogStatus: voices.length ? 'configured-only' : 'unavailable',
      ...(voices[0] ? { defaultVoiceRef: voices[0].voiceRef } : {}),
      voices,
      supports: {
        speed: true,
        formats: [process.env.ORKAS_TTS_FORMAT || DEFAULT_TTS_FORMAT],
        languageContract: false,
      },
    }];
  }

  let profiles: TtsProfile[] = [];
  try { profiles = listUsableTtsProfiles(); }
  catch (err) { log.warn(`listTtsProfiles: ${(err as Error).message}`); }
  return profiles.map(profileRoute);
}

export function publicTtsCapabilities(routes: TtsRouteCapability[]): PublicTtsRouteCapability[] {
  return routes.map((route) => ({
    routeRef: route.routeRef,
    provider: route.provider,
    model: route.model,
    displayName: route.displayName,
    catalogStatus: route.catalogStatus,
    ...(route.defaultVoiceRef ? { defaultVoiceRef: route.defaultVoiceRef } : {}),
    voices: route.voices.map(({ providerVoiceId: _providerVoiceId, ...voice }) => voice),
    supports: route.supports,
  }));
}

/** Voices per route in an Agent-facing listing. The managed catalog carries
 *  ~100 voices, which costs more than a whole tool-result inline budget and
 *  buys nothing: a deliverable narrates in one language with one intent. */
export const TTS_VOICE_LISTING_LIMIT = 20;

/** The language-eligible voices worth listing, and how many were eligible.
 *  Sampling covers every use case the eligible set advertises before repeating
 *  one, so a rare fit (narration, advertising) is not hidden behind fifty
 *  general voices. Pass an infinite limit for the whole eligible catalog. */
export function listableTtsVoices(
  voices: PublicTtsVoiceCapability[],
  opts: { language?: string; limit?: number } = {},
): { voices: PublicTtsVoiceCapability[]; eligible: number } {
  const language = (opts.language || '').trim();
  // A catalog that declares no locale cannot be contradicted. `configured-only`
  // routes — an env-configured endpoint, a provider profile whose voice name
  // carries no language hint — land on `und`, and filtering them out would turn
  // "the host does not know" into "you have no voice", leaving an account whose
  // only route is configured-only with nothing at all the moment the deliverable
  // language is named. Only a voice whose catalog names a different language is
  // withheld.
  const eligible = language
    ? voices.filter((voice) => (
      !ttsVoiceCatalogDeclaresLanguage(voice)
      || (ttsVoiceSupportsLanguage(voice, language) && ttsVoiceLanguageIsVerified(voice, language))
    ))
    : voices;
  const limit = opts.limit ?? TTS_VOICE_LISTING_LIMIT;
  if (eligible.length <= limit) return { voices: eligible, eligible: eligible.length };

  const picked: PublicTtsVoiceCapability[] = [];
  const seen = new Set<PublicTtsVoiceCapability>();
  const take = (voice: PublicTtsVoiceCapability) => {
    if (seen.has(voice) || picked.length >= limit) return;
    seen.add(voice);
    picked.push(voice);
  };
  for (const voice of eligible) if (voice.isDefault) take(voice);

  const buckets = new Map<string, PublicTtsVoiceCapability[]>();
  for (const voice of eligible) {
    for (const useCase of voice.useCases.length ? voice.useCases : ['']) {
      const bucket = buckets.get(useCase);
      if (bucket) bucket.push(voice);
      else buckets.set(useCase, [voice]);
    }
  }
  const rarestFirst = [...buckets.values()].sort((a, b) => a.length - b.length);
  const deepest = rarestFirst.reduce((max, bucket) => Math.max(max, bucket.length), 0);
  for (let depth = 0; depth < deepest && picked.length < limit; depth += 1) {
    for (const bucket of rarestFirst) if (bucket[depth]) take(bucket[depth]);
  }
  return { voices: picked, eligible: eligible.length };
}

export async function resolveTtsSelection(input: {
  routeRef?: string;
  voiceRef?: string;
  legacyVoice?: string;
  language?: string;
  signal?: AbortSignal;
} = {}): Promise<TtsSelectionResult> {
  const routes = await listTtsCapabilities(input.signal);
  const route = input.routeRef
    ? routes.find((candidate) => candidate.routeRef === input.routeRef)
    : routes[0];
  if (!route) {
    const availability = getTtsAvailabilityDetails(false);
    if (!availability.available && !input.routeRef) {
      return {
        ok: false,
        errorCode: availability.errorCode || 'E_TTS_NOT_CONFIGURED',
        message: availability.message || 'No speech provider is available.',
      };
    }
    return {
      ok: false,
      errorCode: input.routeRef ? 'E_TTS_ROUTE_UNRESOLVED' : 'E_TTS_NO_PROVIDER',
      message: input.routeRef
        ? `The signed TTS route is no longer configured: ${input.routeRef}. Revise the narration plan and reopen Gate B.`
        : 'No speech provider is available.',
    };
  }

  const requestedLanguageRaw = String(input.language || '').trim();
  const requestedLanguage = normalizeTtsLanguage(requestedLanguageRaw);
  if (requestedLanguageRaw && !requestedLanguage) {
    return {
      ok: false,
      errorCode: 'E_TTS_LANGUAGE_INVALID',
      message: `Invalid narration language tag: ${requestedLanguageRaw}. Refresh speech.capabilities and revise the Gate B plan.`,
    };
  }

  const requestedVoiceRef = String(input.voiceRef || '').trim();
  const legacyVoice = String(input.legacyVoice || '').trim();
  const voice = requestedVoiceRef
    ? route.voices.find((candidate) => candidate.voiceRef === requestedVoiceRef)
    : legacyVoice
      ? route.voices.find((candidate) => candidate.providerVoiceId === legacyVoice)
      : route.voices.find((candidate) => candidate.voiceRef === route.defaultVoiceRef) || route.voices[0];
  if (!voice) {
    return {
      ok: false,
      errorCode: 'E_TTS_VOICE_UNRESOLVED',
      message: `The requested voice is not present in the current ${route.displayName} capability catalog. Query speech.capabilities and revise the signed narration selection.`,
    };
  }

  const language = requestedLanguage || voice.nativeLocale;
  if (language !== 'und' && !ttsVoiceSupportsLanguage(voice, language)) {
    return {
      ok: false,
      errorCode: 'E_TTS_LANGUAGE_UNSUPPORTED',
      message: `${voice.displayName} does not support ${language} as the narration language. Choose a compatible voice from speech.capabilities.`,
    };
  }
  if (language !== 'und' && !ttsVoiceLanguageIsVerified(voice, language)) {
    return {
      ok: false,
      errorCode: 'E_TTS_LANGUAGE_UNVERIFIED',
      message: `${voice.displayName} advertises ${language} only as a candidate capability. Choose a verified voice from speech.capabilities.`,
    };
  }

  return {
    ok: true,
    selection: {
      routeRef: route.routeRef,
      voiceRef: voice.voiceRef,
      providerVoiceId: voice.providerVoiceId,
      displayName: voice.displayName,
      provider: route.provider,
      model: route.model,
      catalogStatus: route.catalogStatus,
      language,
    },
  };
}
