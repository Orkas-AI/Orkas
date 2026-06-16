/**
 * Video-generation API key management for BYO providers.
 *
 * This is only the local credential/configuration layer. It deliberately does
 * not expose any Orkas-managed video provider or Server proxy.
 */

import {
  loadVideoProfiles,
  saveVideoProfiles,
  type VideoProfile,
} from './auth';
import { createLogger } from '../logger';

const log = createLogger('video-auth');

const VIDEO_AUTH_MODELS_BY_PROVIDER: Readonly<Record<string, Array<{ id: string; name: string }>>> = {
  doubao: [
    { id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0' },
  ],
};

let _idCounter = 0;
function nextVideoProfileId(): string {
  _idCounter = (_idCounter + 1) % 100000;
  return `vid-${Date.now().toString(36)}-${_idCounter}`;
}

function sanitizeLabel(input: string): string {
  return String(input || '').trim().slice(0, 40) || 'default';
}

export function listVideoProfiles(): VideoProfile[] {
  return loadVideoProfiles();
}

export interface AddVideoProfileInput {
  provider: string;
  model?: string;
  apiKey: string;
  label?: string;
}

export function isVideoProviderModelAllowed(provider: string, model: string): boolean {
  return !!VIDEO_AUTH_MODELS_BY_PROVIDER[provider]?.some((m) => m.id === model);
}

function defaultVideoModel(provider: string): string {
  return VIDEO_AUTH_MODELS_BY_PROVIDER[provider]?.[0]?.id || '';
}

export function addVideoProfile(input: AddVideoProfileInput): { ok: true; id: string } | { ok: false; error: string } {
  const provider = String(input.provider || '').trim();
  const model = String(input.model || '').trim() || defaultVideoModel(provider);
  const apiKey = String(input.apiKey || '').trim();
  if (!provider) return { ok: false, error: 'provider required' };
  if (!isVideoProviderModelAllowed(provider, model)) {
    return { ok: false, error: `unsupported video model "${provider}/${model}"` };
  }
  if (!apiKey) return { ok: false, error: 'apiKey required' };
  const list = loadVideoProfiles();
  const profile: VideoProfile = {
    id: nextVideoProfileId(),
    provider,
    model,
    apiKey,
    label: sanitizeLabel(input.label || 'default'),
    createdAt: Date.now(),
  };
  list.unshift(profile);
  saveVideoProfiles(list);
  log.info('video profile added', { id: profile.id, provider, model });
  return { ok: true, id: profile.id };
}

export function removeVideoProfile(id: string): { ok: boolean } {
  const list = loadVideoProfiles();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return { ok: false };
  saveVideoProfiles(next);
  log.info('video profile removed', { id });
  return { ok: true };
}

export function reorderVideoProfiles(orderedIds: string[]): { ok: boolean } {
  const list = loadVideoProfiles();
  const idx = new Map(orderedIds.map((id, i) => [id, i]));
  const next = [...list].sort((a, b) => {
    const ra = idx.has(a.id) ? (idx.get(a.id) as number) : 1000;
    const rb = idx.has(b.id) ? (idx.get(b.id) as number) : 1000;
    return ra - rb;
  });
  saveVideoProfiles(next);
  return { ok: true };
}

export function listVideoProviderOptions(): Array<{ id: string; label: string; docs?: string }> {
  return [
    {
      id: 'doubao',
      label: 'DouBao · Seedance',
      docs: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    },
  ];
}

export function listVideoModelOptions(provider: string): Array<{ id: string; name: string }> {
  return VIDEO_AUTH_MODELS_BY_PROVIDER[provider] || [];
}

export function listVideoModelsByProvider(): Record<string, Array<{ id: string; name: string }>> {
  return Object.fromEntries(
    Object.keys(VIDEO_AUTH_MODELS_BY_PROVIDER).map((provider) => [
      provider,
      listVideoModelOptions(provider),
    ]),
  );
}
