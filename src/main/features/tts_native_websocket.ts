import { randomUUID } from 'node:crypto';
import { Agent, ProxyAgent, WebSocket, type Dispatcher } from 'undici';
import { resolveProxyRouteForUrl } from '../util/proxy-dispatcher';
import type { TtsProfile } from './auth';
import type { TtsParams } from './tts';

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const SOCKET_LIMITS = { maxPayloadSize: 2 * 1024 * 1024, maxFragments: 1024 };
class SpeechProxyAgent extends ProxyAgent {
  get webSocketOptions() { return SOCKET_LIMITS; }
}

export type NativeSpeechAudio = { ok: true; audio: Buffer } | {
  ok: false; errorCode: string; dispatched: boolean;
};

/** Strict encoding validation prevents a truncated/malformed frame becoming a successful artifact. */
export function decodeSpeechBase64(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const audio = Buffer.from(value, 'base64');
  return audio.length && audio.toString('base64') === value ? audio : undefined;
}

/** One socket, one synthesis task, no automatic reconnect or replay. Both frame
 * allocation and aggregate wire/audio work are bounded. Proxy policy is shared
 * with fetch, including fail-closed handling for unsupported SDK routes. */
export async function synthesizeNativeWebSocket(profile: TtsProfile, params: TtsParams, signal: AbortSignal,
  format: string, codec?: string): Promise<NativeSpeechAudio> {
  const eleven = profile.provider === 'elevenlabs';
  let base: URL;
  try {
    base = new URL(profile.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol)) return { ok: false, errorCode: 'E_TTS_ARG', dispatched: false };
  } catch { return { ok: false, errorCode: 'E_TTS_ARG', dispatched: false }; }
  base.protocol = base.protocol === 'http:' ? 'ws:' : 'wss:';
  base.pathname = eleven ? `${base.pathname.replace(/\/+$/, '')}/text-to-dialogue/stream-input` : '/api-ws/v1/inference';
  if (eleven) base.search = new URLSearchParams({ model_id: profile.model, output_format: codec! }).toString();
  const policyUrl = new URL(base); policyUrl.protocol = base.protocol === 'ws:' ? 'http:' : 'https:';
  let dispatcher: Dispatcher;
  try {
    const route = await new Promise<Awaited<ReturnType<typeof resolveProxyRouteForUrl>>>((resolve, reject) => {
      const abort = () => reject(new Error('aborted'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      resolveProxyRouteForUrl(policyUrl.href).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    if (signal.aborted) return { ok: false, errorCode: 'E_TTS_ABORTED', dispatched: false };
    if (route.kind === 'unsupported' || (route.kind === 'proxy' && !/^https?:\/\//i.test(route.url))) {
      return { ok: false, errorCode: 'E_TTS_PROXY', dispatched: false };
    }
    dispatcher = route.kind === 'proxy' ? new SpeechProxyAgent({ uri: route.url, connectTimeout: 30_000 })
      : new Agent({ connectTimeout: 30_000, webSocket: SOCKET_LIMITS });
  } catch {
    return { ok: false, errorCode: signal.aborted ? 'E_TTS_ABORTED' : 'E_TTS_PROXY', dispatched: false };
  }

  return new Promise<NativeSpeechAudio>(resolve => {
    let socket: WebSocket;
    let done = false;
    let dispatched = false;
    let started = false;
    let messages = 0;
    let wireBytes = 0;
    let audioBytes = 0;
    const chunks: Buffer[] = [];
    const taskId = randomUUID();
    const finish = (result: NativeSpeechAudio) => {
      if (done) return;
      done = true; signal.removeEventListener('abort', abort);
      try { socket?.close(); } catch { /* Handshake may still be pending. */ }
      void dispatcher.destroy().catch(() => {});
      resolve(result);
    };
    const fail = (code = 'E_TTS_API_ERROR') => finish({ ok: false, errorCode: code, dispatched });
    const abort = () => fail(params.signal?.aborted ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK');
    const append = (chunk: Buffer) => {
      if (!chunk.length || chunk.length > MAX_AUDIO_BYTES - audioBytes) { fail('E_TTS_TOO_LARGE'); return; }
      audioBytes += chunk.length; chunks.push(chunk);
    };
    const send = (value: unknown) => { dispatched = true; socket.send(JSON.stringify(value)); };
    const command = (action: string, payload: unknown) => send({ header: { action, task_id: taskId, streaming: 'duplex' }, payload });
    try {
      socket = new WebSocket(base, { dispatcher, headers: eleven
        ? { 'xi-api-key': profile.apiKey } : { Authorization: `Bearer ${profile.apiKey}` } });
      socket.binaryType = 'arraybuffer';
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      socket.onopen = () => {
        if (done) return;
        try {
          if (eleven) {
            send({ voices: [params.voice] });
            send({ inputs: [{ text: params.text, voice_id: params.voice }], close_socket: true });
          } else {
            command('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: profile.model,
              parameters: { text_type: 'PlainText', voice: params.voice, format, sample_rate: 24000, rate: params.speed ?? 1 }, input: {} });
          }
        } catch { fail('E_TTS_NETWORK'); }
      };
      socket.onmessage = event => {
        if (done) return;
        try {
          const size = typeof event.data === 'string' ? Buffer.byteLength(event.data) : event.data.byteLength;
          if (++messages > 20000 || (wireBytes += size) > MAX_AUDIO_BYTES * 3) { fail('E_TTS_TOO_LARGE'); return; }
          if (typeof event.data !== 'string') {
            if (eleven || !started) { fail(); return; }
            append(Buffer.from(event.data)); return;
          }
          const frame = JSON.parse(event.data);
          if (eleven) {
            if (frame.error || frame.error_code || frame.message) { fail(); return; }
            if (frame.audio) {
              const audio = decodeSpeechBase64(frame.audio);
              if (!audio) { fail('E_TTS_INVALID_AUDIO'); return; }
              append(audio);
            }
            if (frame.is_final === true) finish(audioBytes ? { ok: true, audio: Buffer.concat(chunks, audioBytes) }
              : { ok: false, errorCode: 'E_TTS_EMPTY', dispatched });
            return;
          }
          if (frame.header?.task_id !== taskId) { fail(); return; }
          const eventName = frame.header.event;
          if (eventName === 'task-started' && !started) {
            started = true;
            command('continue-task', { input: { text: params.text } });
            command('finish-task', { input: {} });
          } else if (eventName === 'task-finished' && started && audioBytes) {
            finish({ ok: true, audio: Buffer.concat(chunks, audioBytes) });
          } else if (eventName !== 'result-generated') fail();
        } catch { fail('E_TTS_INVALID_AUDIO'); }
      };
      socket.onerror = () => fail('E_TTS_NETWORK');
      socket.onclose = () => { if (!done) fail('E_TTS_INCOMPLETE'); };
    } catch { fail('E_TTS_NETWORK'); }
  });
}
