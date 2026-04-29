/**
 * Image-generation API key management.
 *
 * Thin business layer on top of the `imageProfiles` array stored in
 * `<uid>/local/config/auth-profiles.json` (see `features/auth.ts` for the
 * file schema and v3→v4 compat). Each entry is a `(provider, apiKey,
 * label)` triple — model id is fixed by `provider_catalog.IMAGE_GEN_BY_PROVIDER`,
 * never user-overridable.
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
import { callDoubaoImage, callGeminiImage, callOpenAIImage } from './image_gen';
import { createLogger } from '../logger';

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
  apiKey: string;
  label?: string;
}

export function addImageProfile(input: AddImageProfileInput): { ok: true; id: string } | { ok: false; error: string } {
  const provider = String(input.provider || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  if (!provider) return { ok: false, error: 'provider required' };
  if (!apiKey) return { ok: false, error: 'apiKey required' };
  if (!findImageGenCapability(provider)) {
    return { ok: false, error: `provider "${provider}" has no image-gen capability` };
  }
  const list = loadImageProfiles();
  const profile: ImageProfile = {
    id: nextImageProfileId(),
    provider,
    apiKey,
    label: sanitizeLabel(input.label || 'default'),
    createdAt: Date.now(),
  };
  list.push(profile);
  saveImageProfiles(list);
  log.info('image profile added', { id: profile.id, provider });
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

/**
 * Connectivity probe — sends a minimal generation request to the picked
 * provider's image API. Costs ≈ one cheap image. Caller should only invoke
 * on explicit user action (e.g. "测试" button), not on every save.
 */
export async function testImageProfile(id: string): Promise<TestImageProfileResult> {
  const list = loadImageProfiles();
  const target = list.find((p) => p.id === id);
  if (!target) return { ok: false, durationMs: 0, error: 'profile not found' };
  const cap = findImageGenCapability(target.provider);
  if (!cap) return { ok: false, durationMs: 0, error: `provider ${target.provider} has no image-gen capability` };

  const t0 = Date.now();
  try {
    const req = {
      apiKey: target.apiKey,
      model: cap.model,
      prompt: 'a small red dot on white background',
      size: '1024x1024',
    };
    if (cap.api === 'openai')      await callOpenAIImage(req);
    else if (cap.api === 'gemini') await callGeminiImage(req);
    else if (cap.api === 'doubao') await callDoubaoImage(req);
    else throw new Error(`unknown image-gen api: ${cap.api}`);
    return { ok: true, durationMs: Date.now() - t0, provider: target.provider, model: cap.model };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn('image profile test failed', { id, provider: target.provider, error: msg });
    return { ok: false, durationMs: Date.now() - t0, error: msg, provider: target.provider, model: cap.model };
  }
}
