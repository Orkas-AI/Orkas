/**
 * Monkey-patch @anthropic-ai/sdk and openai request ownership defaults.
 *
 * Why: pi-ai constructs SDK clients with hardcoded options and does
 * NOT expose `timeout` as a configurable parameter. Both SDKs default to
 * 600s, which caps long-running reasoning / agent / tool-loop calls too
 * tightly. We subclass each SDK's primary class to inject a larger default
 * timeout, then replace the module-level references so pi-ai's
 * `import Anthropic from "@anthropic-ai/sdk"` (and similar) picks up the
 * wrapped class. Orkas owns visible retry policy above the SDK, so opaque SDK
 * retries are disabled unless a caller explicitly opts into them.
 *
 * Must run BEFORE any code path imports pi-ai (which in turn imports these
 * SDKs). Installed from `src/main/index.ts` at boot, ahead of feature
 * imports whose transitive loads may reach core-agent.
 */
import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';

const log = createLogger('sdk-timeout-patch');

/** 1 hour. Paired with `idleTimeout` (1800s) in `client.ts` as the two real
 * guards on LLM calls; every other "timeout" in the app is either a short
 * external-IO failfast or a debounce. */
const LLM_TIMEOUT_MS = 3_600_000;
const LLM_SDK_MAX_RETRIES = 0;

export function sdkClientOptionsForOrkas(opts: any = {}): any {
  const base = opts || {};
  return {
    ...base,
    ...(base.timeout == null ? { timeout: LLM_TIMEOUT_MS } : {}),
    ...(base.maxRetries == null ? { maxRetries: LLM_SDK_MAX_RETRIES } : {}),
  };
}

export function installSdkTimeoutPatch(): void {
  try {
    patchSdk('@anthropic-ai/sdk');
  } catch (err) {
    log.warn('sdk patch failed', { module: '@anthropic-ai/sdk', error: logErrorSummary(err) });
  }
  try {
    patchSdk('openai');
  } catch (err) {
    log.warn('sdk patch failed', { module: 'openai', error: logErrorSummary(err) });
  }
}

function patchSdk(moduleName: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(moduleName);
  const Original = mod.default;
  if (typeof Original !== 'function') {
    log.warn('sdk patch skipped', { module: moduleName, reason: 'missing_default_class' });
    return;
  }
  if ((Original as any).__orkasPatched) return;

  class Wrapped extends Original {
    constructor(opts: any = {}) {
      super(sdkClientOptionsForOrkas(opts));
    }
  }
  (Wrapped as any).__orkasPatched = true;

  Object.defineProperty(mod, 'default', { value: Wrapped, writable: true, configurable: true });
  for (const key of Object.keys(mod)) {
    if (key === 'default') continue;
    try {
      if (mod[key] === Original) {
        Object.defineProperty(mod, key, { value: Wrapped, writable: true, configurable: true });
      }
    } catch {
      /* getter-only or frozen — skip */
    }
  }
  log.info('sdk request defaults patched', {
    module: moduleName,
    timeout_ms: LLM_TIMEOUT_MS,
    max_retries: LLM_SDK_MAX_RETRIES,
  });
}
