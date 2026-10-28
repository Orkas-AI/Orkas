/** API-key voice setup. The long-lived credential never crosses IPC. */
import { systemPreferences } from 'electron';
import { getOrkasApiKey } from './auth';
import { getActiveUserId } from './users';
import { ORKAS_API_BASE_URL } from './orkas_api';
import { fetchAndReadWithTimeout } from '../util/abort';

export function getVoiceStatus(): { configured: boolean } {
  return { configured: !!getOrkasApiKey() };
}

export async function createVoiceSession(): Promise<{ ok: boolean; code?: string; error?: string; url?: string; maxSeconds?: number }> {
  const key = getOrkasApiKey();
  if (!key) return { ok: false, code: 'api_key_required' };
  const owner = getActiveUserId();
  try {
    const { response, body } = await fetchAndReadWithTimeout(
      `${ORKAS_API_BASE_URL}/audio/transcription_sessions`,
      { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}' },
      60_000, undefined, 'voice session timeout',
      async (res) => res.ok ? await res.json() as { ticket?: string } : null,
    );
    if (owner !== getActiveUserId() || key !== getOrkasApiKey()) return { ok: false, code: 'unavailable' };
    if (!response.ok) return { ok: false, code: response.status === 401 ? 'invalid_api_key'
      : response.status === 403 ? 'insufficient_scope'
        : response.status === 429 ? 'rate_limit_exceeded' : 'unavailable' };
    if (!body || typeof body.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.ticket)) {
      return { ok: false, code: 'unavailable' };
    }
    return { ok: true, url: `wss://orkas.ai/api/voice/asr_ws?ticket=${encodeURIComponent(body.ticket)}`, maxSeconds: 120 };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

export async function ensureMicrophoneAccess(platform: NodeJS.Platform = process.platform): Promise<{ granted: boolean; status: string }> {
  // getUserMedia remains authoritative on Windows/Linux: this is a macOS OS
  // prompt preflight, not evidence that a recording device is available.
  if (platform !== 'darwin') return { granted: true, status: 'unknown' };
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return { granted: true, status };
  if (status === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return { granted, status: granted ? 'granted' : systemPreferences.getMediaAccessStatus('microphone') };
  }
  return { granted: false, status };
}
