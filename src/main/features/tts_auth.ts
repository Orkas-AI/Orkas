/**
 * Text-to-speech provider management for user-owned keys.
 *
 * Open-source builds do not ship a hosted Orkas speech API. Users configure
 * their own provider credentials here, and downstream speech tools read the
 * ordered `ttsProfiles` list from auth.ts.
 */

import { loadTtsProfiles, saveTtsProfiles, type TtsProfile } from './auth';
import { createLogger } from '../logger';

const log = createLogger('tts-auth');

const DOUBAO_TTS_BASE_URL = 'https://openspeech.bytedance.com';
const LEGACY_DOUBAO_DEFAULT_VOICE = 'zh_male_jieshuoxiaoming_uranus_bigtts';
export const DOUBAO_DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts';
export const DEFAULT_TTS_FORMAT = 'mp3';

let _idCounter = 0;
function nextTtsProfileId(): string {
  _idCounter = (_idCounter + 1) % 100000;
  return `tts-${Date.now().toString(36)}-${_idCounter}`;
}

function sanitizeLabel(input: string): string {
  return String(input || '').trim().slice(0, 40) || 'default';
}

function normalizeBaseUrl(raw: string): string | null {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

function normalizeTtsProfile(p: TtsProfile): TtsProfile {
  if (p.provider === 'doubao' && (!p.voice || p.voice === LEGACY_DOUBAO_DEFAULT_VOICE)) {
    return { ...p, voice: DOUBAO_DEFAULT_VOICE };
  }
  return p;
}

export function listTtsProfiles(): TtsProfile[] {
  const list = loadTtsProfiles();
  const normalized = list
    .filter((p) => p.provider !== 'orkas-voice')
    .map(normalizeTtsProfile);
  if (JSON.stringify(normalized) !== JSON.stringify(list)) saveTtsProfiles(normalized);
  return normalized;
}

export interface AddTtsProfileInput {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  provider?: string;
  resourceId?: string;
  voice?: string;
  format?: string;
  label?: string;
}

export function addTtsProfile(input: AddTtsProfileInput): { ok: true; id: string } | { ok: false; error: string } {
  const provider = String(input.provider || 'custom').trim() || 'custom';
  const apiKey = String(input.apiKey || '').trim();
  const voice = String(input.voice || '').trim();
  const format = String(input.format || '').trim();

  if (provider === 'orkas-voice') return { ok: false, error: 'provider unavailable in open-source build' };
  if (provider === 'doubao') return addDoubaoProfile({ apiKey, voice, format, input });

  const baseUrl = normalizeBaseUrl(input.baseUrl || '');
  const model = String(input.model || '').trim();
  if (!baseUrl) return { ok: false, error: 'baseUrl required (http(s)://...)' };
  if (!model) return { ok: false, error: 'model required' };
  if (!apiKey) return { ok: false, error: 'apiKey required' };

  return persistTtsProfile({
    provider,
    baseUrl,
    model,
    apiKey,
    ...(voice ? { voice } : {}),
    ...(format ? { format } : {}),
    label: sanitizeLabel(input.label || provider),
  });
}

function addDoubaoProfile(args: { apiKey: string; voice: string; format: string; input: AddTtsProfileInput }):
  { ok: true; id: string } | { ok: false; error: string } {
  const { apiKey, voice, format, input } = args;
  if (!apiKey) return { ok: false, error: 'API key required' };
  const resourceId = String(input.resourceId || '').trim();
  return persistTtsProfile({
    provider: 'doubao',
    baseUrl: DOUBAO_TTS_BASE_URL,
    model: '',
    apiKey,
    ...(resourceId ? { resourceId } : {}),
    voice: voice || DOUBAO_DEFAULT_VOICE,
    ...(format ? { format } : {}),
    label: sanitizeLabel(input.label || 'doubao'),
  });
}

function persistTtsProfile(fields: Omit<TtsProfile, 'id' | 'createdAt'>): { ok: true; id: string } {
  const list = listTtsProfiles();
  const profile: TtsProfile = { id: nextTtsProfileId(), ...fields, createdAt: Date.now() };
  list.unshift(profile);
  saveTtsProfiles(list);
  log.info('tts profile added', { id: profile.id, provider: profile.provider, model: profile.model || '(n/a)' });
  return { ok: true, id: profile.id };
}

export function removeTtsProfile(id: string): { ok: boolean } {
  const list = listTtsProfiles();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return { ok: false };
  saveTtsProfiles(next);
  log.info('tts profile removed', { id });
  return { ok: true };
}

export function reorderTtsProfiles(orderedIds: string[]): { ok: boolean } {
  const list = listTtsProfiles();
  const idx = new Map(orderedIds.map((id, i) => [id, i]));
  const next = [...list].sort((a, b) => {
    const ra = idx.has(a.id) ? (idx.get(a.id) as number) : 1000;
    const rb = idx.has(b.id) ? (idx.get(b.id) as number) : 1000;
    return ra - rb;
  });
  saveTtsProfiles(next);
  return { ok: true };
}

export function listTtsProviderPresets(): Array<{
  id: string; label: string; baseUrl: string;
  defaultModel?: string; defaultVoice?: string; defaultFormat?: string; docs?: string;
}> {
  return [
    { id: 'doubao', label: 'DouBao · Voice', baseUrl: DOUBAO_TTS_BASE_URL, defaultVoice: DOUBAO_DEFAULT_VOICE, defaultFormat: DEFAULT_TTS_FORMAT, docs: 'https://www.volcengine.com/docs/6561/1598757' },
    { id: 'elevenlabs', label: 'ElevenLabs', baseUrl: 'https://api.elevenlabs.io/v1', defaultModel: 'eleven_multilingual_v2', docs: 'https://elevenlabs.io/docs' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'tts-1', defaultVoice: 'alloy', defaultFormat: DEFAULT_TTS_FORMAT, docs: 'https://platform.openai.com/api-keys' },
    { id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', docs: '' },
  ];
}
