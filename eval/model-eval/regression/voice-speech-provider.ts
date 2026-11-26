import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
export interface SpeechRequest { text: string; voice: string; format: string; speed?: number; }
const keys = ['ORKAS_TTS_BASE_URL', 'ORKAS_TTS_API_KEY', 'ORKAS_TTS_MODEL', 'ORKAS_TTS_VOICE', 'ORKAS_TTS_FORMAT'] as const;
/** Loopback fixture at the real HTTP boundary, never a model/tool response stub. */
export async function startVoiceSpeechProvider(audio: Record<string, Buffer>, voice = 'en_fixture_reader') {
  const requests: SpeechRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/audio/speech') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 64000) req.destroy(); else chunks.push(Buffer.from(chunk)); });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const r: SpeechRequest = { text: String(body.input || '').trim(), voice: String(body.voice || ''), format: String(body.response_format || ''), ...(body.speed !== undefined ? { speed: body.speed } : {}) };
        requests.push(r);
        if (requests.length > Object.keys(audio).length || requests.filter(previous => previous.text === r.text).length > 1 || !Object.hasOwn(audio, r.text) || r.voice !== voice || r.format !== 'wav') { res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"Unexpected fixture request"}'); return; }
        res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(audio[r.text]);
      } catch { res.writeHead(400).end(); }
    });
  });
  server.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { ORKAS_TTS_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, ORKAS_TTS_API_KEY: 'local-eval-only', ORKAS_TTS_MODEL: 'local-speech-fixture', ORKAS_TTS_VOICE: voice, ORKAS_TTS_FORMAT: 'wav' });
  return {
    requests,
    snapshot: () => ({
      local: true,
      billingRoute: 'configured-own-account-fixture' as const,
      requests: requests.length,
      fulfilled: requests.length === Object.keys(audio).length && Object.keys(audio).every(text =>
        requests.filter(r => r.text === text && r.voice === voice && r.format === 'wav' && (r.speed === undefined || r.speed === 1)).length === 1),
    }),
    close: async () => {
      for (const k of keys) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
