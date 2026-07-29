/**
 * Image-generation API key management.
 *
 * Thin business layer on top of the `imageProfiles` array stored in
 * `<uid>/local/config/auth-profiles.json` (see `features/auth.ts` for the
 * file schema and v3→v4 compat). Each entry is a
 * `(provider, model, apiKey, label)` tuple owned by the user.
 *
 * Picker priority order is enforced in `features/image_gen.ts::pickImageGenProfile`:
 *   1. dedicated imageProfiles (set via the settings page card)
 *   2. fall back to chat-side api_key entries (legacy behavior)
 *
 * The "test connection" path here issues the same ping as a real image
 * generation but with `n=1` + a tiny prompt so we don't burn real quota.
 */

import {
  loadImageProfiles,
  saveImageProfiles,
  type ImageProfile,
} from './auth';
import { findImageGenCapability } from '../model/provider_catalog';
import {
  IMAGE_MODELS_BY_PROVIDER,
  callDoubaoImage,
  callGeminiImage,
  callOpenAIImage,
  isImageProviderModelAllowed,
} from './image_gen';
import { createLogger } from '../logger';
import { logErrorSummary } from '../util/log-redact';

const log = createLogger('image-auth');

let _idCounter = 0;
function nextImageProfileId(): string {
  _idCounter = (_idCounter + 1) % 100000;
  return `img-${Date.now().toString(36)}-${_idCounter}`;
}

function sanitizeLabel(input: string): string {
  return String(input || '').trim().slice(0, 40) || 'default';
}

export function listImageProfiles(): ImageProfile[] {
  return loadImageProfiles();
}

export interface AddImageProfileInput {
  provider: string;
  model?: string;
  apiKey: string;
  label?: string;
}

export function addImageProfile(input: AddImageProfileInput): { ok: true; id: string } | { ok: false; error: string } {
  const provider = String(input.provider || '').trim();
  const capability = findImageGenCapability(provider);
  const model = String(input.model || capability?.model || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  if (!provider) return { ok: false, error: 'provider required' };
  if (!apiKey) return { ok: false, error: 'apiKey required' };
  if (!capability) {
    return { ok: false, error: `provider "${provider}" has no image-gen capability` };
  }
  if (!model) return { ok: false, error: 'model required' };
  if (!isImageProviderModelAllowed(provider, model)) {
    return { ok: false, error: `unsupported image model "${provider}/${model}"` };
  }
  const list = loadImageProfiles();
  const profile: ImageProfile = {
    id: nextImageProfileId(),
    provider,
    model,
    apiKey,
    label: sanitizeLabel(input.label || 'default'),
    createdAt: Date.now(),
  };
  list.unshift(profile);
  saveImageProfiles(list);
  log.info('image profile added', { id: profile.id, provider, model });
  return { ok: true, id: profile.id };
}

export function removeImageProfile(id: string): { ok: boolean } {
  const list = loadImageProfiles();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return { ok: false };
  saveImageProfiles(next);
  log.info('image profile removed', { id });
  return { ok: true };
}

export function reorderImageProfiles(orderedIds: string[]): { ok: boolean } {
  const list = loadImageProfiles();
  const idx = new Map(orderedIds.map((id, i) => [id, i]));
  const next = [...list].sort((a, b) => {
    const ra = idx.has(a.id) ? (idx.get(a.id) as number) : 1000;
    const rb = idx.has(b.id) ? (idx.get(b.id) as number) : 1000;
    return ra - rb;
  });
  saveImageProfiles(next);
  return { ok: true };
}

export interface TestImageProfileResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  provider?: string;
  model?: string;
}

function userFacingImageProbeError(err: unknown): string {
  const value = err as { name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const message = String(value?.message || err || '');
  const explicitStatus = Number(value?.status || value?.statusCode);
  const statusMatch = message.match(/\b(401|402|403|408|429)\b/);
  const status = Number.isFinite(explicitStatus) && explicitStatus > 0
    ? explicitStatus
    : Number(statusMatch?.[1] || 0);
  if (status === 401 || status === 403) return 'image credentials rejected';
  if (status === 402) return 'image credits unavailable';
  if (status === 429) return 'image provider rate limited';
  if (status === 408 || value?.name === 'AbortError' || /timed?\s*out/i.test(message)) {
    return 'image provider request timed out';
  }
  return 'image provider request failed';
}

export function listImageModelOptions(provider: string): Array<{ id: string; name: string }> {
  const listed = IMAGE_MODELS_BY_PROVIDER[provider];
  if (listed) return listed;
  const capability = findImageGenCapability(provider);
  return capability ? [{ id: capability.model, name: capability.model }] : [];
}

export interface ImageProviderPickerOption {
  id: string;
  provider: string;
  model?: string;
  label: string;
  docs?: string;
}

export function listImageProviderOptions(): Array<{ id: string; label: string; docs?: string }> {
  return [
    { id: 'openai', label: 'OpenAI', docs: 'https://platform.openai.com/api-keys' },
    { id: 'google', label: 'Google', docs: 'https://aistudio.google.com/app/apikey' },
    {
      id: 'doubao',
      label: 'DouBao',
      docs: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    },
  ];
}

export function flattenImageProviderOptions(
  providers: Array<{ id: string; label: string; docs?: string }>,
): ImageProviderPickerOption[] {
  return providers.flatMap((provider) => {
    const models = listImageModelOptions(provider.id);
    if (models.length <= 1) {
      return [{
        ...provider,
        provider: provider.id,
        ...(models[0] ? { model: models[0].id } : {}),
      }];
    }
    return models.map((model) => ({
      ...provider,
      id: `${provider.id}:${model.id}`,
      provider: provider.id,
      model: model.id,
      label: provider.id === 'doubao'
        ? `DouBao · ${model.name}`
        : `${provider.label} · ${model.name}`,
    }));
  });
}

/**
 * Connectivity probe — sends a minimal generation request to the picked
 * provider's image API. Costs ≈ one cheap image. Caller should only invoke
 * on explicit user action (e.g. a "test" button), not on every save.
 */
export async function testImageProfile(id: string): Promise<TestImageProfileResult> {
  const list = loadImageProfiles();
  const target = list.find((p) => p.id === id);
  if (!target) return { ok: false, durationMs: 0, error: 'profile not found' };
  const cap = findImageGenCapability(target.provider);
  if (!cap) return { ok: false, durationMs: 0, error: `provider ${target.provider} has no image-gen capability` };
  const model = target.model || cap.model;
  if (!isImageProviderModelAllowed(target.provider, model)) {
    return { ok: false, durationMs: 0, error: `unsupported image model "${target.provider}/${model}"` };
  }

  const t0 = Date.now();
  try {
    const req = {
      apiKey: target.apiKey,
      model,
      prompt: 'a small red dot on white background',
      size: '1024x1024',
    };
    if (cap.api === 'openai')      await callOpenAIImage(req);
    else if (cap.api === 'gemini') await callGeminiImage(req);
    else if (cap.api === 'doubao') await callDoubaoImage(req);
    else throw new Error(`unknown image-gen api: ${cap.api}`);
    return { ok: true, durationMs: Date.now() - t0, provider: target.provider, model };
  } catch (err) {
    log.warn('image profile test failed', {
      id,
      provider: target.provider,
      error: logErrorSummary(err),
    });
    return {
      ok: false,
      durationMs: Date.now() - t0,
      error: userFacingImageProbeError(err),
      provider: target.provider,
      model,
    };
  }
}
