import { createHash } from 'node:crypto';
import { isProviderSafetyError, providerHttpStatusOf } from '../../../core-agent/src/shared/errors';

export interface CustomModelImageSupport {
  unsupported: boolean;
  observeRejection(error: unknown): void;
}

// Process-local observations, never persisted in profiles or session history.
// Hash the complete configuration so account/endpoint/model/credential edits
// cannot inherit another configuration's capability decision. Retain no keys.
const observations = new Map<string, CustomModelImageSupport>();
const MAX_OBSERVATIONS = 256;

export function customModelImageSupport(scope: {
  userId: string;
  profileId: string;
  modelId: string;
  apiKey: string;
  config: unknown;
}): CustomModelImageSupport {
  const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const previous = observations.get(key);
  if (previous) {
    observations.delete(key);
    observations.set(key, previous);
    return previous;
  }
  const state: CustomModelImageSupport = {
    unsupported: false,
    observeRejection(error) {
      if (explicitlyRejectsModelImages(error)) state.unsupported = true;
    },
  };
  observations.set(key, state);
  if (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value!);
  return state;
}

function explicitlyRejectsModelImages(error: unknown): boolean {
  if (isProviderSafetyError(error)) return false;
  const status = providerHttpStatusOf(error);
  if (status !== 400 && status !== 422) return false;
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const record = current as { message?: unknown; cause?: unknown; error?: unknown };
    // Only explicit API capability rejection. Invalid URLs, encodings, image
    // sizes/formats and generic unsupported parameters are not model facts.
    const message = typeof record.message === 'string' ? record.message.slice(0, 8192) : '';
    if (/\b(?:this |the |selected )?model\b[^.\n]{0,120}\b(?:does not|doesn't|cannot) support (?:image inputs?|images|vision)\b(?=\s*(?:[.!,;:"\'}\]]|$))/i.test(message)
      || /\bimage_url\b[^.\n]{0,40}\bis only supported by certain models\b/i.test(message)
      || /\b(?:image inputs?|images|vision) (?:is|are) not supported (?:by|for) (?:this |the |selected )?model\b/i.test(message)) return true;
    current = record.cause ?? record.error;
  }
  return false;
}
