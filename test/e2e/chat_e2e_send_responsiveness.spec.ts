import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';
import { checkLatencyBudget } from '../helpers/latency-budget';

// Real renderer -> IPC -> main -> SDK, using the existing isolated local model.
// The second case proves a main-process stall cannot hide behind a fast cached paint.
for (const injectedStallMs of [0, 600]) {
  test(`switches from sending A to B with a responsive main process (injected stall ${injectedStallMs} ms)`, async ({ modelOrkas }) => {
    const page = modelOrkas.page!;
    const app = modelOrkas.electronApp!;
    const marker = 'Conversation B remains readable.';
    await page.locator('#new-chat-input').fill(marker);
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]'))
      // Cold-start setup is outside the 500 ms send/switch measurement below.
      .toContainText('Hello from the local E2E model.', { timeout: 30_000 });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    const cidB = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
    expect(cidB).toBeTruthy();
    const created = await modelOrkas.invoke<{ conversation: { conversation_id: string } }>(
      'conversations.create', { title: 'Conversation A' },
    );
    await page.evaluate(async () => (window as any).loadConversations());
    await page.locator(`#conversation-list .conv-item[data-cid="${created.conversation.conversation_id}"]`).click();
    await expect(page.locator('#chat-header-title')).toHaveText('Conversation A');
    await expect(page.locator('#chat-history')).not.toContainText(marker);
    await page.locator('#chat-input').fill('Send while I read another conversation.');

    // Match the reported large catalog without account data or external MCP calls.
    const catalog = Array.from({ length: 133 }, (_, i) => ({
      id: `latency-service-${i}`, display_name: `Service ${i}`, category: 'productivity',
      auth_mode: 'mcp_dcr', icon_svg: `<svg>${'x'.repeat(28_000)}</svg>`,
      transport_template: { kind: 'streamable-http', url: 'https://example.com/mcp' },
    }));
    const { remoteFile, connectorsFile } = await app.evaluate(({ app }) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const paths = require(`${app.getAppPath()}/src/main/paths`);
      const { getActiveUserId } = require(`${app.getAppPath()}/src/main/features/users`);
      const uid = getActiveUserId();
      return { remoteFile: paths.userRemoteConfigFile(uid), connectorsFile: paths.userConnectorsConfigFile(uid) };
    });
    let remote: any = {};
    try { remote = JSON.parse(readFileSync(remoteFile, 'utf8')); } catch { /* Empty fixture config. */ }
    remote.active = { ...remote.active, immediate: { ...remote.active?.immediate, 'connectors.catalog': catalog } };
    mkdirSync(path.dirname(remoteFile), { recursive: true });
    writeFileSync(remoteFile, JSON.stringify(remote));
    writeFileSync(connectorsFile, JSON.stringify({
      version: 2, oauth_hints: {}, _deleted_at: {},
      connections: Object.fromEntries(catalog.slice(0, 10).map(entry => [entry.id, {
        id: entry.id, origin: 'catalog', display_name: entry.display_name, transport: null,
        status: { kind: 'connected', since: 1 }, enabled_subtools: null,
        tools_cache: [{ name: 'read_items', description: 'Read items', inputSchema: { type: 'object' } }],
        created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z',
      }])),
    }));
    const requestsBefore = modelOrkas.modelRequests.length;
    await app.evaluate(({ app }, { remoteFile, injectedStallMs }) => {
      const g = globalThis as any;
      const pulse = { last: performance.now(), maxGapMs: 0, injected: false, timer: null as any };
      pulse.timer = setInterval(() => {
        const now = performance.now();
        pulse.maxGapMs = Math.max(pulse.maxGapMs, now - pulse.last - 10);
        pulse.last = now;
      }, 10);
      g.__sendLatencyPulse = pulse;
      if (injectedStallMs) {
        const require = (process as any).mainModule.require.bind((process as any).mainModule);
        // Hook the native file-version check: TS module exports can be getter-only,
        // and a prior read may already have populated the parsed config cache.
        const fs = require('node:fs');
        const original = fs.statSync;
        fs.statSync = function (file: string, ...args: any[]) {
          if (file === remoteFile && !pulse.injected) {
            pulse.injected = true;
            fs.statSync = original;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, injectedStallMs);
          }
          return original(file, ...args);
        };
      }
    }, { remoteFile, injectedStallMs });

    // Schedule the click immediately after Send inside the renderer. Sequential
    // Playwright clicks could wait out the stall before starting the measurement.
    const switchMs = await page.evaluate(({ cidB, marker }) => new Promise<number>((resolve, reject) => {
      const rowSelector = `#conversation-list .conv-item[data-cid="${cidB}"]`;
      const startedAt = performance.now();
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Conversation switch did not finish')); }, 5000);
      const observer = new MutationObserver(() => {
        if (!document.querySelector('#chat-history')?.textContent?.includes(marker)) return;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(performance.now() - startedAt);
      });
      observer.observe(document.getElementById('chat-history')!, { childList: true, subtree: true, characterData: true });
      document.getElementById('chat-send-btn')!.click();
      setTimeout(() => (document.querySelector(rowSelector) as HTMLElement).click(), 0);
    }), { cidB, marker });
    await expect.poll(() => modelOrkas.modelRequests.length).toBe(requestsBefore + 1);
    const pulse = await app.evaluate(async () => {
      // Drain one timer tick: even a stall ending at the request boundary must count.
      await new Promise(resolve => setTimeout(resolve, 20));
      const g = globalThis as any;
      const pulse = g.__sendLatencyPulse;
      clearInterval(pulse.timer);
      delete g.__sendLatencyPulse;
      return { maxGapMs: pulse.maxGapMs as number, injected: pulse.injected as boolean };
    });
    await expect(page.locator('#chat-history')).toContainText(marker);
    await expect(page.locator('#chat-history')).not.toContainText('Send while I read another conversation.');
    await expect(page.locator('#chat-input')).toBeEditable();
    const historyA = await modelOrkas.invoke<{ history: Array<{ from: string; text: string }> }>(
      'conversations.history', { cid: created.conversation.conversation_id, limit: 10 },
    );
    expect(historyA.history.filter(message => message.from === 'user').map(message => message.text))
      .toEqual(['Send while I read another conversation.']);
    console.log('[send-responsiveness]', JSON.stringify({ switch_ms: switchMs, main_loop_gap_ms: pulse.maxGapMs, injected_stall_ms: injectedStallMs }));
    if (injectedStallMs) {
      expect(pulse.injected).toBe(true);
      expect(() => checkLatencyBudget('main loop response negative control', { elapsedMs: pulse.maxGapMs }))
        .toThrow('budget 500 ms');
    } else {
      checkLatencyBudget('send A then open B', { elapsedMs: switchMs });
      checkLatencyBudget('main loop response during send', { elapsedMs: pulse.maxGapMs });
    }
  });
}
