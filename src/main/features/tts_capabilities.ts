import * as crypto from 'node:crypto';

import type { TtsProfile } from './auth';
import { DEFAULT_TTS_FORMAT, listTtsProfiles } from './tts_auth';
import { createLogger } from '../logger';

const log = createLogger('tts-capabilities');

export type TtsCatalogStatus = 'configured-only' | 'unavailable';
export type TtsLanguageConfidence = 'verified' | 'candidate';

export type TtsVoiceCapability = {
  voiceRef: string;
  displayName: string;
  locale: string;
  nativeLocale: string;
  supportedLocales: string[];
  mixedLanguageSupport: boolean;
  languageConfidence: TtsLanguageConfidence;
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
    languageConfidence: 'verified',
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
  try { profiles = listTtsProfiles(); }
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
    return {
      ok: false,
      errorCode: input.routeRef ? 'E_TTS_ROUTE_UNRESOLVED' : 'E_TTS_NOT_CONFIGURED',
      message: input.routeRef
        ? `The signed TTS route is no longer configured: ${input.routeRef}. Revise the narration plan and reopen Gate B.`
        : 'No TTS provider is configured.',
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
