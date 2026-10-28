import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ownFixtureServer } from './fixtures/server-cleanup';

import { expectComposerText } from './fixtures/composer';
import { expect, openSidebarEntry, test as base, OrkasTestApp } from './fixtures/orkas';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';

const test = base.extend({
  voiceOrkas: async ({}, use, info) => {
    const previous = process.env.ORKAS_E2E_KEEP_LOGS;
    process.env.ORKAS_E2E_KEEP_LOGS = '1';
    const app = new OrkasTestApp(info, { voiceStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      try { await app.dispose(); }
      finally {
        if (previous === undefined) delete process.env.ORKAS_E2E_KEEP_LOGS;
        else process.env.ORKAS_E2E_KEEP_LOGS = previous;
        const log = info.outputPath('electron-main.log');
        expect(existsSync(log), 'Retain complete Electron logs on passing runs too').toBe(true);
        const analysis = analyzeWebAppLogs(readFileSync(log, 'utf8'));
        writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
        expect(analysis.passed, 'Review log-analysis.json for errors or incomplete coverage').toBe(true);
        if (analysis.requiresReview) console.warn('Voice E2E log warnings:', JSON.stringify(analysis.findings));
      }
    }
  },
});

async function expectPublicTicketTransport(app: OrkasTestApp): Promise<void> {
  expect(app.voiceSessionRequests).toEqual([{ method: 'POST', path: '/v1/audio/transcription_sessions',
    authorized: true, body: '{}' }]);
  expect(await app.electronApp!.evaluate(() => (globalThis as any).__e2eVoiceSessionUrls))
    .toEqual(['https://orkas.ai/v1/audio/transcription_sessions']);
  const urls = await app.page!.evaluate(() => (window as any).__e2eVoiceSocketUrls);
  expect(urls).toHaveLength(1);
  const socket = new URL(urls[0]);
  expect(socket.origin + socket.pathname).toBe('wss://orkas.ai/api/voice/asr_ws');
  expect(socket.searchParams.get('ticket')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Array.from(socket.searchParams.keys()).sort()).toEqual(['encoding', 'ticket']);
  expect(await app.page!.locator('#account-login-overlay').count()).toBe(0);
}

test.describe('voice input', () => {
  test('releases the microphone when leaving its composer and preserves the unsent draft', async ({ voiceOrkas }, info) => {
    const page = voiceOrkas.page!;
    await voiceOrkas.installVoiceCaptureStub();
    const input = page.locator('#new-chat-input');
    const mic = page.locator('#new-chat-mic-btn');
    await input.fill('Keep this draft after navigation');
    await mic.click();
    await expect(mic).toHaveAttribute('data-voice-phase', 'recording', { timeout: 20_000 });
    await openSidebarEntry(page, '#agents-btn');
    await expect(input).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__e2eVoiceTrackStops)).toBe(1);
    await expect(mic).toHaveAttribute('data-voice-phase', 'idle');
    await page.screenshot({ path: info.outputPath('voice-left-composer.png') });
    await openSidebarEntry(page, '#new-chat-btn');
    await expectComposerText(input, 'Keep this draft after navigation');
    await expect(page.locator('.ui-dialog-overlay:visible')).toHaveCount(0);
    await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(0);
    await expectPublicTicketTransport(voiceOrkas);
    await page.screenshot({ path: info.outputPath('voice-returned-draft.png') });
  });

  test('inserts the terminal transcript for review without auto-sending', async ({ voiceOrkas }, info) => {
    if (!voiceOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = voiceOrkas.page;
    await voiceOrkas.installVoiceCaptureStub();

    const input = page.locator('#new-chat-input');
    const mic = page.locator('#new-chat-mic-btn');
    await input.fill('Draft:');
    await input.evaluate((element: HTMLTextAreaElement) => {
      const w = window as any;
      w.composerSetSelection(element, w.composerText(element).length);
    });

    await mic.click();
    await expect(mic).toHaveClass(/\bis-recording\b/);
    await expect(mic).toHaveAttribute('aria-label', 'Stop recording');
    // A Windows renderer under full-suite load can take slightly over the
    // global 10s expect window to complete the local WebSocket handshake.
    await expect(mic).toHaveAttribute('data-voice-phase', 'recording', { timeout: 20_000 });
    await page.screenshot({ path: info.outputPath('voice-recording-en.png') });
    await mic.click();

    await expectComposerText(input, 'Draft: E2E dictated launch note');
    await expect(mic).not.toHaveClass(/\bis-recording\b|\bis-busy\b/);
    await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('voice-transcript.png') });
    expect(await page.evaluate(() => (window as any).__e2eVoiceTrackStops)).toBe(1);
    await expectPublicTicketTransport(voiceOrkas);
    writeFileSync(info.outputPath('voice-session-requests.json'), JSON.stringify(voiceOrkas.voiceSessionRequests, null, 2));
  });

  test('stopping during socket negotiation never starts a stale recording', async ({ voiceOrkas }, info) => {
    if (!voiceOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = voiceOrkas.page;
    voiceOrkas.setVoiceMode('blocked-open');
    await voiceOrkas.installVoiceCaptureStub();

    const input = page.locator('#new-chat-input');
    const mic = page.locator('#new-chat-mic-btn');
    await input.fill('Keep this draft');
    await mic.click();
    await expect(mic).toHaveAttribute('data-voice-phase', 'connecting');
    await expect(mic).toHaveClass(/\bis-busy\b/);
    await expect(mic).not.toHaveClass(/\bis-recording\b/);
    await expect(mic).toHaveAttribute('aria-label', 'Connecting…');
    await page.screenshot({ path: info.outputPath('voice-connecting-en.png') });
    await page.setViewportSize({ width: 760, height: 600 });
    await page.evaluate(async () => { await (window as any).setLang('zh'); });
    await expect(mic).toHaveAttribute('aria-label', '正在连接…');
    await page.screenshot({ path: info.outputPath('voice-connecting-zh-narrow.png') });
    await expect.poll(() => page.evaluate(() => (window as any).__e2eVoiceSocketUrls.length)).toBe(1);
    await mic.click();

    await expect(mic).not.toHaveClass(/\bis-recording\b|\bis-busy\b/);
    await expectComposerText(input, 'Keep this draft');
    await expect(page.locator('.ui-dialog-overlay:visible')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__e2eVoiceTrackStops)).toBe(1);
    await expectPublicTicketTransport(voiceOrkas);
  });

  test('requires a user API key without entering an account login flow', async ({ voiceOrkas }, info) => {
    const page = voiceOrkas.page!;
    await voiceOrkas.installVoiceCaptureStub();
    await voiceOrkas.invoke('orkasApi.remove');
    await page.locator('#new-chat-input').fill('Preserve my draft');
    await page.locator('#new-chat-mic-btn').click();
    await expect(page.locator('.ui-dialog-overlay:visible')).toContainText('Voice input requires an Orkas API key');
    await expectComposerText(page.locator('#new-chat-input'), 'Preserve my draft');
    await expect(page.locator('#account-login-overlay')).toHaveCount(0);
    expect(voiceOrkas.voiceSessionRequests).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).__e2eVoiceSocketUrls)).toEqual([]);
    await page.screenshot({ path: info.outputPath('voice-key-required.png') });
  });
});

const cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

test.describe('API-key voice input', () => {
  test('guides configuration without microphone access and preserves the draft', async ({ appPage }, testInfo) => {
    await appPage.locator('#new-chat-input').fill('Keep this draft');
    await appPage.locator('#new-chat-mic-btn').click();
    const dialog = appPage.locator('.ui-dialog-overlay.open');
    await expect(dialog).toContainText('Orkas API');
    await appPage.screenshot({ path: testInfo.outputPath('voice-key-guidance-en.png') });
    await dialog.locator('[data-act="choice"][data-id="configure"]').click();
    await expect(appPage.locator('#settings-orkas-api-key-input')).toBeFocused();
    await appPage.evaluate(() => (window as any).setView('new-chat'));
    await expectComposerText(appPage.locator('#new-chat-input'), 'Keep this draft');
    await appPage.setViewportSize({ width: 760, height: 600 });
    await appPage.evaluate(async () => { await (window as any).setLang('zh'); });
    await appPage.locator('#new-chat-mic-btn').click();
    await expect(dialog).toContainText('语音输入需要 Orkas API Key');
    await appPage.screenshot({ path: testInfo.outputPath('voice-key-guidance-zh-narrow.png') });
    const bounds = await dialog.locator('.modal').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(760);
    await dialog.locator('[data-act="cancel"]').click();
  });

  test('completes the real IPC and composer journey using a controlled recognition service', async ({ orkas }, testInfo) => {
    const page = orkas.page!;
    await orkas.electronApp!.evaluate(({ systemPreferences }) => {
      systemPreferences.getMediaAccessStatus = () => 'granted';
      const original = globalThis.fetch;
      globalThis.fetch = async (input, options) => String(input).endsWith('/audio/transcription_sessions')
        ? new Response(JSON.stringify({ ticket: 't'.repeat(43), expires_in: 30 }), { status: 200 })
        : original(input, options);
    });
    await page.evaluate(async () => {
      await (window as any).orkas.invoke('orkasApi.save', { apiKey: 'synthetic-voice-e2e-key' });
      const w = window as any;
      w.__voiceStops = 0;
      w.__voiceCaptures = 0;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => ({ getTracks: () => [{ stop() { w.__voiceStops++; } }] }) });
      const node = () => ({ connect() {}, disconnect() {} });
      w.AudioContext = class {
        constructor() { w.__voiceCaptures++; }
        state = 'running'; sampleRate = 48000; destination = {};
        audioWorklet = { addModule: async () => {} };
        createMediaStreamSource = node;
        createGain = () => ({ ...node(), gain: { value: 0 } });
        close = async () => {};
      };
      w.AudioWorkletNode = class {
        port = { onmessage: null as any, postMessage: (data: any) => {
          if (data.flush) queueMicrotask(() => this.port.onmessage?.({ data: { flushed: true } }));
        } };
        connect() {} disconnect() {}
      };
    });
    // Electron's CDP bridge does not intercept WebSockets through Playwright.
    // Use a real loopback peer; only the transport constructor is redirected.
    const server = createServer();
    const cleanup = ownFixtureServer(server);
    cleanups.push(cleanup);
    let sendReady: (() => void) | undefined;
    let sendResult: (() => void) | undefined;
    server.on('upgrade', (request, socket) => {
      const key = String(request.headers['sec-websocket-key']);
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const upgrade = () => socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      const ready = Buffer.from('{"event":"ready"}');
      upgrade();
      sendReady = () => { socket.write(Buffer.concat([Buffer.from([0x81, ready.length]), ready])); };
      let buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 6) {
          const size = buffer[1] & 127;
          if (size >= 126) { socket.destroy(); return; }
          if (buffer.length < size + 6) return;
          const payload = Buffer.from(buffer.subarray(6, size + 6));
          for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[2 + i % 4];
          const opcode = buffer[0] & 15;
          buffer = buffer.subarray(size + 6);
          if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
          if (opcode !== 1 || payload.toString() !== '__END__') continue;
          const result = Buffer.from(JSON.stringify({ is_last_package: true, payload_msg: { result: { text: 'E2E dictated note' } } }));
          sendResult = () => socket.write(Buffer.concat([Buffer.from([0x81, result.length]), result]));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await page.evaluate(port => {
      const Native = window.WebSocket;
      (window as any).WebSocket = class extends Native {
        constructor(url: string, protocols?: string | string[]) {
          if (!url.startsWith('wss://orkas.ai/api/voice/asr_ws?ticket=')) throw new Error('Unexpected voice destination');
          super('ws://127.0.0.1:' + port + '/api/voice/asr_ws', protocols);
          this.addEventListener('open', () => { (window as any).__voiceTransportOpen = true; });
        }
      };
    }, (server.address() as AddressInfo).port);
    await page.locator('#new-chat-input').fill('Draft:');
    await page.locator('#new-chat-input').evaluate(element => {
      const w = window as any; w.composerSetSelection(element, w.composerText(element).length);
    });
    await page.locator('#new-chat-mic-btn').click();
    const mic = page.locator('#new-chat-mic-btn');
    const expectActiveIcon = async () => {
      await expect(mic).toHaveCSS('color', 'rgb(220, 38, 38)');
      await expect(mic).toHaveCSS('animation-name', 'chat-mic-pulse');
      await expect(page.locator('.chat-mic-status:visible')).toHaveCount(0);
    };
    await expect(mic).toHaveAttribute('data-voice-phase', 'connecting');
    await expect.poll(() => page.evaluate(() => !!(window as any).__voiceTransportOpen)).toBe(true);
    await expect(mic).toHaveClass(/is-busy/);
    await expect(mic).not.toHaveClass(/is-recording/);
    await expect(mic).toHaveCSS('animation-name', 'none');
    await expect(mic).toHaveAttribute('aria-label', 'Connecting…');
    expect(await page.evaluate(() => (window as any).__voiceCaptures)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('voice-connecting-en.png') });
    await expect.poll(() => !!sendReady).toBe(true);
    await expect(page.locator('.ui-dialog-overlay.open')).toHaveCount(0);
    sendReady!();
    await expect(mic).toHaveAttribute('data-voice-phase', 'recording');
    await expectActiveIcon();
    expect(await page.evaluate(() => (window as any).__voiceCaptures)).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('voice-recording-en.png') });
    await page.setViewportSize({ width: 760, height: 600 });
    await page.evaluate(async () => { await (window as any).setLang('zh'); });
    await expectActiveIcon();
    await expect(mic).toHaveAttribute('aria-label', '停止录音');
    await page.screenshot({ path: testInfo.outputPath('voice-recording-zh-narrow.png') });
    await page.locator('#new-chat-mic-btn').click();
    await expect(mic).toHaveAttribute('data-voice-phase', 'finalizing');
    await expect(mic).toHaveCSS('color', 'rgb(148, 163, 184)');
    await expect(mic).toHaveCSS('animation-name', 'none');
    await expect(page.locator('.chat-mic-status:visible')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('voice-finalizing-zh-narrow.png') });
    await expect.poll(() => !!sendResult).toBe(true);
    sendResult!();
    await expectComposerText(page.locator('#new-chat-input'), 'Draft: E2E dictated note');
    await expect(page.locator('#new-chat-mic-btn')).toHaveAttribute('data-voice-phase', 'idle');
    expect(await page.evaluate(() => (window as any).__voiceStops)).toBe(1);
    await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(0);
  });
});
