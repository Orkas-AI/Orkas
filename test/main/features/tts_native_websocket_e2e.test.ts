import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

const state = vi.hoisted(() => ({ profiles: [] as any[], route: { kind: 'direct' } as any }));
vi.mock('../../../src/main/features/tts_auth', async original => ({
  ...await original<any>(), listUsableTtsProfiles: () => state.profiles,
}));
vi.mock('../../../src/main/util/proxy-dispatcher', () => ({ resolveProxyRouteForUrl: async () => state.route }));
vi.mock('../../../src/main/util/media_probe', () => ({ probeMediaDurationSec: async () => null }));
import { generateSpeech } from '../../../src/main/features/tts';

let root: string;
let server: WebSocketServer;
let prior: string | undefined;
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'tts-ws-'));
  prior = process.env.ORKAS_TTS_BASE_URL; delete process.env.ORKAS_TTS_BASE_URL;
  state.route = { kind: 'direct' };
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
});
afterEach(async () => {
  for (const client of server.clients) client.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (prior === undefined) delete process.env.ORKAS_TTS_BASE_URL; else process.env.ORKAS_TTS_BASE_URL = prior;
  rmSync(root, { recursive: true, force: true });
});
function select(provider: string, model: string) {
  const address = server.address() as { port: number };
  state.profiles = [{ id: 'native-ws', provider, model, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-key', voice: 'enrolled-voice', format: 'mp3' }];
}
const request = (signal?: AbortSignal, speed?: number, format = 'mp3', text = 'The full narration.') => generateSpeech({ text,
  outputAbsPath: path.join(root, `voice.${format}`), signal, speed, format });

it.each(['cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus'])('runs %s with task identity, start acknowledgement and finish before saving', async model => {
  select('aliyun', model);
  const received: any[] = [];
  server.on('connection', (socket, req) => {
    expect(req.url).toBe('/api-ws/v1/inference'); expect(req.headers.authorization).toBe('Bearer fixture-key');
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); received.push(frame);
      if (frame.header.action === 'run-task') {
        expect(frame.payload).toMatchObject({ model, task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer',
          parameters: { voice: 'enrolled-voice', text_type: 'PlainText', format: 'mp3', sample_rate: 24000, rate: 1.1 }, input: {} });
        socket.send(JSON.stringify({ header: { event: 'task-started', task_id: frame.header.task_id } }));
      } else if (frame.header.action === 'finish-task') {
        socket.send(Buffer.from('ID3 fixture audio'));
        socket.send(JSON.stringify({ header: { event: 'task-finished', task_id: frame.header.task_id } }));
      }
    });
  });
  expect(await request(undefined, 1.1)).toMatchObject({ ok: true, backend: 'aliyun' });
  expect(received.map(frame => frame.header.action)).toEqual(['run-task', 'continue-task', 'finish-task']);
  expect(new Set(received.map(frame => frame.header.task_id)).size).toBe(1);
  expect(received[1].payload.input.text).toBe('The full narration.');
  expect(readFileSync(path.join(root, 'voice.mp3')).toString()).toBe('ID3 fixture audio');
});

it('uses Eleven v4 Turbo dialogue registration, transcript and terminal frame', async () => {
  select('elevenlabs', 'eleven_v4_turbo'); const received: any[] = [];
  server.on('connection', (socket, req) => {
    expect(req.url).toBe('/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=mp3_44100_128');
    expect(req.headers['xi-api-key']).toBe('fixture-key');
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); received.push(frame);
      if (frame.close_socket) {
        socket.send(JSON.stringify({ audio: Buffer.from('ID3 turbo audio').toString('base64') }));
        socket.send(JSON.stringify({ is_final: true }));
      }
    });
  });
  expect(await request()).toMatchObject({ ok: true, backend: 'elevenlabs' });
  expect(received).toEqual([{ voices: ['enrolled-voice'] },
    { inputs: [{ text: 'The full narration.', voice_id: 'enrolled-voice' }], close_socket: true }]);
  expect(readFileSync(path.join(root, 'voice.mp3')).toString()).toBe('ID3 turbo audio');
});

it.each(['early-close', 'task-failed', 'wrong-task', 'invalid-json', 'empty-finish'])('does not save or replay an interrupted CosyVoice task (%s)', async failure => {
  select('aliyun', 'cosyvoice-v3.5-plus'); let connections = 0;
  server.on('connection', socket => {
    connections++;
    socket.once('message', raw => {
      const { header } = JSON.parse(raw.toString());
      if (failure === 'early-close') { socket.send(Buffer.from('partial')); socket.close(); }
      else if (failure === 'invalid-json') socket.send('{broken');
      else socket.send(JSON.stringify({ header: { task_id: failure === 'wrong-task' ? 'other-task' : header.task_id,
        event: failure === 'task-failed' ? 'task-failed' : 'task-finished', error_message: 'private error' } }));
    });
  });
  const result = await request();
  expect(result).toMatchObject({ ok: false, requestDisposition: 'sent', chargeStatus: 'unknown' });
  expect(JSON.stringify(result)).not.toContain('private error'); expect(connections).toBe(1);
  expect(existsSync(path.join(root, 'voice.mp3'))).toBe(false);
});

it('fails closed when the system proxy cannot be used for WebSocket', async () => {
  select('aliyun', 'cosyvoice-v3.5-plus'); state.route = { kind: 'unsupported', value: 'PAC' };
  let connections = 0; server.on('connection', () => connections++);
  expect(await request()).toMatchObject({ ok: false, requestDisposition: 'not_sent', chargeStatus: 'not_charged' });
  expect(connections).toBe(0);
});

it('honors the resolved HTTP CONNECT proxy instead of connecting directly', async () => {
  select('elevenlabs', 'eleven_v4_turbo'); let tunnels = 0;
  const proxy = createServer();
  const sockets = new Set<import('node:net').Socket>();
  proxy.on('connect', (req, client, head) => {
    tunnels++;
    const [host, port] = req.url!.split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); sockets.add(client);
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  state.route = { kind: 'proxy', url: `http://127.0.0.1:${(proxy.address() as any).port}` };
  server.on('connection', socket => socket.on('message', raw => {
    if (JSON.parse(raw.toString()).close_socket) {
      socket.send(JSON.stringify({ audio: Buffer.from('ID3 proxied').toString('base64') }));
      socket.send(JSON.stringify({ is_final: true }));
    }
  }));
  try {
    expect(await request()).toMatchObject({ ok: true, backend: 'elevenlabs' }); expect(tunnels).toBe(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

it('cancels an open task without persisting partial audio or reconnecting', async () => {
  select('aliyun', 'cosyvoice-v3.5-plus'); const controller = new AbortController();
  let connections = 0;
  server.on('connection', socket => { connections++; socket.once('message', () => { socket.send(Buffer.from('partial')); controller.abort(); }); });
  expect(await request(controller.signal)).toMatchObject({ ok: false, errorCode: 'E_TTS_ABORTED', chargeStatus: 'unknown' });
  expect(connections).toBe(1); expect(existsSync(path.join(root, 'voice.mp3'))).toBe(false);
});

it('closes an oversized WebSocket message without accepting partial output', async () => {
  select('elevenlabs', 'eleven_v4_turbo'); let connections = 0;
  server.on('connection', socket => {
    connections++;
    socket.once('message', () => socket.send('x'.repeat(2 * 1024 * 1024 + 1)));
  });
  expect(await request()).toMatchObject({ ok: false, requestDisposition: 'sent', chargeStatus: 'unknown' });
  expect(connections).toBe(1); expect(existsSync(path.join(root, 'voice.mp3'))).toBe(false);
});

it.each(['cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus', 'eleven_v4_turbo'].flatMap(model =>
  ['wav', 'pcm', 'opus'].map(format => [model, format])))('%s delivers native %s through the correct socket protocol', async (model, format) => {
  const eleven = model === 'eleven_v4_turbo'; select(eleven ? 'elevenlabs' : 'aliyun', model);
  const pcm = Buffer.alloc(4800);
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const wav = Buffer.concat([header, pcm]);
  const nativeAudio = format === 'opus' ? Buffer.from('OggS native fixture') : !eleven && format === 'wav' ? wav : pcm;
  const sent: any[] = [];
  server.on('connection', (socket, req) => {
    if (eleven) {
      const query = new URL(req.url!, 'http://fixture').searchParams;
      expect(query.get('output_format')).toBe(format === 'opus' ? 'opus_48000_128' : 'pcm_24000');
    }
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); sent.push(frame);
      if (eleven && frame.close_socket) {
        socket.send(JSON.stringify({ audio: nativeAudio.toString('base64') })); socket.send(JSON.stringify({ is_final: true }));
      } else if (!eleven && frame.header.action === 'run-task') {
        expect(frame.payload.parameters).toMatchObject({ format, sample_rate: 24000, rate: 1 });
        socket.send(JSON.stringify({ header: { task_id: frame.header.task_id, event: 'task-started' } }));
      } else if (!eleven && frame.header.action === 'finish-task') {
        socket.send(nativeAudio); socket.send(JSON.stringify({ header: { task_id: frame.header.task_id, event: 'task-finished' } }));
      }
    });
  });
  expect(await request(undefined, 1, format)).toMatchObject({ ok: true });
  expect(readFileSync(path.join(root, `voice.${format}`))).toEqual(eleven && format === 'wav' ? wav : nativeAudio);
  if (eleven) expect(sent).toEqual([{ voices: ['enrolled-voice'] }, { inputs: [{ text: 'The full narration.', voice_id: 'enrolled-voice' }], close_socket: true }]);
});

it.each([['aliyun', 'cosyvoice-v3.5-flash', 0.49], ['aliyun', 'cosyvoice-v3.5-plus', 2.01],
  ['elevenlabs', 'eleven_v4_turbo', 1.1]])('%s %s rejects unsupported speed %s before opening a socket', async (provider, model, speed) => {
  select(String(provider), String(model)); let connections = 0; server.on('connection', () => connections++);
  expect(await request(undefined, Number(speed))).toMatchObject({ ok: false, requestDisposition: 'rejected_preflight', chargeStatus: 'not_charged' });
  expect(connections).toBe(0); expect(existsSync(path.join(root, 'voice.mp3'))).toBe(false);
});

it.each([['aliyun', 'cosyvoice-v3.5-plus', 20000], ['elevenlabs', 'eleven_v4_turbo', 10000]])('%s %s rejects oversized transcripts before opening a socket', async (provider, model, limit) => {
  select(String(provider), String(model)); let connections = 0; server.on('connection', () => connections++);
  expect(await request(undefined, undefined, 'mp3', 'a'.repeat(Number(limit) + 1))).toMatchObject({ ok: false, chargeStatus: 'not_charged' });
  expect(connections).toBe(0);
});

it.each([['aliyun', 'cosyvoice-v3.5-plus', 20000, 0.5], ['elevenlabs', 'eleven_v4_turbo', 10000, 1]])('%s %s preserves a maximum-length transcript', async (provider, model, limit, speed) => {
  const eleven = provider === 'elevenlabs'; select(String(provider), String(model));
  const text = 'a'.repeat(Number(limit)); let receivedText = '';
  server.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(raw.toString());
    if (eleven && frame.inputs) {
      receivedText = frame.inputs[0].text;
      socket.send(JSON.stringify({ audio: Buffer.from('ID3 complete').toString('base64') })); socket.send(JSON.stringify({ is_final: true }));
    } else if (!eleven && frame.header.action === 'run-task') {
      expect(frame.payload.parameters.rate).toBe(0.5);
      socket.send(JSON.stringify({ header: { task_id: frame.header.task_id, event: 'task-started' } }));
    } else if (!eleven && frame.header.action === 'continue-task') receivedText = frame.payload.input.text;
    else if (!eleven && frame.header.action === 'finish-task') {
      socket.send(Buffer.from('ID3 complete')); socket.send(JSON.stringify({ header: { task_id: frame.header.task_id, event: 'task-finished' } }));
    }
  }));
  expect(await request(undefined, Number(speed), 'mp3', text)).toMatchObject({ ok: true });
  expect(receivedText).toBe(text);
});
