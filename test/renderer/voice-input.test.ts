import { composerAccessorSource } from './composer-test-source';
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';

function makeButton(id: string) {
  const listeners: Record<string, Function> = {};
  const classes = new Set<string>();
  return {
    id,
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    title: '',
    classList: {
      contains(name: string) { return classes.has(name); },
      toggle(name: string, active: boolean) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
    },
    parentNode: { insertBefore: vi.fn() },
    setAttribute: vi.fn(),
    addEventListener(name: string, handler: Function) { listeners[name] = handler; },
    click() { return listeners.click?.(); },
  };
}

function makeTextarea() {
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange() {},
    dispatchEvent() {},
    addEventListener() {},
    getClientRects: () => [1],
    focus() {},
  };
}

function loadVoiceInput(voice: any, _unused?: undefined, options: {
  sourcePath?: string;
  globals?: Record<string, unknown>;
} = {}) {
  const alerts: string[] = [];
  const windowEvents: Record<string, Function> = {};
  const documentEvents: Record<string, Function> = {};
  const english = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
  const windowObject: any = {
    orkas: { voiceInput: voice },
    addEventListener: (name: string, fn: Function) => { windowEvents[name] = fn; },
    alert(message: string) { alerts.push(String(message)); },
  };
  const context: any = {
    console,
    window: windowObject,
    document: { addEventListener: (name: string, fn: Function) => { documentEvents[name] = fn; }, getElementById: () => null, hidden: false },
    t: (key: string) => english[key] || key,
    uiAlert: (message: string) => { alerts.push(String(message)); },
    uiChoice: vi.fn(async () => null), uiConfirm: vi.fn(), uiToast: vi.fn(),
    setInterval, clearInterval,
    navigator: {},
    composerInsertion: () => ({ valid: () => true, replace: () => true, dispose() {} }),
    setTimeout,
    clearTimeout,
    URL,
    Date,
    Math,
    Event: class {},
    ...options.globals,
  };
  windowObject.window = windowObject;
  vm.createContext(context);
  vm.runInContext(composerAccessorSource, context);
  const source = fs.readFileSync(options.sourcePath || path.join(__dirname, '../../src/renderer/modules/voice-input.js'), 'utf8');
  vm.runInContext(source, context);
  return { context, alerts, windowEvents, documentEvents };
}

function installAudioCaptureStub(context: any) {
  const node = () => ({ connect() {}, disconnect() {} });
  const captures: any[] = [];
  context.window.AudioContext = class {
    state = 'running';
    sampleRate = 48_000;
    destination = {};
    createMediaStreamSource() { return node(); }
    createScriptProcessor() {
      const capture = { ...node(), onaudioprocess: null };
      captures.push(capture);
      return capture;
    }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    close() { return Promise.resolve(); }
  };
  return captures;
}

function loadCompressedCapture(sourcePath: string, failCompression = false) {
  let releaseFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let compressions = 0;
  // Driver completion is controlled; compression bytes use real gzip. This
  // exercises capture -> production transport -> wire without a microphone.
  class Compression {
    constructor(_format: string) {
      if (failCompression) throw new Error('synthetic gzip failure');
    }
  }
  class AudioBlob {
    constructor(private parts: Uint8Array[]) {}
    stream() {
      return {
        pipeThrough: () => gzipSync(Buffer.concat(this.parts.map((part) => Buffer.from(part)))),
      };
    }
  }
  class AudioResponse {
    constructor(private bytes: Buffer) {}
    async arrayBuffer() {
      if (++compressions === 1) await first;
      return Uint8Array.from(this.bytes).buffer;
    }
  }
  const { context } = loadVoiceInput({}, undefined, {
    sourcePath,
    globals: { CompressionStream: Compression, DecompressionStream: class {}, Blob: AudioBlob, Response: AudioResponse },
  });
  const sockets: any[] = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = Socket.CONNECTING;
    frames: (Buffer | string)[] = [];
    onopen?: () => void;
    onmessage?: (event: any) => void;
    onclose?: () => void;
    constructor(readonly url: string) { sockets.push(this); }
    open(ready = true) { this.readyState = Socket.OPEN; this.onopen?.(); if (ready) this.ready(); }
    ready() { this.onmessage?.({ data: '{"event":"ready"}' }); }
    send(value: Uint8Array | string) {
      if (this.readyState !== Socket.OPEN) throw new Error('socket is closed');
      this.frames.push(typeof value === 'string' ? value : Buffer.from(value));
    }
    close() { this.readyState = Socket.CLOSED; this.onclose?.(); }
  }
  context.WebSocket = Socket;
  context.setTimeout = () => 1;
  context.navigator.mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  };
  const captures = installAudioCaptureStub(context);
  const errors: Error[] = [];
  const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
    onError: (error: Error) => errors.push(error),
  });
  const capture = (sample: number) => captures.at(-1).onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array([sample, sample, sample]) },
  });
  const decode = (frames: (Buffer | string)[]) => frames.map((value) => (
    typeof value === 'string' ? value : Array.from(gunzipSync(value))
  ));
  return { client, sockets, errors, capture, decode, releaseFirst };
}

function loadWorkletCapture(sourcePath: string, options: {
  delayedModule?: boolean;
  delayedPermission?: boolean;
  dropFlush?: boolean;
  resumeFails?: boolean;
} = {}) {
  const modules = new Map<string, string>();
  let releaseModule: () => void = () => {};
  const moduleGate = new Promise<void>((resolve) => { releaseModule = resolve; });
  let grantPermission: (value: any) => void = () => {};
  const permission = new Promise((resolve) => { grantPermission = resolve; });
  class WorkletBlob {
    constructor(readonly parts: string[]) {}
  }
  class WorkletURL extends URL {
    static createObjectURL(blob: WorkletBlob) {
      const url = `blob:worklet-${modules.size}`;
      modules.set(url, blob.parts.join(''));
      return url;
    }
    static revokeObjectURL(_url: string) {}
  }
  const { context } = loadVoiceInput({}, undefined, {
    sourcePath, globals: { Blob: WorkletBlob, URL: WorkletURL },
  });
  const nodes: any[] = [];
  const sockets: any[] = [];
  const timers = new Map<number, { callback: () => void; delay: number; dueAt: number }>();
  let elapsed = 0;
  let timerId = 0;
  let tracksStopped = 0;
  let Processor: any;
  let channel: any;
  class WorkletNode {
    port = {
      onmessage: null as any,
      postMessage: (data: any) => {
        if (options.dropFlush && data.flush) return;
        queueMicrotask(() => this.processor.port.onmessage?.({ data }));
      },
    };
    processor: any;
    constructor() {
      channel = this.port;
      this.processor = new Processor();
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
  }
  class CaptureContext {
    state = options.resumeFails ? 'suspended' : 'running';
    resume() { return Promise.reject(new Error('audio_resume_failed')); }
    sampleRate = 16_000;
    destination = {};
    audioWorklet = {
      addModule: async (url: string) => {
        if (options.delayedModule) await moduleGate;
        const source = modules.get(url);
        if (!source) throw new Error('missing owned worklet module');
        vm.runInNewContext(source, {
          AudioWorkletProcessor: class {
            port: any;
            constructor() {
              const owner = channel;
              // Resolve the node's port when it is constructed, after module
              // registration. Production processor messages remain unchanged.
              this.port = {
                onmessage: null,
                postMessage: (data: any) => queueMicrotask(() => owner.onmessage?.({ data })),
              };
            }
          },
          registerProcessor: (_name: string, implementation: any) => { Processor = implementation; },
        });
      },
    };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    close() { return Promise.resolve(); }
  }
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = Socket.CONNECTING;
    frames: (Buffer | string)[] = [];
    onopen?: () => void;
    onmessage?: (event: any) => void;
    onclose?: () => void;
    constructor(_url: string) { sockets.push(this); }
    open(ready = true) { this.readyState = Socket.OPEN; this.onopen?.(); if (ready) this.ready(); }
    ready() { this.onmessage?.({ data: '{"event":"ready"}' }); }
    send(value: Uint8Array | string) {
      this.frames.push(typeof value === 'string' ? value : Buffer.from(value));
    }
    close() { this.readyState = Socket.CLOSED; this.onclose?.(); }
  }
  const stream = { getTracks: () => [{ stop: () => { tracksStopped++; } }] };
  context.WebSocket = Socket;
  context.AudioWorkletNode = WorkletNode;
  context.window.AudioWorkletNode = WorkletNode;
  context.window.AudioContext = CaptureContext;
  context.navigator.mediaDevices = {
    getUserMedia: () => options.delayedPermission ? permission : Promise.resolve(stream),
  };
  context.setTimeout = (callback: () => void, delay: number) => {
    timers.set(++timerId, { callback, delay, dueAt: elapsed + delay });
    return timerId;
  };
  context.clearTimeout = (id: number) => timers.delete(id);
  const errors: Error[] = [];
  const opened: boolean[] = [];
  const results: Array<{ text: string; last: boolean }> = [];
  const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
    onOpen: () => opened.push(true),
    onError: (error: Error) => errors.push(error),
    onResult: (result: { text: string; last: boolean }) => results.push(result),
  });
  const advanceTime = (ms: number) => {
    const target = elapsed + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
      if (!next) break;
      elapsed = next[1].dueAt;
      timers.delete(next[0]);
      next[1].callback();
    }
    elapsed = target;
  };
  const processSamples = (count: number) => {
    for (let offset = 0; offset < count; offset += 128) {
      nodes.at(-1).processor.process(
        [[new Float32Array(Math.min(128, count - offset)).fill(0.25)]],
        [[new Float32Array(128)]],
      );
    }
  };
  return {
    client, nodes, sockets, errors, opened, results, timers, advanceTime, processSamples, releaseModule,
    grantPermission: () => grantPermission(stream),
    tracksStopped: () => tracksStopped,
  };
}

function loadDelayedTranscript(sourcePath: string) {
  let releaseFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let decodes = 0;
  let tracksStopped = 0;
  class Compression {}
  class Decompression {}
  class IncomingBlob {
    constructor(private parts: Uint8Array[]) {}
    stream() {
      return { pipeThrough: (codec: any) => {
        const input = Buffer.concat(this.parts.map((part) => Buffer.from(part)));
        const incoming = codec instanceof Decompression;
        return { incoming, bytes: incoming ? gunzipSync(input) : gzipSync(input) };
      } };
    }
  }
  class IncomingResponse {
    constructor(private payload: { incoming: boolean; bytes: Buffer }) {}
    async arrayBuffer() {
      if (this.payload.incoming && ++decodes === 1) await first;
      return Uint8Array.from(this.payload.bytes).buffer;
    }
  }
  const { context } = loadVoiceInput({}, undefined, {
    sourcePath,
    globals: {
      CompressionStream: Compression, DecompressionStream: Decompression,
      Blob: IncomingBlob, Response: IncomingResponse, TextDecoder,
    },
  });
  const sockets: any[] = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = Socket.CONNECTING;
    onopen?: () => void;
    onmessage?: (event: any) => void;
    onclose?: (event: any) => void;
    constructor(_url: string) { sockets.push(this); }
    open(ready = true) { this.readyState = Socket.OPEN; this.onopen?.(); if (ready) this.ready(); }
    ready() { this.onmessage?.({ data: '{"event":"ready"}' }); }
    receive(text: string, terminal = false) {
      const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text } })));
      const frame = Buffer.alloc(12 + payload.length);
      frame.set([0x11, terminal ? 0x93 : 0x91, 0x11, 0]);
      frame.writeInt32BE(terminal ? -2 : 1, 4);
      frame.writeUInt32BE(payload.length, 8);
      payload.copy(frame, 12);
      this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) });
    }
    send() {}
    close() {
      this.readyState = Socket.CLOSED;
      this.onclose?.({ code: 1000, reason: '', wasClean: true });
    }
  }
  context.WebSocket = Socket;
  context.navigator.mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => { tracksStopped++; } }] }),
  };
  installAudioCaptureStub(context);
  const timeline: any[] = [];
  const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
    onResult: ({ text, last }: { text: string; last: boolean }) => timeline.push(['result', text, last]),
    onClose: () => timeline.push(['close']),
    onError: (error: Error) => timeline.push(['error', error.message]),
  });
  return { client, sockets, timeline, releaseFirst, tracksStopped: () => tracksStopped };
}

describe.each([
  ['desktop', path.join(__dirname, '../../src/renderer/modules/voice-input.js')],
])('%s compressed transcript ordering', (_platform, sourcePath) => {
  it('delivers partial then terminal text in wire order despite different decode completion times', async () => {
    const fixture = loadDelayedTranscript(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.sockets[0].receive('partial');
    fixture.sockets[0].receive('terminal', true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const whileFirstPending = [...fixture.timeline];
    fixture.releaseFirst();
    await vi.waitFor(() => expect(fixture.timeline).toHaveLength(2));
    expect(whileFirstPending).toEqual([]);
    expect(fixture.timeline).toEqual([['result', 'partial', false], ['result', 'terminal', true]]);
    fixture.client.close();
  });

  it.each([false, true])('delivers terminal before natural close with immediate device release (stopped=%s)', async (stopped) => {
    const fixture = loadDelayedTranscript(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    if (stopped) {
      fixture.client.stop();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    fixture.sockets[0].receive('terminal', true);
    fixture.sockets[0].close(); // The peer closes after sending its final frame.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const whilePending = [...fixture.timeline];
    expect(fixture.tracksStopped()).toBe(1);
    fixture.releaseFirst();
    await vi.waitFor(() => expect(fixture.timeline).toHaveLength(2));
    expect(whilePending).toEqual([]);
    expect(fixture.timeline).toEqual([['result', 'terminal', true], ['close']]);
  });

  it('starts a new recognition without reusing the previous connection transcript', async () => {
    const fixture = loadDelayedTranscript(sourcePath);
    fixture.releaseFirst();
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.sockets[0].receive('previous recognition', true);
    await vi.waitFor(() => expect(fixture.timeline).toContainEqual(['result', 'previous recognition', true]));
    fixture.client.close();
    await fixture.client.start();
    fixture.sockets[1].open();
    fixture.sockets[1].receive('', true);
    await vi.waitFor(() => expect(fixture.timeline).toHaveLength(3));
    expect(fixture.timeline[2]).toEqual(['result', '', true]);
    fixture.client.close();
  });

  it('discards an explicitly cancelled decode without blocking a replacement connection', async () => {
    const fixture = loadDelayedTranscript(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.sockets[0].receive('cancelled terminal', true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.client.close();
    await fixture.client.start();
    fixture.sockets[1].open();
    fixture.sockets[1].receive('new terminal', true);
    await vi.waitFor(() => expect(fixture.timeline).toContainEqual(['result', 'new terminal', true]));
    fixture.releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.timeline).toEqual([['close'], ['result', 'new terminal', true]]);
    fixture.client.close();
  });
});

describe.each([
  ['desktop', path.join(__dirname, '../../src/renderer/modules/voice-input.js')],
])('%s worklet capture ownership', (_platform, sourcePath) => {
  it.each(['handshake', 'capture initialization'])('bounds stalled %s and ignores its late completion', async (stage) => {
    const fixture = loadWorkletCapture(sourcePath, { delayedModule: stage === 'capture initialization' });
    await fixture.client.start();
    // Public ticket peers must send ready before capture initialization begins.
    if (stage === 'capture initialization') fixture.sockets[0].open();
    await new Promise<void>(resolve => setImmediate(resolve));
    fixture.advanceTime(59_999);
    expect(fixture.errors).toEqual([]);
    expect(fixture.tracksStopped()).toBe(0);
    fixture.advanceTime(1);
    fixture.sockets[0].open();
    fixture.releaseModule();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.opened).toEqual([]);
    expect(fixture.nodes).toEqual([]);
    expect(fixture.errors.map(error => (error as Error & { code: string }).code)).toEqual(['network']);
    expect(fixture.tracksStopped()).toBe(1);
    expect(fixture.sockets[0].readyState).toBe(3);
    expect(fixture.timers.size).toBe(0);
    fixture.client.close();
  });

  it('retains a final transcript arriving two seconds after stop and clears its deadline', async () => {
    const fixture = loadWorkletCapture(sourcePath);
    await fixture.client.start(); fixture.sockets[0].open(false);
    expect(fixture.opened).toEqual([]);
    fixture.sockets[0].ready();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.opened).toEqual([true]);
    fixture.processSamples(128);
    fixture.client.stop();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.sockets[0].frames.at(-1)).toBe('__END__');
    fixture.advanceTime(2000);
    expect(fixture.sockets[0].readyState).toBe(1);
    fixture.sockets[0].onmessage({ data: JSON.stringify({
      is_last_package: true, payload_msg: { result: { text: 'The final words survive.' } },
    }) });
    expect(fixture.results).toEqual([{ text: 'The final words survive.', last: true }]);
    expect(fixture.errors).toEqual([]);
    expect(fixture.tracksStopped()).toBe(1);
    expect(fixture.timers.size).toBe(0);
  });

  it('bounds the remote final-response wait without leaving a live microphone or socket', async () => {
    const fixture = loadWorkletCapture(sourcePath);
    await fixture.client.start(); fixture.sockets[0].open();
    await new Promise<void>(resolve => setImmediate(resolve));
    fixture.client.stop();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.sockets[0].frames.at(-1)).toBe('__END__');
    fixture.advanceTime(9999);
    expect(fixture.sockets[0].readyState).toBe(1);
    fixture.advanceTime(1);
    expect(fixture.sockets[0].readyState).toBe(3);
    expect(fixture.tracksStopped()).toBe(1);
    expect(fixture.results).toEqual([]);
    expect(fixture.errors).toEqual([]);
    expect(fixture.timers.size).toBe(0);
  });

  it('flushes the final partial 200ms packet before END and releases the microphone immediately', async () => {
    const fixture = loadWorkletCapture(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.nodes).toHaveLength(1);
    fixture.processSamples(3840); // Independently specified 240ms at16kHz.
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.client.stop();
    expect(fixture.tracksStopped()).toBe(1);
    await vi.waitFor(() => expect(fixture.sockets[0].frames.at(-1)).toBe('__END__'));
    const pcm = Buffer.concat(fixture.sockets[0].frames.filter(Buffer.isBuffer));
    const expected = Buffer.alloc(7680);
    for (let offset = 0; offset < expected.length; offset += 2) expected.writeInt16LE(0x1fff, offset);
    expect(pcm.length).toBe(7680);
    expect(pcm).toEqual(expected);
    expect(fixture.errors).toEqual([]);
    fixture.client.close();
  });

  it('never announces recording if the audio device cannot resume', async () => {
    const fixture = loadWorkletCapture(sourcePath, { resumeFails: true });
    await fixture.client.start(); fixture.sockets[0].open();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.opened).toEqual([]);
    expect(fixture.nodes).toEqual([]);
    expect(fixture.errors.map(error => error.message)).toEqual(['audio_resume_failed']);
    fixture.client.close();
    expect(fixture.tracksStopped()).toBe(1);
  });

  it('announces recording only after the capture graph is ready', async () => {
    const fixture = loadWorkletCapture(sourcePath, { delayedModule: true });
    await fixture.client.start(); fixture.sockets[0].open();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.opened).toEqual([]);
    expect(fixture.nodes).toEqual([]);
    fixture.releaseModule();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.opened).toEqual([true]);
    expect(fixture.nodes).toHaveLength(1);
    fixture.client.close();
  });

  it('does not create capture resources after a pending worklet load is stopped', async () => {
    const fixture = loadWorkletCapture(sourcePath, { delayedModule: true });
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.client.stop();
    fixture.releaseModule();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.nodes).toEqual([]);
    expect(fixture.errors).toEqual([]);
    expect(fixture.tracksStopped()).toBe(1);
    fixture.client.close();
  });

  it('releases a late permission grant after close without opening a recording socket', async () => {
    const fixture = loadWorkletCapture(sourcePath, { delayedPermission: true });
    const starting = fixture.client.start();
    fixture.client.close();
    fixture.grantPermission();
    await starting;
    expect(fixture.sockets).toEqual([]);
    expect(fixture.tracksStopped()).toBe(1);
    expect(fixture.errors).toEqual([]);
  });

  it('reports incomplete capture instead of END when the processor never acknowledges flush', async () => {
    const fixture = loadWorkletCapture(sourcePath, { dropFlush: true });
    await fixture.client.start();
    fixture.sockets[0].open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.processSamples(128);
    fixture.client.stop();
    const deadline = [...fixture.timers.values()].find((timer) => timer.delay === 500);
    expect(deadline).toBeDefined();
    deadline!.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.sockets[0].frames).not.toContain('__END__');
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.errors[0].message).toBe('incomplete_capture');
    expect(fixture.tracksStopped()).toBe(1);
  });

  it('cancels a pending flush without a late END or an error after explicit close', async () => {
    const fixture = loadWorkletCapture(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.processSamples(128);
    fixture.client.stop();
    fixture.client.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.sockets[0].frames).not.toContain('__END__');
    expect(fixture.errors).toEqual([]);
    expect(fixture.tracksStopped()).toBe(1);
  });
});

describe.each([
  ['desktop', path.join(__dirname, '../../src/renderer/modules/voice-input.js')],
])('%s compressed audio transport', (_platform, sourcePath) => {
  it('keeps captured speech in order and sends END only after all accepted audio', async () => {
    const fixture = loadCompressedCapture(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.capture(0.25);
    fixture.capture(0.5);
    fixture.client.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const framesWhileFirstPending = [...fixture.sockets[0].frames];
    fixture.releaseFirst();
    await vi.waitFor(() => expect(fixture.sockets[0].frames).toHaveLength(4));

    expect(framesWhileFirstPending).toEqual([]);
    expect(fixture.decode(fixture.sockets[0].frames)).toEqual([
      [0xff, 0x1f], [0xff, 0x3f], [], '__END__',
    ]);
    expect(fixture.errors).toEqual([]);
    fixture.client.close();
  });

  it('discards compression owned by a closed socket without leaking it into a restarted connection', async () => {
    const fixture = loadCompressedCapture(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.capture(0.25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.client.close();
    await fixture.client.start();
    fixture.sockets[1].open();
    fixture.capture(0.5);
    await vi.waitFor(() => expect(fixture.sockets[1].frames).toHaveLength(1));
    fixture.releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.sockets[0].frames).toEqual([]);
    expect(fixture.decode(fixture.sockets[1].frames)).toEqual([[0xff, 0x3f]]);
    expect(fixture.errors).toEqual([]);
    fixture.client.close();
  });

  it('reports compression failure instead of sending raw PCM through a gzip connection', async () => {
    const fixture = loadCompressedCapture(sourcePath, true);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.capture(0.25);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.errors).toHaveLength(1);
    expect(fixture.errors[0].message).toBe('synthetic gzip failure');
    expect(fixture.sockets[0].frames).toEqual([]);
    fixture.client.close();
  });
});

describe('voice capture interruption', () => {
  it('does not start capture when the user stops while the socket is connecting', async () => {
    const stoppedTracks: string[] = [];
    const opened: string[] = [];
    const errors: string[] = [];
    let socket: any;
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FakeWebSocket.CONNECTING;
      binaryType = '';
      onopen: Function | null = null;
      onmessage: Function | null = null;
      onerror: Function | null = null;
      onclose: Function | null = null;

      constructor(_url: string) {
        socket = this;
      }

      send() {}

      close() {
        // Chromium emits an error when a CONNECTING socket is closed by the
        // client. It must remain an intentional cancellation to the UI.
        this.onerror?.({ type: 'error' });
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code: 1000, reason: '', wasClean: true });
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }
    }

    const { context } = loadVoiceInput({
      createSession: async () => ({ ok: true, url: 'wss://example.test/asr' }),
    });
    context.WebSocket = FakeWebSocket;
    context.navigator.mediaDevices = {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: () => stoppedTracks.push('stopped') }],
      }),
    };
    // The close fallback is irrelevant to this deterministic socket and
    // should not keep the test process alive.
    context.setTimeout = () => 1;

    const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
      onOpen: () => opened.push('opened'),
      onError: (error: Error) => errors.push(error.message),
    });
    await client.start();
    client.stop();
    socket.open();

    expect(opened).toEqual([]);
    expect(errors).toEqual([]);
    expect(stoppedTracks).toEqual(['stopped']);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('settles once and releases a late microphone grant after an early stop', async () => {
    let grantMicrophone: Function = () => {};
    const stoppedTracks: string[] = [];
    const closed: string[] = [];
    const { context } = loadVoiceInput({
      createSession: async () => ({ ok: true, url: 'wss://example.test/asr' }),
    });
    context.navigator.mediaDevices = {
      getUserMedia: () => new Promise((resolve) => { grantMicrophone = resolve; }),
    };
    context.setTimeout = () => 1;

    const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
      onClose: () => closed.push('closed'),
    });
    const starting = client.start();
    client.stop();
    grantMicrophone({
      getTracks: () => [{ stop: () => stoppedTracks.push('stopped') }],
    });
    await starting;

    expect(closed).toEqual(['closed']);
    expect(stoppedTracks).toEqual(['stopped']);
  });
});


// Controller tests keep ticket, microphone and socket boundaries deterministic;
// the capture/wire cases above own audio framing. No account or telemetry facade.
function controllerHarness(voiceOverrides: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const voice = {
    status: vi.fn(async () => ({ ok: true, configured: true })),
    createSession: vi.fn(async () => ({ ok: true, url: 'wss://example.test/asr?ticket=one-use' })),
    ensureMicrophoneAccess: vi.fn(async () => ({ ok: true, granted: true })),
    ...voiceOverrides,
  };
  const { context, alerts, windowEvents, documentEvents } = loadVoiceInput(voice, undefined, { globals });
  const sockets: any[] = [];
  const stopped = vi.fn();
  const send = vi.fn();
  const timers = new Map<number, Function>();
  let nextTimer = 0;
  context.setTimeout = (callback: Function) => { timers.set(++nextTimer, callback); return nextTimer; };
  context.clearTimeout = (id: number) => timers.delete(id);
  context.sendMessage = send;
  context.sendNewChat = send;
  const listeners: Record<string, Function> = {};
  const textarea = { ...makeTextarea(), value: 'Keep this draft', selectionStart: 15, selectionEnd: 15,
    addEventListener: (name: string, callback: Function) => { listeners[name] = callback; },
    dispatchEvent: vi.fn(),
  };
  let valid = true;
  const replacements: string[] = [];
  context.composerInsertion = () => {
    const from = textarea.selectionStart;
    let to = textarea.selectionEnd;
    let disposed = false;
    return {
      valid: () => valid && !disposed,
      replace(text: string) {
        if (!valid || disposed) return false;
        replacements.push(text);
        textarea.value = textarea.value.slice(0, from) + text + textarea.value.slice(to);
        to = from + text.length;
        return true;
      },
      dispose() { disposed = true; },
    };
  };
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    readyState = Socket.CONNECTING;
    onopen: Function | null = null; onmessage: Function | null = null;
    onerror: Function | null = null; onclose: Function | null = null;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = Socket.CLOSED; this.onclose?.({code:1000}); });
    constructor(readonly url: string) { sockets.push(this); }
    open(ready = true) { this.readyState = Socket.OPEN; this.onopen?.(); if (ready) this.ready(); }
    ready() { this.onmessage?.({ data: '{"event":"ready"}' }); }
    result(text: string, last = false) { this.onmessage?.({data:JSON.stringify({result:{text,last}})}); }
    error(reason: string) { this.onmessage?.({data:JSON.stringify({event:'error',reason})}); }
  }
  context.WebSocket = Socket;
  const capture = vi.fn(async () => ({getTracks: () => [{stop:stopped}]}));
  context.navigator.mediaDevices = {getUserMedia:capture};
  const captureNodes = installAudioCaptureStub(context);
  const button = makeButton('chat-mic-btn');
  context.window.VoiceInput.attach(button, textarea);
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const start = async () => { button.click(); await settle(); };
  const ownerChange = () => listeners['composer-owner-change']?.();
  return { context, voice, alerts, button, textarea, sockets, capture, stopped, send,
    replacements, captureNodes, timers, start, settle, ownerChange, windowEvents, documentEvents, invalidate: () => { valid = false; } };
}

describe('voice input controller ticket and composer ownership', () => {
  it('requests an API key without capturing audio or changing the draft', async () => {
    const h = controllerHarness({status:vi.fn(async () => ({ok:true,configured:false}))});
    await h.start();
    expect(h.context.uiChoice).toHaveBeenCalledWith(expect.objectContaining({ message: h.context.t('chat.mic_key_required') }));
    expect(h.voice.ensureMicrophoneAccess).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.sockets).toEqual([]);
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('honors microphone preflight denial before capture and leaves the draft editable', async () => {
    const h = controllerHarness({ensureMicrophoneAccess:vi.fn(async () => ({ok:false,granted:false}))});
    await h.start();
    expect(h.alerts).toEqual(['Microphone access was blocked. Allow it in your system settings to use voice input.']);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.sockets).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
  });

  it('reports rejected ticket requests without exposing server errors or consuming the draft', async () => {
    const h = controllerHarness({createSession:vi.fn(async () => { throw new Error('private-ticket-url-and-key'); })});
    await h.start();
    expect(h.alerts).toEqual(['Voice input is unavailable right now.']);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.captureNodes).toHaveLength(0);
    expect(h.sockets).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
  });

  it('cancels a pending ticket and permits a new attempt while the old response is outstanding', async () => {
    let resolveTicket: Function = () => {};
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveTicket = resolve; }))
      .mockResolvedValue({ok:true,url:'wss://example.test/asr?ticket=new'});
    const h = controllerHarness({createSession:request});
    await h.start();
    h.button.click();
    expect(h.button.dataset.voicePhase).toBe('idle');
    await h.start();
    expect(h.sockets).toHaveLength(1);
    resolveTicket({ok:true,url:'wss://example.test/asr?ticket=stale'});
    await h.settle();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toContain('ticket=new');
    expect(h.capture).toHaveBeenCalledTimes(2);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.captureNodes).toHaveLength(0);
    expect(h.button.dataset.voicePhase).toBe('connecting');
    expect(h.alerts).toEqual([]);
    h.ownerChange();
    expect(h.stopped).toHaveBeenCalledTimes(2);
  });

  it('abandons pending microphone preflight when the user stops', async () => {
    let allow: Function = () => {};
    const h = controllerHarness({ensureMicrophoneAccess:vi.fn(() => new Promise(resolve => {allow=resolve;}))});
    await h.start();
    h.button.click();
    allow({ok:true,granted:true});
    await h.settle();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.sockets).toEqual([]);
    expect(h.alerts).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
  });

  it('does not attach an outstanding ticket to a new composer owner', async () => {
    let resolveTicket: Function = () => {};
    const h = controllerHarness({createSession:vi.fn(() => new Promise(resolve => {resolveTicket=resolve;}))});
    await h.start();
    h.ownerChange();
    h.textarea.value = 'Other task draft';
    resolveTicket({ok:true,url:'wss://example.test/asr?ticket=stale'});
    await h.settle();
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.captureNodes).toHaveLength(0);
    expect(h.sockets).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Other task draft');
  });

  it('closes recording on owner changes and ignores late transcripts', async () => {
    const h = controllerHarness();
    await h.start();
    const socket = h.sockets[0]; socket.open();
    h.ownerChange();
    h.textarea.value = 'New owner draft';
    socket.result('stale transcript', true);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.replacements).toEqual([]);
    expect(h.textarea.value).toBe('New owner draft');
    expect(h.timers.size).toBe(0);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('ignores a prior socket close while a later attempt is connecting', async () => {
    const h = controllerHarness();
    await h.start();
    const old = h.sockets[0];
    h.button.click();
    await h.start();
    const current = h.sockets[1];
    old.onclose?.({code:1000});
    expect(h.button.dataset.voicePhase).toBe('connecting');
    expect(current.close).not.toHaveBeenCalled();
    expect(h.alerts).toEqual([]);
    current.open();
    expect(h.button.dataset.voicePhase).toBe('recording');
    h.ownerChange();
  });

  it('recovers from socket handshake failure with no raw ticket error in the UI', async () => {
    const h = controllerHarness();
    await h.start();
    h.sockets[0].onerror?.({type:'error',message:'private-ticket'});
    expect(h.alerts).toEqual(['Voice input is unavailable right now.']);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.sockets[0].close).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
  });

  it.each([['invalid_api_key','chat.mic_invalid_key'],
    ['insufficient_quota','chat.mic_insufficient_credits']])('keeps %s failures recoverable without sending', async (reason,message) => {
    const h = controllerHarness();
    await h.start(); h.sockets[0].open(); h.sockets[0].error(reason);
    expect(h.context.uiChoice).toHaveBeenCalledWith(expect.objectContaining({ message: h.context.t(message) }));
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.timers.size).toBe(0);
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('retains a partial transcript for review if the socket closes before a terminal result', async () => {
    const h = controllerHarness();
    await h.start(); const socket = h.sockets[0]; socket.open();
    socket.result('partial words');
    socket.close(); await h.settle();
    expect(h.textarea.value).toBe('Keep this draft partial words');
    expect(h.alerts).toEqual([h.context.t('chat.mic_incomplete')]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.textarea.dispatchEvent).not.toHaveBeenCalled();
  });

  it('replaces the owned transcript range and keeps final words for explicit send', async () => {
    const h = controllerHarness();
    await h.start(); const socket = h.sockets[0]; socket.open();
    socket.result('first words');
    h.button.click();
    expect(h.button.dataset.voicePhase).toBe('finalizing');
    socket.result('corrected final words',true); await h.settle();
    expect(h.textarea.value).toBe('Keep this draft corrected final words');
    expect(h.replacements).toEqual([' first words',' corrected final words']);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.textarea.dispatchEvent).not.toHaveBeenCalled();
    expect(h.alerts).toEqual([]);
  });

  it('does not overwrite a range invalidated by an intervening user edit', async () => {
    const h = controllerHarness();
    await h.start(); const socket = h.sockets[0]; socket.open();
    h.invalidate(); h.textarea.value = 'Manually corrected draft';
    socket.result('late words',true);
    expect(h.textarea.value).toBe('Manually corrected draft');
    expect(h.replacements).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });
});

// Remote UI/permission guidance uses the existing controller, preserving all
// wire-order and composer-owner regression cases above.
describe('public voice recording controls', () => {
  it('records one bounded timing summary without retaining the key, audio or recognized text', async () => {
    let now = 0;
    const records: any[] = [];
    const h = controllerHarness({}, { performance: { now: () => now },
      createLogger: () => ({ info: (...args: any[]) => records.push(args), warn() {}, error() {} }) });
    await h.start(); now = 300; h.sockets[0].open(false);
    now = 900; h.sockets[0].ready(); await h.settle();
    now = 1400; h.sockets[0].result('private spoken text');
    now = 2000; h.button.click();
    now = 2400; h.sockets[0].result('private spoken text', true); await h.settle();
    const summaries = records.filter(record => record[0] === 'voice timing');
    expect(summaries).toHaveLength(1);
    expect(summaries[0][1]).toMatchObject({ socket_open_ms: 300, service_ready_ms: 900,
      capture_ready_ms: 900, first_text_ms: 1400, stop_ms: 2000, final_text_ms: 2400,
      final_wait_ms: 400, total_ms: 2400 });
    expect(JSON.stringify(records)).not.toMatch(/private spoken text|one-use|example.test/);
  });

  it('waits for service readiness before recording, and a duplicate ready cannot recreate capture', async () => {
    const h = controllerHarness();
    await h.start();
    const socket = h.sockets[0]; socket.open(false);
    expect(h.button.classList.contains('is-recording')).toBe(false);
    expect(h.button.dataset.voicePhase).toBe('connecting');
    expect(h.captureNodes).toHaveLength(0);
    expect(socket.send).not.toHaveBeenCalled();
    socket.ready(); await h.settle();
    expect(h.button.dataset.voicePhase).toBe('recording');
    expect(h.captureNodes).toHaveLength(1);
    socket.ready(); await h.settle();
    expect(h.captureNodes).toHaveLength(1);
    h.ownerChange();
  });
  it('cancels while waiting for ready without capturing late audio or altering the draft', async () => {
    const h = controllerHarness(); await h.start();
    const socket = h.sockets[0]; socket.open(false);
    h.button.click(); socket.ready(); await h.settle();
    expect(h.captureNodes).toHaveLength(0);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.alerts).toEqual([]);
    expect(h.timers.size).toBe(0);
  });
  it('bounds a missing ready event and lets the user retry with the draft intact', async () => {
    const h = controllerHarness(); await h.start();
    const socket = h.sockets[0]; socket.open(false);
    expect(h.timers.size).toBe(1);
    [...h.timers.values()][0](); await h.settle();
    expect(h.captureNodes).toHaveLength(0);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.alerts).toEqual([h.context.t('chat.mic_error_unavailable')]);
    await h.start(); h.sockets[1].open();
    expect(h.button.dataset.voicePhase).toBe('recording');
    h.ownerChange();
  });
  it('starts without an introduction and keeps icon-only state across repeat attempts', async () => {
    const h = controllerHarness();
    const state = (phase: string, recording: boolean, busy: boolean) => {
      expect(h.button.dataset.voicePhase).toBe(phase);
      expect(h.button.classList.contains('is-recording')).toBe(recording);
      expect(h.button.classList.contains('is-busy')).toBe(busy);
      expect(h.button.parentNode.insertBefore).not.toHaveBeenCalled();
    };
    state('idle', false, false);
    for (let n = 0; n < 2; n++) {
      await h.start(); state('connecting', false, true);
      const socket = h.sockets[n]; socket.open(); state('recording', true, false);
      h.button.click(); state('finalizing', false, true);
      expect(h.button.title).toBe(h.context.t('chat.mic_finalizing'));
      socket.result('review these words', true); await h.settle(); state('idle', false, false);
    }
    expect(h.context.uiConfirm).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it('keeps a failed status lookup distinct from a missing key', async () => {
    const h = controllerHarness({ status: vi.fn(async () => ({ ok: false })) });
    await h.start();
    expect(h.alerts).toEqual([h.context.t('chat.mic_error_unavailable')]);
    expect(h.context.uiChoice).not.toHaveBeenCalled();
    expect(h.voice.createSession).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.textarea.value).toBe('Keep this draft');
  });
  it.each(['Escape', 'hidden', 'unload', 'explicit'])('releases a recording on %s and ignores late transcript', async (event) => {
    const h = controllerHarness(); await h.start(); const socket = h.sockets[0]; socket.open();
    if (event === 'Escape') h.documentEvents.keydown({ key: 'Escape' });
    if (event === 'hidden') { h.context.document.hidden = true; h.documentEvents.visibilitychange(); }
    if (event === 'unload') h.windowEvents.beforeunload();
    if (event === 'explicit') h.context.window.VoiceInput.cancel();
    socket.result('late text', true);
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.alerts).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  });
});

// Union boundaries: bounded diagnostics and precise recovery remain independent
// of successful transcript insertion. Transport faults cannot silently lose audio.
describe('voice union failure boundaries', () => {
  it.each(['private-upstream-reason', 'network'])('bounds diagnostic code for %s without retaining payloads', async (reason) => {
    const records: unknown[][] = [];
    const log = (...args: unknown[]) => records.push(args);
    const h = controllerHarness({}, { createLogger: () => ({ info: log, warn: log, error: log }) });
    await h.start(); const socket = h.sockets[0]; socket.open(); socket.error(reason);
    const diagnostic = records.find(entry => entry[0] === 'voice client error') as any;
    expect(diagnostic).toBeDefined();
    expect(diagnostic[1].error).toEqual({ code: reason === 'network' ? 'network' : 'unknown' });
    if (reason !== 'network') expect(JSON.stringify(records)).not.toContain(reason);
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('distinguishes a system-policy restriction before ticket exchange or capture', async () => {
    const h = controllerHarness({ ensureMicrophoneAccess: vi.fn(async () => ({ ok: true, granted: false, status: 'restricted' })) });
    await h.start();
    expect(h.alerts).toEqual([h.context.t('chat.mic_error_restricted')]);
    expect(h.voice.createSession).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.sockets).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
  });
  it('allows the exact 256KiB queued boundary and cancels before adding audio beyond it', async () => {
    const h = controllerHarness(); await h.start(); const socket = h.sockets[0]; socket.open();
    const capture = (sample: number) => h.captureNodes[0].onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array([sample, sample, sample]) },
    });
    socket.bufferedAmount = 256 * 1024; capture(.25); await h.settle();
    expect(socket.send).toHaveBeenCalledTimes(1);
    socket.bufferedAmount++; capture(.5); await h.settle();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(h.alerts).toEqual([h.context.t('chat.mic_error_unavailable')]);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.send).not.toHaveBeenCalled();
  });
  it('reports a socket send exception and closes capture without leaking the raw failure', async () => {
    const records: unknown[][] = []; const log = (...args: unknown[]) => records.push(args);
    const h = controllerHarness({}, { createLogger: () => ({ info: log, warn: log, error: log }) });
    await h.start(); const socket = h.sockets[0]; socket.open();
    socket.send.mockImplementation(() => { throw new Error('private-websocket-send-detail'); });
    h.captureNodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([.25, .25, .25]) } });
    await h.settle();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(records)).not.toContain('private-websocket-send-detail');
    expect(h.alerts).toEqual([h.context.t('chat.mic_error_unavailable')]);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.send).not.toHaveBeenCalled();
  });
});

// Remote microphone admission and hidden-composer cleanup must coexist with
// local ready/gzip/ordering/epoch ownership, not replace that transport.
describe('merged remote voice admission and editor lifetime', () => {
  it.each(['NotFoundError', 'NotReadableError'])('does not request a ticket when microphone acquisition fails with %s', async (name) => {
    const h = controllerHarness();
    h.capture.mockRejectedValue(Object.assign(new Error(), { name }));
    await h.start();
    expect(h.voice.createSession).not.toHaveBeenCalled();
    expect(h.sockets).toEqual([]);
    expect(h.captureNodes).toHaveLength(0);
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.alerts).toEqual([h.context.t(name === 'NotFoundError' ? 'chat.mic_error_no_device' : 'chat.mic_error_busy')]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('releases a late microphone grant after cancellation without requesting a ticket', async () => {
    const h = controllerHarness();
    let grant!: (stream: unknown) => void;
    h.capture.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    await h.start();
    h.button.click();
    grant({ getTracks: () => [{ stop: h.stopped }] });
    await h.settle();
    expect(h.voice.createSession).not.toHaveBeenCalled();
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.sockets).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.alerts).toEqual([]);
  });

  it('preserves a selected draft range when a terminal response contains no speech', async () => {
    const h = controllerHarness(); h.textarea.selectionStart = 0;
    await h.start(); h.sockets[0].open(); h.sockets[0].result('', true); await h.settle();
    expect(h.replacements).toEqual([]);
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.alerts).toEqual([h.context.t('chat.mic_empty')]);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('cancels recording when its editor becomes hidden and clears its visibility watcher', async () => {
    const h = controllerHarness();
    const watchers = new Map<number, Function>(); let next = 0;
    h.context.setInterval = (fn: Function) => { watchers.set(++next, fn); return next; };
    h.context.clearInterval = (id: number) => watchers.delete(id);
    await h.start(); const socket = h.sockets[0]; socket.open(); await h.settle();
    expect(watchers.size).toBe(1);
    const oldWatcher = [...watchers.values()][0];
    h.textarea.getClientRects = () => [];
    for (const callback of [...watchers.values()]) callback();
    socket.result('belongs to the hidden composer', true); await h.settle();
    expect(watchers.size).toBe(0);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.alerts).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
    h.textarea.getClientRects = () => [1];
    await h.start(); const replacement = h.sockets[1]; replacement.open(); await h.settle();
    // A queued old tick must not cancel the new attempt, even when the editor
    // becomes hidden again before the replacement's own watcher runs.
    h.textarea.getClientRects = () => [];
    oldWatcher();
    expect(h.button.dataset.voicePhase).toBe('recording');
    expect(replacement.close).not.toHaveBeenCalled();
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(watchers.size).toBe(1);
    [...watchers.values()][0]();
    expect(h.stopped).toHaveBeenCalledTimes(2);
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(watchers.size).toBe(0);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.send).not.toHaveBeenCalled();
  });
  it('ignores an old ticket result after the same client starts a replacement capture', async () => {
    const h = controllerHarness();
    let resolveOld!: (url: string) => void;
    const resolveUrl = vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { resolveOld = resolve; }))
      .mockResolvedValue('wss://example.test/asr?ticket=replacement');
    const result = vi.fn();
    const client = h.context.window.VoiceInput.createClient(resolveUrl, { onResult: result });
    const first = client.start(); await h.settle();
    client.close();
    await client.start(); const socket = h.sockets[0]; socket.open(); await h.settle();
    expect(h.stopped).toHaveBeenCalledTimes(1);
    resolveOld('wss://example.test/asr?ticket=obsolete'); await first; await h.settle();
    expect(h.sockets).toHaveLength(1);
    expect(socket.url).toContain('ticket=replacement');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    h.captureNodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([.25, .25, .25]) } });
    await h.settle();
    expect(Array.from(socket.send.mock.calls[0][0] as Uint8Array)).toEqual([255, 31]);
    socket.result('current speech', true);
    expect(result).toHaveBeenCalledExactlyOnceWith({ text: 'current speech', last: true });
    client.close();
    expect(h.stopped).toHaveBeenCalledTimes(2);
  });

});
