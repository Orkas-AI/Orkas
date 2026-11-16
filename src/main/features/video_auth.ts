import { VIDEO_MODEL_SPECS, LEGACY_VIDEO_MODELS, videoModelSpec, WAN_REGIONS } from './video_models';
import { createVideoCloudCredentials } from './video_cloud_auth';
/**
 * Video-generation API key management for BYO providers.
 *
 * This is only the local credential/configuration layer. The open-source app
 * can use the public Orkas API with a user-supplied API key, but never exposes
 * the commercial app's managed provider or server-owned credentials.
 */

import {
  loadVideoProfiles,
  saveVideoProfiles,
  type VideoProfile,
} from './auth';
import { createLogger } from '../logger';
import {
  ORKAS_API_KEYS_URL,
  ORKAS_API_PROVIDER,
  ORKAS_API_VIDEO_MODEL,
} from './orkas_api';

const log = createLogger('video-auth');

export const VIDEO_MODELS_BY_PROVIDER: Readonly<Record<string, Array<{ id: string; name: string }>>> = {
 [ORKAS_API_PROVIDER]: [{id:ORKAS_API_VIDEO_MODEL,name:'Video'}],
 ...Object.fromEntries(Object.entries(VIDEO_MODEL_SPECS).map(([provider,models])=>[provider,models.map(({id,name})=>({id,name}))])),
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
  workspaceId?: string;
  region?: string;
}

export function isVideoProviderModelAllowed(provider:string,model:string):boolean { return !!VIDEO_MODELS_BY_PROVIDER[provider]?.some(m=>m.id===model) || !!LEGACY_VIDEO_MODELS[provider]?.includes(model); }

function defaultVideoModel(provider: string): string {
  return VIDEO_MODELS_BY_PROVIDER[provider]?.[0]?.id || '';
}

export function addVideoProfile(input: AddVideoProfileInput): { ok: true; id: string } | { ok: false; error: string; errorKey?: string } {
  const provider = String(input.provider || '').trim();
  const model = String(input.model || '').trim() || defaultVideoModel(provider);
  const apiKey = String(input.apiKey || '').trim();
  if (!provider) return { ok: false, error: 'provider required' };
  if (!model) return { ok: false, error: 'model required' };
  if (!isVideoProviderModelAllowed(provider, model) || (provider !== ORKAS_API_PROVIDER && !videoModelSpec(provider, model))) {
    return { ok: false, error: `unsupported video model "${provider}/${model}"` };
  }
  if (!apiKey) return { ok: false, error: 'apiKey required' };
  if (provider === 'google-cloud') {
    try { createVideoCloudCredentials(apiKey); }
    catch (err) { return { ok: false, error: (err as Error).message, errorKey: 'settings.video.error_cloud_credentials' }; }
  }
  const workspaceId = String(input.workspaceId || '').trim();
  const region = String(input.region || 'cn-beijing').trim();
  if (provider === 'aliyun') {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(workspaceId)) return { ok: false, error: 'Alibaba Cloud workspace ID required', errorKey: 'settings.video.error_wan_configuration' };
    if (!WAN_REGIONS.includes(region as typeof WAN_REGIONS[number])) return { ok: false, error: 'unsupported Alibaba Cloud region', errorKey: 'settings.video.error_wan_configuration' };
  }
  const list = loadVideoProfiles();
  const profile: VideoProfile = {
    id: nextVideoProfileId(),
    provider,
    model,
    apiKey,
    label: sanitizeLabel(input.label || 'default'),
    createdAt: Date.now(),
    ...(provider === 'aliyun' ? { workspaceId, region } : {}),
    ...(['minimax', 'vidu', 'kling'].includes(provider) ? { apiSite: 'cn' as const } : {}),
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
    { id: ORKAS_API_PROVIDER, label: 'Orkas', docs: ORKAS_API_KEYS_URL },
    {
      id: 'doubao',
      label: 'DouBao · Seedance',
      docs: 'https://ark.volcengine.com/region:cn-beijing/apikey',
    },
    { id: 'minimax', label: 'MiniMax', docs: 'https://platform.minimax.cn/docs/guides/quickstart-preparation' },
    { id: 'vidu', label: 'Vidu', docs: 'https://platform.vidu.cn/' },
    { id: 'kling', label: 'Kling', docs: 'https://app.klingai.com/cn/dev' },
    { id: 'google', label: 'Google', docs: 'https://aistudio.google.com/apikey' },
    { id: 'google-cloud', label: 'Google Cloud', docs: 'https://console.cloud.google.com/iam-admin/serviceaccounts' },
    { id: 'aliyun', label: 'Alibaba Cloud', docs: 'https://help.aliyun.com/zh/model-studio/get-api-key' },
    { id: 'runway', label: 'Runway', docs: 'https://docs.dev.runwayml.com/guides/setup/' },
  ];
}

export function listVideoModelOptions(provider: string): Array<{ id: string; name: string }> {
  return VIDEO_MODELS_BY_PROVIDER[provider] || [];
}

export function listVideoModelsByProvider(): Record<string, Array<{ id: string; name: string }>> {
  return Object.fromEntries(
    Object.keys(VIDEO_MODELS_BY_PROVIDER).map((provider) => [
      provider,
      listVideoModelOptions(provider),
    ]),
  );
}

export interface VideoProviderPickerOption {
  id: string;
  provider: string;
  model?: string;
  label: string;
  docs?: string;
}

export function flattenVideoProviderOptions(
  providers: Array<{ id: string; label: string; docs?: string }>,
): VideoProviderPickerOption[] {
  return providers.flatMap((provider) => {
    if (provider.id === ORKAS_API_PROVIDER) return [{...provider,provider:provider.id,model:ORKAS_API_VIDEO_MODEL,label:'Orkas · Video'}];
    const models = listVideoModelOptions(provider.id);
    if (models.length <= 1) {
      return [{
        ...provider,
        provider: provider.id,
        ...(models[0] ? { model: models[0].id } : {}),
        label: models[0]?.name || provider.label,
      }];
    }
    return models.map((model) => ({
      ...provider,
      id: `${provider.id}:${model.id}`,
      provider: provider.id,
      model: model.id,
      label: model.name,
    }));
  });
}
