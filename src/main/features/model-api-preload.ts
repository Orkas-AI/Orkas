import { getChatPreloadApi } from './auth';
import { getActiveUserId } from './users';
import { preloadModelApi } from '../model/core-agent/api-preload';
import { createLogger } from '../logger';
import { logErrorSummary } from '../util/log-redact';
import { isBootAdmissionIdle, scheduleBootBackground } from '../util/boot_init';

const log = createLogger('model-api-preload');
const QUIET_MS = 3_000;

/** One best-effort opportunity after the first document loads. Foreground sends
 * never depend on this task; native ESM imports share their normal module cache.
 * A late login or a changed selection retains ordinary lazy loading. */
export function scheduleChatApiPreload(isRendererReady: () => Promise<boolean>) {
  return scheduleBootBackground('model:preload-api', async (signal) => {
    try {
      if (signal?.aborted || !(await isRendererReady()) || !isBootAdmissionIdle(QUIET_MS)) return;
      const uid = getActiveUserId();
      const api = await getChatPreloadApi();
      // Metadata discovery can yield. Recheck both ownership and user activity
      // immediately before the non-interruptible module evaluation begins.
      if (!api || signal?.aborted || uid !== getActiveUserId() || !isBootAdmissionIdle(QUIET_MS)) return;
      const start = performance.now();
      if (await preloadModelApi(api, () => !signal?.aborted && uid === getActiveUserId() && isBootAdmissionIdle(QUIET_MS))) {
        log.info('model API preload finished', { api, duration_ms: Math.round(performance.now() - start) });
      }
    } catch (error) {
      log.warn('model API preload unavailable', { error: logErrorSummary(error) });
    }
  }, 6_000, {
    resourceClass: 'disk', preferIdle: true, recentActivityMs: QUIET_MS,
    // This optional work must never override continuing user interaction.
    maxUserDeferralMs: Number.POSITIVE_INFINITY,
  });
}
