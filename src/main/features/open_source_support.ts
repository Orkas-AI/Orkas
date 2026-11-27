import { fetchWithRetry } from '../util/retry';
import { apiBase } from './marketplace';

export async function recordOpenSourceSupport(input: unknown): Promise<void> {
  if (!input || typeof input !== 'object') return;
  const { surface, action } = input as { surface?: unknown; action?: unknown };
  if ((surface !== 'home' && surface !== 'settings')
    || (action !== 'show' && action !== 'open' && (surface !== 'home' || action !== 'dismiss'))) return;
  if (process.env.ORKAS_E2E_USER_DATA_DIR || process.env.ORKAS_TELEMETRY_DISABLED === '1'
    || process.env.ORKAS_PACKAGED_LAUNCH_SMOKE_FILE) return;

  // Only these two enums leave the device. The standard headers also carry
  // installation metadata, so this request sends only the required channel.
  try {
    const response = await fetchWithRetry('open-source-support', `${apiBase()}/analytics/open-github-star`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Orkas-Channel': 'open' },
      body: JSON.stringify({ surface, action }),
      credentials: 'omit',
      redirect: 'error',
    }, { retries: 0, timeoutMs: 5_000, timeoutMessage: 'Open-source support report timed out' });
    await response.body?.cancel();
  } catch { /* Optional statistics must not interrupt the invitation action. */ }
}
