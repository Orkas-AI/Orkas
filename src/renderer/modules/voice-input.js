// Voice-to-text for the chat composers.
//
// Adds a microphone button immediately before Send in the new-chat
// landing composer and the conversation composer. Clicking it captures the
// mic (getUserMedia + an AudioWorklet that downsamples to 16 kHz / 16-bit
// PCM), streams the PCM (gzip-compressed when the browser supports it) over
// a WebSocket to the Server's `/voice/asr_ws` proxy (a thin front for
// VolcEngine's streaming ASR), and writes the recognised text into the
// textarea live. Clicking again stops; the final text stays in the box and
// is NOT auto-sent — the user reviews and presses send themselves.
//
// The user-owned API key stays in main; the renderer receives a one-use ticket.
//
// Classic script — no import/export; exposes the global `VoiceInput`.

(function () {
  'use strict';

  const HAS_GZIP =
    typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  const VOICE_MAX_DURATION_MS = 120 * 1000;
  const voiceLog = (() => {
    try { return typeof createLogger === 'function' ? createLogger('voice-input') : null; } catch { return null; }
  })();

  function _errorInfo(e) {
    const publicCode = typeof e?.code === 'string' && [
      'api_key_required', 'invalid_api_key', 'insufficient_scope', 'unauthorized',
      'insufficient_quota', 'restricted', 'network', 'rate_limit_exceeded',
      'empty_transcript', 'incomplete_transcript', 'timeout',
    ].includes(e.code) ? e.code : null;
    return { code: publicCode || _voiceErrorCode(e && (e.name || e.message)) };
  }

  function voiceNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function markVoiceTiming(attempt, stage) {
    if (!attempt || attempt.timingReported || attempt.timings[stage] !== undefined) return;
    attempt.timings[stage] = Math.max(0, Math.round(voiceNow() - attempt.timingStart));
  }

  function reportVoiceTiming(attempt) {
    if (!attempt || attempt.timingReported) return;
    markVoiceTiming(attempt, 'total_ms');
    attempt.timingReported = true;
    const timings = attempt.timings;
    const finalWait = timings.stop_ms !== undefined && timings.final_text_ms !== undefined
      ? Math.max(0, timings.final_text_ms - timings.stop_ms) : undefined;
    // One local summary per attempt, numeric milestones only. Never retain audio,
    // transcript text, credentials, or the session-bearing WebSocket URL.
    try { voiceLog?.info('voice timing', { ...timings, final_wait_ms: finalWait,
      phase: attempt.phase, terminal: timings.final_text_ms !== undefined }); } catch {}
  }

  async function gzipBytes(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzipBytes(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ── Low-level streaming-ASR client (VolcEngine binary protocol). ──────────
  // Ported from the AIBase web client; the wire framing matches the Server
  // proxy's `biz/voice/asr.py`.
  class AsrClient {
    constructor(wsUrl, callbacks) {
      this._url = wsUrl;
      this._cb = callbacks || {};
      this._ws = null;
      this._running = false;
      this._pendingClose = false;
      this._cancelledBeforeOpen = false;
      this._lastText = '';
      this._audioCtx = null;
      this._mediaStream = null;
      this._source = null;
      this._workletNode = null;
      this._scriptNode = null;
      this._captureNode = null;
      this._workletModuleURL = null;
      this._silentGain = null;
      this._inRate = 0;
      this._chunkMs = 200;
      this._chunkFrames = 0;
      this._useGzip = HAS_GZIP;
      this._closeEmitted = false;
      this._sendTail = Promise.resolve();
      this._inputEnded = false;
      this._captureEpoch = 0;
      this._captureFlush = null;
      this._finishTimer = null;
      this._connectTimer = null;
    }

    _emit(name, ...args) {
      const fn = this._cb[name];
      if (typeof fn === 'function') {
        try { fn(...args); } catch (e) { /* renderer callback threw */ }
      }
    }

    _connectUrl() {
      try {
        const u = new URL(this._url);
        u.searchParams.set('encoding', this._useGzip ? 'gzip' : 'raw');
        return u.toString();
      } catch {
        return this._url + (this._url.includes('?') ? '&' : '?') + 'encoding=' + (this._useGzip ? 'gzip' : 'raw');
      }
    }

    async start() {
      if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;
      const epoch = ++this._captureEpoch;
      this._closeEmitted = false;
      // Acquire the mic FIRST so a permission denial fails before we open the
      // socket (cleaner than tearing down a live WS in the error path).
      let mediaStream;
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        if (epoch !== this._captureEpoch) return;
        try { if (voiceLog) voiceLog.error('getUserMedia failed', _errorInfo(e)); } catch {}
        this._emit('onError', e);
        return;
      }
      if (epoch !== this._captureEpoch || this._pendingClose) {
        try { mediaStream.getTracks().forEach((tr) => { try { tr.stop(); } catch {} }); } catch {}
        return;
      }
      this._mediaStream = mediaStream;
      this._emit('onStage', 'microphone_ms');
      let ws;
      try {
        const url = typeof this._url === 'function' ? await this._url() : this._url;
        if (epoch !== this._captureEpoch) return;
        if (this._pendingClose) {
          this._teardownCapture();
          return;
        }
        this._url = url;
        ws = new WebSocket(this._connectUrl());
      } catch (e) {
        if (epoch !== this._captureEpoch) return;
        try { if (voiceLog) voiceLog.error('ASR websocket constructor failed', _errorInfo(e)); } catch {}
        this._teardownCapture();
        this._emit('onError', e);
        return;
      }
      this._ws = ws;
      this._connectTimer = setTimeout(() => {
        if (this._ws !== ws) return;
        this._emit('onError', Object.assign(new Error(), { code: 'network' }));
        if (this._ws === ws) this.close();
      }, 60_000);
      this._lastText = '';
      const incoming = { tail: Promise.resolve(), pending: 0 };
      this._sendTail = Promise.resolve();
      this._inputEnded = false;
      this._closeEmitted = false;
      this._cancelledBeforeOpen = false;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        if (this._ws !== ws) { try { ws.close(); } catch {} return; }
        // stop() can run while the browser is still negotiating the socket.
        // In that case opening is only a transport completion, not fresh user
        // consent to start recording. Close immediately and never reacquire
        // capture resources that stop() has already released.
        if (this._pendingClose) {
          this._running = false;
          this._teardownCapture();
          try { this.close(); } catch {}
          return;
        }
        try { if (voiceLog) voiceLog.info('ASR websocket open'); } catch {}
        this._emit('onStage', 'socket_open_ms');
        // The ticket protocol sends ready only after auth, quota and provider setup.
        // Keep the setup deadline active until capture is actually ready.
      };
      ws.onmessage = (ev) => {
        if (this._ws !== ws) return;
        if (typeof ev.data === 'string') { this._handleJSON(ev.data); return; }
        // Binary gzip decoding is async; browser event dispatch does not
        // wait for it. Keep transcript delivery in this socket's wire order.
        incoming.pending++;
        incoming.tail = incoming.tail.then(() => {
          if (this._ws !== ws) return;
          return this._handleBinary(ev.data, ws);
        }).catch(() => {}).finally(() => { incoming.pending--; });
      };
      ws.onerror = (e) => {
        if (this._ws !== ws) return;
        // Chromium reports close() on a CONNECTING socket through onerror.
        // That is the expected result of the user's explicit cancellation,
        // not an ASR outage that should surface an error dialog.
        if (this._cancelledBeforeOpen) return;
        try { if (voiceLog) voiceLog.error('ASR websocket error', _errorInfo(e)); } catch {}
        // Browser WebSocket error events intentionally omit the HTTP handshake
        // status and usually have no name/message. Preserve a stable,
        // actionable transport category instead of reporting `unknown`.
        const err = new Error('websocket_error');
        err.name = 'WebSocketError';
        err.cause = e;
        this._emit('onError', err);
      };
      ws.onclose = (ev) => {
        if (this._ws !== ws) return;
        try { if (voiceLog) voiceLog.info('ASR websocket close', { code: ev && ev.code, wasClean: ev && ev.wasClean }); } catch {}
        this._captureEpoch++;
        this._inputEnded = true;
        this._running = false;
        this._teardownCapture();
        // Release capture immediately, but an admitted terminal frame must
        // reach the consumer before natural close reports completion.
        const finish = () => {
          if (this._ws !== ws) return;
          this._ws = null;
          this._pendingClose = false;
          this._emitCloseOnce();
        };
        if (incoming.pending) incoming.tail.then(finish);
        else finish();
      };
    }

    _handleJSON(s) {
      let obj;
      try { obj = JSON.parse(String(s || '{}')); } catch { return; }
      if (obj && obj.event === 'ready') {
        if (!this._running && !this._pendingClose && this._ws?.readyState === WebSocket.OPEN) {
          this._emit('onStage', 'service_ready_ms');
          this._running = true;
          this._startCapture();
        }
        return;
      }
      if (obj && obj.event === 'timeout') {
        const err = Object.assign(new Error('asr_timeout'), { code: 'timeout' });
        err.maxSeconds = Number(obj.max_seconds || obj.maxSeconds || 0) || undefined;
        this._emit('onError', err);
        this._running = false;
        this._pendingClose = false;
        return;
      }
      if (obj && obj.event === 'error') {
        const err = Object.assign(new Error('asr_' + (obj.reason || 'error')), { code: String(obj.reason || 'unavailable') });
        try { if (voiceLog) voiceLog.error('ASR server event error', { code: _voiceErrorCode(obj.reason) }); } catch {}
        this._emit('onError', err);
        this._running = false;
        this._pendingClose = false;
        return;
      }
      const body = (obj && (obj.payload_msg || obj.body)) || obj || {};
      const result = body.result || body.data || {};
      const text = String(result.text || result.punctuated_text || '');
      this._lastText = text || this._lastText;
      const isLast = !!((obj && obj.is_last_package) || result.last);
      this._emit('onResult', { text: this._lastText, last: isLast });
      if (isLast) {
        this._running = false;
        if (this._pendingClose) { try { this.close(); } catch {} }
      }
    }

    async _handleBinary(ab, ws) {
      const u8 = ab instanceof Uint8Array ? ab : new Uint8Array(ab || []);
      if (!u8 || u8.length < 4) return;
      const headerSize = u8[0] & 0x0f;
      const messageType = u8[1] >> 4;
      const flags = u8[1] & 0x0f;
      const serialization = u8[2] >> 4;
      const compression = u8[2] & 0x0f;
      let idx = headerSize * 4;
      let isLast = false;
      let payloadSize = 0;
      const dv = (off) => new DataView(u8.buffer, u8.byteOffset + off, 4);
      if (flags & 0x01) { idx += 4; }                       // payload sequence (unused)
      if (flags & 0x02) { isLast = true; }
      if (flags & 0x04) { idx += 4; }                       // event (unused)
      if (messageType === 9) { payloadSize = dv(idx).getUint32(0, false); idx += 4; }
      else if (messageType === 15) { idx += 4; payloadSize = dv(idx).getUint32(0, false); idx += 4; }  // error: code + size
      let payload = u8.subarray(idx, payloadSize ? idx + payloadSize : u8.length);
      if (compression === 1 && HAS_GZIP) {
        try { payload = await gunzipBytes(payload); } catch { return; }
      }
      let obj = null;
      if (serialization === 1) {
        try { obj = JSON.parse(new TextDecoder('utf-8').decode(payload)); } catch {}
      }
      if (this._ws !== ws) return;
      this._handleJSON(JSON.stringify({ is_last_package: isLast, payload_msg: obj }));
    }

    async _sendAudio(bytes, last) {
      const ws = this._ws;
      if (!ws || ws.readyState !== WebSocket.OPEN || this._inputEnded) return;
      if (last) this._inputEnded = true;
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      // Compression may finish out of order. Own this socket and keep END
      // behind every audio chunk admitted before stop().
      const pending = this._sendTail.then(async () => {
        if (this._ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          const payload = this._useGzip ? await gzipBytes(u8) : u8;
          if (this._ws !== ws || ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 256 * 1024) {
            this._emit('onError', Object.assign(new Error(), { code: 'network' }));
            if (this._ws === ws) this.close();
            return;
          }
          try {
            ws.send(payload);
            if (last) {
              ws.send('__END__');
              this._running = false;
            }
          } catch {
            throw Object.assign(new Error(), { code: 'network' });
          }
        } catch (e) {
          if (this._ws !== ws || ws.readyState !== WebSocket.OPEN) return;
          try { if (voiceLog) voiceLog.error('ASR audio send failed', _errorInfo(e)); } catch {}
          this._emit('onError', e);
          if (this._ws === ws) this.close();
        }
      });
      this._sendTail = pending;
      return pending;
    }

    async _startCapture() {
      const epoch = this._captureEpoch;
      const ws = this._ws;
      const active = () => this._captureEpoch === epoch && this._ws === ws
        && this._running && !this._pendingClose;
      if (!active()) return;
      try {
        const ms = this._mediaStream;
        if (!ms) throw new Error('no_media_stream');
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this._audioCtx = new Ctx();
        if (this._audioCtx.state === 'suspended') await this._audioCtx.resume();
        if (active() && this._audioCtx.state !== 'running') throw new Error('audio_context_unavailable');
        if (!active()) return;
        this._source = this._audioCtx.createMediaStreamSource(ms);
        this._inRate = this._audioCtx.sampleRate || 48000;
        this._chunkFrames = Math.max(1, Math.floor((this._inRate * this._chunkMs) / 1000));
        let captureReady = false;
        if (this._audioCtx.audioWorklet && typeof window.AudioWorkletNode === 'function') {
          let url = '';
          try {
            const code = `class C extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = 1024;
    this.b = new Float32Array(this.n);
    this.i = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.flush) {
        this.stopped = true;
        if (this.i) {
          const tail = this.b.slice(0, this.i);
          this.i = 0;
          this.port.postMessage({ b: tail }, [tail.buffer]);
        }
        this.port.postMessage({ flushed: true });
      } else if (!this.stopped && typeof data.n === 'number' && data.n > 0) {
        this.n = data.n | 0;
        this.b = new Float32Array(this.n);
        this.i = 0;
      }
    };
  }
  process(inputs, outputs) {
    const audio = inputs && inputs[0] && inputs[0][0];
    const output = outputs && outputs[0] && outputs[0][0];
    if (output) output.fill(0);
    if (this.stopped) return false;
    if (!audio || !audio.length) return true;
    for (let offset = 0; offset < audio.length; offset++) {
      this.b[this.i++] = audio[offset];
      if (this.i >= this.n) {
        const chunk = new Float32Array(this.b);
        this.port.postMessage({ b: chunk }, [chunk.buffer]);
        this.i = 0;
      }
    }
    return true;
  }
}
registerProcessor('orkas-asr-capture', C);`;
            const blob = new Blob([code], { type: 'application/javascript' });
            url = URL.createObjectURL(blob);
            this._workletModuleURL = url;
            await this._audioCtx.audioWorklet.addModule(url);
            if (!active()) return;
            this._workletNode = new AudioWorkletNode(this._audioCtx, 'orkas-asr-capture', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            });
            const worklet = this._workletNode;
            worklet.port.onmessage = (ev) => {
              if (this._workletNode !== worklet || this._ws !== ws) return;
              const data = ev.data || {};
              if (data.b && (this._running || this._captureFlush)) {
                const samples = data.b instanceof Float32Array ? data.b : new Float32Array(data.b);
                this._sendAudio(this._resampleTo16k(samples, this._inRate), false);
              }
              if (data.flushed && this._captureFlush?.node === worklet) {
                const pending = this._captureFlush;
                this._captureFlush = null;
                clearTimeout(pending.timer);
                pending.resolve(true);
              }
            };
            try { this._workletNode.port.postMessage({ n: this._chunkFrames }); } catch {}
            this._source.connect(this._workletNode);
            this._captureNode = this._workletNode;
            captureReady = true;
          } catch (workletError) {
            if (!active()) return;
            try { if (voiceLog) voiceLog.warn('AudioWorklet capture failed; falling back to ScriptProcessor', _errorInfo(workletError)); } catch {}
            try { if (this._workletNode) this._workletNode.disconnect(); } catch {}
            this._workletNode = null;
            if (this._workletModuleURL) { try { URL.revokeObjectURL(this._workletModuleURL); } catch {} this._workletModuleURL = null; }
            else if (url) { try { URL.revokeObjectURL(url); } catch {} }
          }
        } else {
          try { if (voiceLog) voiceLog.warn('AudioWorklet unavailable; using ScriptProcessor fallback'); } catch {}
        }
        if (!captureReady) {
          const mk = this._audioCtx.createScriptProcessor || this._audioCtx.createJavaScriptNode;
          if (typeof mk !== 'function') throw new Error('audio_capture_unsupported');
          const node = mk.call(this._audioCtx, 4096, 1, 1);
          node.onaudioprocess = (ev) => {
            if (this._scriptNode !== node || this._ws !== ws || !this._running) return;
            const ch = ev.inputBuffer.getChannelData(0);
            this._sendAudio(this._resampleTo16k(ch, this._inRate), false);
          };
          this._source.connect(node);
          this._scriptNode = node;
          this._captureNode = node;
        }
        // Capture-node output must reach the destination or process()/onaudioprocess
        // won't be pumped — route it through a muted gain so nothing is audible.
        this._silentGain = this._audioCtx.createGain();
        try { this._silentGain.gain.value = 0; } catch {}
        this._captureNode.connect(this._silentGain);
        this._silentGain.connect(this._audioCtx.destination);
        clearTimeout(this._connectTimer);
        this._emit('onOpen');
      } catch (e) {
        if (!active()) return;
        try { if (voiceLog) voiceLog.error('audio capture start failed', _errorInfo(e)); } catch {}
        this._emit('onError', e);
      }
    }

    _releaseMicrophone() {
      const stream = this._mediaStream;
      this._mediaStream = null;
      if (stream) {
        try { stream.getTracks().forEach((track) => { try { track.stop(); } catch {} }); } catch {}
      }
    }

    _teardownCapture() {
      const pending = this._captureFlush;
      this._captureFlush = null;
      if (pending) { clearTimeout(pending.timer); pending.resolve(false); }
      try { if (this._workletNode) this._workletNode.port.onmessage = null; } catch {}
      try { if (this._scriptNode) this._scriptNode.onaudioprocess = null; } catch {}
      try { if (this._workletNode) this._workletNode.disconnect(); } catch {}
      try { if (this._scriptNode) this._scriptNode.disconnect(); } catch {}
      try { if (this._source) this._source.disconnect(); } catch {}
      try { if (this._silentGain) this._silentGain.disconnect(); } catch {}
      try { if (this._audioCtx) { const p = this._audioCtx.close(); if (p && p.then) p.then(() => {}).catch(() => {}); } } catch {}
      this._workletNode = null;
      this._scriptNode = null;
      this._captureNode = null;
      this._source = null;
      this._silentGain = null;
      this._audioCtx = null;
      if (this._workletModuleURL) { try { URL.revokeObjectURL(this._workletModuleURL); } catch {} this._workletModuleURL = null; }
      this._releaseMicrophone();
    }

    _emitCloseOnce() {
      clearTimeout(this._connectTimer);
      clearTimeout(this._finishTimer);
      if (this._closeEmitted) return;
      this._closeEmitted = true;
      this._running = false;
      this._emit('onClose');
    }

    _resampleTo16k(f32, inRate) {
      const rate = Math.max(1, inRate || 48000);
      const ratio = rate / 16000;
      const outLen = Math.max(1, Math.floor(f32.length / ratio));
      const u8 = new Uint8Array(outLen * 2);
      const dv = new DataView(u8.buffer);
      for (let i = 0; i < outLen; i++) {
        let s = f32[Math.floor(i * ratio)] || 0;
        if (s > 1) s = 1; else if (s < -1) s = -1;
        dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return u8;
    }

    stop() {
      if (this._pendingClose) return;
      this._captureEpoch++;
      this._running = false;
      this._pendingClose = true;
      // Release the device now; keep the processor alive only to return its
      // already captured tail. The existing overall close deadline still wins.
      this._releaseMicrophone();
      const ws = this._ws;
      if (!ws) {
        this._teardownCapture();
        this._emitCloseOnce();
        return;
      }
      this._cancelledBeforeOpen = ws.readyState === WebSocket.CONNECTING;
      let flushed = Promise.resolve(true);
      const node = this._workletNode;
      if (node && node.port) {
        flushed = new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (this._captureFlush?.node !== node) return;
            this._captureFlush = null;
            resolve(false);
          }, 500);
          this._captureFlush = { node, resolve, timer };
        });
        try { node.port.postMessage({ flush: true }); }
        catch {
          clearTimeout(this._captureFlush.timer);
          this._captureFlush.resolve(false);
          this._captureFlush = null;
        }
      }
      const finish = async () => {
        const complete = await flushed;
        if (this._ws !== ws || !this._pendingClose || ws.readyState === WebSocket.CLOSED) return;
        if (!complete) {
          this._emit('onError', Object.assign(new Error('incomplete_capture'), { code: 'incomplete_transcript' }));
          if (this._ws === ws) this.close();
          return;
        }
        this._teardownCapture();
        await this._sendAudio(new Uint8Array(0), true);
      };
      finish();
      // Keep the remote 10s final-response budget; the worklet tail has its own 500ms bound.
      try {
        this._finishTimer = setTimeout(() => {
          if (!this._pendingClose || this._ws !== ws) return;
          if (this._captureFlush) this._emit('onError', new Error('incomplete_capture'));
          if (this._ws === ws) this.close();
        }, 10_000);
      } catch {}
    }

    close() {
      clearTimeout(this._connectTimer);
      clearTimeout(this._finishTimer);
      this._captureEpoch++;
      this._inputEnded = true;
      this._running = false;
      this._pendingClose = false;
      this._teardownCapture();
      const ws = this._ws;
      this._ws = null;
      try { if (ws) ws.close(); } catch {}
      this._emitCloseOnce();
    }
  }

  // ── Per-composer controller. ─────────────────────────────────────────────
  function _t(key, fallback) {
    try { if (typeof t === 'function') { const v = t(key); if (v && v !== key) return v; } } catch {}
    return fallback;
  }

  function _alert(msg) {
    try { if (typeof uiAlert === 'function') { uiAlert(msg); return; } } catch {}
    try { window.alert(msg); } catch {}
  }

  function _toast(msg) {
    try { if (typeof uiToast === 'function') { uiToast(msg, { variant: 'warning' }); return; } } catch {}
    _alert(msg);
  }

  function _limitMessage(seconds) {
    const n = Number(seconds) || 120;
    return _t('chat.mic_limit_reached', 'Single voice recognition can be up to {seconds} seconds.')
      .replace('{seconds}', String(n));
  }

  function _isPermissionError(name) {
    return /NotAllowed|Permission|denied|SecurityError/i.test(name);
  }

  function _isNoDeviceError(name) {
    return /NotFound|DevicesNotFound/i.test(name);
  }

  function _voiceErrorCode(value) {
    const name = String(value || '').toLowerCase();
    if (/timeout|limit/.test(name)) return 'timeout';
    if (/session_expired/.test(name)) return 'session_expired';
    if (/unauthorized|not_logged|login/.test(name)) return 'unauthorized';
    if (/insufficient_quota|credit/.test(name)) return 'insufficient_quota';
    if (/notallowed|permission|denied|securityerror/.test(name)) return 'permission_denied';
    if (/notfound|devicesnotfound|no_device/.test(name)) return 'no_device';
    if (/chunk_too_large|session_too_large|input_too_large/.test(name)) return 'input_too_large';
    if (/invalid_encoding|invalid_message|malformed|protocol/.test(name)) return 'protocol_error';
    if (/upstream/.test(name)) return 'upstream_error';
    if (/no_url|unavailable/.test(name)) return 'unavailable';
    if (/capture|media_stream|audio/.test(name)) return 'capture_failed';
    if (/websocket|network|socket/.test(name)) return 'network';
    if (/incomplete_transcript/.test(name)) return 'incomplete_transcript';
    if (/empty_transcript/.test(name)) return 'empty_transcript';
    return 'unknown';
  }

  let cancelActive = null;
  const tr = (key) => _t('chat.mic_' + key, 'chat.mic_' + key);
  const invoke = (name) => {
    const facade = window.orkas?.voiceInput;
    if (typeof facade?.[name] === 'function') return facade[name]();
    return window.orkas.invoke('voice.' + name);
  };

  async function openKeySettings(create) {
    if (typeof loadRendererFeature === 'function') await loadRendererFeature('settings');
    setView('settings');
    if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
    const input = document.getElementById('settings-orkas-api-key-input');
    input?.scrollIntoView?.({ block: 'center' });
    input?.focus();
    if (create) document.getElementById('settings-orkas-api-create-key')?.click();
  }

  async function publicGuidance(code) {
    if (['api_key_required', 'invalid_api_key', 'insufficient_scope', 'unauthorized'].includes(code)) {
      const message = code === 'api_key_required' ? 'key_required' : code === 'insufficient_scope' ? 'scope_required' : 'invalid_key';
      const choice = await uiChoice({ title: tr('title'), message: tr(message),
        choices: [{ id: 'configure', label: t('settings.orkas_api.configure') }],
        leadingChoices: [{ id: 'create', label: t('settings.orkas_api.create_key'), style: '' }] });
      if (choice) await openKeySettings(choice === 'create');
      return;
    }
    if (code === 'insufficient_quota') {
      const choice = await uiChoice({ title: tr('title'), message: tr('insufficient_credits'),
        choices: [{ id: 'credits', label: tr('manage_credits') }] });
      if (choice === 'credits') {
        const url = new URL('https://orkas.ai/views/account/account.html');
        url.searchParams.set('lang', typeof getLang === 'function' ? getLang() : 'en');
        const result = await window.orkas.invoke('auth.openExternal', { url: url.toString() });
        if (!result?.ok) await uiAlert(tr('error_unavailable'));
      }
      return;
    }
    const errors = { NotAllowedError: 'error_permission', SecurityError: 'error_permission',
      NotFoundError: 'error_no_device', DevicesNotFoundError: 'error_no_device',
      NotReadableError: 'error_busy', TrackStartError: 'error_busy', restricted: 'error_restricted',
      network: 'error_unavailable', rate_limit_exceeded: 'rate_limited', empty_transcript: 'empty',
      incomplete_transcript: 'incomplete', timeout: 'limit_reached' };
    await uiAlert(tr(errors[code] || 'error_unavailable').replace('{seconds}', '120'));
  }

  function attach(buttonEl, textareaEl) {
    if (!buttonEl || !textareaEl || buttonEl.dataset.voiceBound === '1') return;
    buttonEl.dataset.voiceBound = '1';
    if (!(window.orkas && (typeof window.orkas.voiceInput?.createSession === 'function' || typeof window.orkas.invoke === 'function'))) {
      // No Server-backed voice support in this build — hide the affordance.
      buttonEl.style.display = 'none';
      return;
    }

    let phase = 'idle'; // 'idle' | 'connecting' | 'recording' | 'finalizing'
    let activeAttempt = null;

    function clearLimitTimer(attempt) {
      if (!attempt) return;
      if (attempt.limitTimer) { try { clearTimeout(attempt.limitTimer); } catch {} }
      attempt.limitTimer = null;
    }

    function startLimitTimer(attempt) {
      clearLimitTimer(attempt);
      attempt.limitTimer = setTimeout(() => {
        attempt.limitTimer = null;
        if (activeAttempt !== attempt || !attempt.client || attempt.phase !== 'recording') return;
        _toast(_limitMessage(120));
        stopRecording({ auto: true });
      }, VOICE_MAX_DURATION_MS);
    }

    function setPhase(p) {
      phase = p;
      buttonEl.dataset.voicePhase = p;
      buttonEl.classList.toggle('is-recording', p === 'recording');
      buttonEl.classList.toggle('is-busy', p === 'connecting' || p === 'finalizing');
      const titleKey = p === 'connecting' ? 'chat.mic_connecting' : p === 'finalizing' ? 'chat.mic_finalizing' : (p === 'recording' || p === 'connecting')
        ? 'chat.mic_stop_title' : 'chat.mic_title';
      const titleFallback = p === 'connecting' ? 'Connecting…' : p === 'finalizing' ? 'Finishing recognition…' : (p === 'recording' || p === 'connecting')
        ? 'Stop recording' : 'Voice input';
      buttonEl.title = _t(titleKey, titleFallback);
      buttonEl.setAttribute('aria-label', buttonEl.title);
      buttonEl.setAttribute('aria-pressed', String(p === 'recording'));
    }

    function setAttemptPhase(attempt, nextPhase) {
      attempt.phase = nextPhase;
      if (activeAttempt === attempt) setPhase(nextPhase);
    }

    function applyTranscript(attempt, text) {
      if (activeAttempt !== attempt || attempt.cancelled) return;
      const inserted = String(text || '');
      const needsSpace = attempt.before && !/\s$/.test(attempt.before) && inserted ? ' ' : '';
      if (!attempt.insertion?.replace(needsSpace + inserted)) {
        attempt.finished = true;
        reset(attempt);
        try { attempt.client?.close(); } catch {}
        return;
      }
    }

    function reset(attempt) {
      reportVoiceTiming(attempt);
      clearLimitTimer(attempt);
      if (attempt.visibilityTimer !== null) clearInterval(attempt.visibilityTimer);
      attempt.visibilityTimer = null;
      attempt.insertion?.dispose();
      if (activeAttempt !== attempt) return;
      activeAttempt = null;
      if (cancelActive === cancel) cancelActive = null;
      setPhase('idle');
    }

    function cancel() {
      const attempt = activeAttempt;
      if (!attempt) return;
      attempt.cancelled = true;
      attempt.finished = true;
      reset(attempt);
      try { attempt.client?.close(); } catch {}
    }
    textareaEl.addEventListener('composer-owner-change', cancel);
    window.addEventListener('beforeunload', cancel);
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') cancel(); });
    window.addEventListener('i18n-change', () => setPhase(phase));
    async function refreshHint() {
      if (phase !== 'idle') return;
      try {
        const status = await invoke('status');
        if (phase !== 'idle' || !status?.ok) return;
        buttonEl.title = tr(status.configured ? 'title' : 'key_required');
        buttonEl.setAttribute('aria-label', buttonEl.title);
      } catch { /* The click path reports a recoverable status failure. */ }
    }
    buttonEl.addEventListener('mouseenter', refreshHint);
    buttonEl.addEventListener('focus', refreshHint);

    async function startRecording() {
      if (activeAttempt) return;
      if (cancelActive) cancelActive();
      const attempt = {
        timingStart: voiceNow(), timings: {}, timingReported: false,
        recordingStarted: false,
        finished: false,
        cancelled: false,
        phase: 'connecting',
        before: composerText(textareaEl).slice(0, composerSelection(textareaEl).start),
        insertion: composerInsertion(textareaEl),
        limitTimer: null,
        visibilityTimer: null,
        client: null,
      };
      activeAttempt = attempt;
      cancelActive = cancel;
      setAttemptPhase(attempt, 'connecting');
      try {
        const status = await invoke('status');
        if (activeAttempt !== attempt || attempt.cancelled) return;
        if (!status?.ok) { reset(attempt); await publicGuidance('unavailable'); return; }
        if (!status.configured) { reset(attempt); await publicGuidance('api_key_required'); return; }
      } catch { if (activeAttempt === attempt) { reset(attempt); await publicGuidance('unavailable'); } return; }
      if (typeof window.orkas.voiceInput?.ensureMicrophoneAccess === 'function' || typeof window.orkas.invoke === 'function') {
        try {
          const access = await invoke('ensureMicrophoneAccess');
          if (activeAttempt !== attempt || attempt.cancelled) return;
          if (!access || access.ok === false || !access.granted) {
            attempt.finished = true;
            reset(attempt);
            if (access?.status === 'restricted') await publicGuidance('restricted');
            else _alert(_t('chat.mic_error_permission', 'Microphone access was blocked. Allow it in your system settings to use voice input.'));
            return;
          }
        } catch (e) {
          if (activeAttempt !== attempt || attempt.cancelled) return;
          try { if (voiceLog) voiceLog.error('microphone access preflight failed', _errorInfo(e)); } catch {}
          attempt.finished = true;
          _alert(_t('chat.mic_error_unavailable', 'Voice input is unavailable right now.'));
          reset(attempt);
          return;
        }
      }
      if (activeAttempt !== attempt || attempt.cancelled) return;
      if (!attempt.insertion?.valid()) { reset(attempt); return; }
      // Resolve the one-use ticket only after getUserMedia admits this device.
      const attemptClient = new AsrClient(async () => {
        const result = await invoke('createSession');
        if (activeAttempt !== attempt || attempt.cancelled) return '';
        if (!attempt.insertion?.valid()) { cancel(); return ''; }
        if (!result || result.ok === false || !result.url) {
          throw Object.assign(new Error(), { code: result?.code
            || (result?.error === 'E_ORKAS_API_KEY_REQUIRED' ? 'api_key_required' : 'unavailable') });
        }
        markVoiceTiming(attempt, 'session_ms');
        return result.url;
      }, {
        onStage: (stage) => { if (activeAttempt === attempt) markVoiceTiming(attempt, stage); },
        onOpen: () => {
          if (activeAttempt !== attempt) return;
          markVoiceTiming(attempt, 'capture_ready_ms');
          attempt.recordingStarted = true;
          setAttemptPhase(attempt, 'recording');
          startLimitTimer(attempt);
          attempt.visibilityTimer = setInterval(() => {
            if (activeAttempt !== attempt) return;
            if (textareaEl.getClientRects().length === 0) cancel();
          }, 1000);
        },
        onResult: ({ text, last }) => {
          if (activeAttempt !== attempt) return;
          if (text) markVoiceTiming(attempt, 'first_text_ms');
          if (last) markVoiceTiming(attempt, 'final_text_ms');
          if (text) applyTranscript(attempt, text);
          if (last && activeAttempt === attempt) {
            attempt.finished = true; reset(attempt); attemptClient.close();
            if (!String(text || '').trim()) publicGuidance('empty_transcript');
          }
        },
        onError: (err) => {
          if (activeAttempt !== attempt || attempt.finished) {
            try { attemptClient.close(); } catch {}
            return;
          }
          try { if (voiceLog) voiceLog.error('voice client error', { phase: attempt.phase, error: _errorInfo(err) }); } catch {}
          if (err?.code || ['NotReadableError', 'TrackStartError'].includes(err?.name)) {
            attempt.finished = true; attemptClient.close(); reset(attempt);
            publicGuidance(err.code || err.name); return;
          }
          const name = err && typeof err === 'object'
            ? [err.name, err.message].map((value) => String(value || '').trim()).filter(Boolean).join(' ')
            : String(err || '');
          const errorCode = _voiceErrorCode(name);
          attempt.finished = true;
          if (errorCode === 'timeout') {
            _toast(_limitMessage(err && err.maxSeconds));
          } else {
            const permission = errorCode === 'permission_denied' || _isPermissionError(name);
            const noDevice = errorCode === 'no_device' || _isNoDeviceError(name);
            const loggedOut = errorCode === 'unauthorized' || errorCode === 'session_expired';
            const insufficientQuota = errorCode === 'insufficient_quota';
            _alert(loggedOut
              ? _t('settings.orkas_api.key_required', 'Enter an API Key first.')
              : insufficientQuota
                ? _t('chat.mic_insufficient_credits', 'Not enough credits for voice input.')
              : permission
                ? _t('chat.mic_error_permission', 'Microphone access was blocked. Allow it in your system settings to use voice input.')
              : noDevice
                ? _t('chat.mic_error_no_device', 'No microphone was found.')
                : _t('chat.mic_error_unavailable', 'Voice input is unavailable right now.'));
          }
          try { attemptClient.close(); } catch {}
          reset(attempt);
        },
        onClose: () => {
          if (activeAttempt !== attempt) return;
          if (attempt.finished) {
            reset(attempt);
            return;
          }
          reset(attempt);
          if (!attempt.cancelled) publicGuidance('incomplete_transcript');
        },
      });
      attempt.client = attemptClient;
      try {
        await attemptClient.start();
      } catch (e) {
        if (activeAttempt !== attempt || attempt.finished) return;
        try { if (voiceLog) voiceLog.error('voice client start failed', _errorInfo(e)); } catch {}
        attempt.finished = true;
        _alert(_t('chat.mic_error_unavailable', 'Voice input is unavailable right now.'));
        reset(attempt);
      }
    }

    function stopRecording(options) {
      const attempt = activeAttempt;
      if (!attempt || attempt.phase === 'finalizing') return;
      const automatic = !!(options && options.auto);
      attempt.cancelled = !automatic && !attempt.recordingStarted;
      clearLimitTimer(attempt);
      if (attempt.cancelled) {
        const attemptClient = attempt.client;
        attempt.finished = true;
        reset(attempt);
        try { if (attemptClient) attemptClient.close(); } catch {}
        return;
      }
      markVoiceTiming(attempt, 'stop_ms');
      setAttemptPhase(attempt, 'finalizing');
      try {
        if (!attempt.client) throw new Error('voice_client_unavailable');
        attempt.client.stop();
      } catch (e) {
        attempt.finished = true;
        reset(attempt);
      }
    }

    buttonEl.addEventListener('click', () => {
      const starting = phase === 'idle' && !activeAttempt;
      if (starting) startRecording();
      else if (activeAttempt) stopRecording();
    });
    setPhase('idle');
  }

  // Expose the transport factory for deterministic capture and cancellation tests.
  window.VoiceInput = { attach, cancel: () => cancelActive?.(), createClient: (url, callbacks) => new AsrClient(url, callbacks) };

  document.addEventListener('DOMContentLoaded', () => {
    attach(document.getElementById('new-chat-mic-btn'), document.getElementById('new-chat-input'));
    attach(document.getElementById('chat-mic-btn'), document.getElementById('chat-input'));
    attach(document.getElementById('project-chat-mic-btn'), document.getElementById('project-chat-input'));
    attach(document.getElementById('auto-mic-btn'), document.getElementById('auto-task-input'));
  });
})();
