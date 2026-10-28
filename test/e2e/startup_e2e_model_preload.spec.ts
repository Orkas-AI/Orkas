import { expect, test } from '@playwright/test';
import { OrkasTestApp } from './fixtures/orkas';
import { checkLatencyBudget } from '../helpers/latency-budget';
const { collectLogFiles } = require('./fixtures/electron-log-files.cjs');

test('prepares the selected API after boot without requests and keeps Main responsive', async ({}, testInfo) => {
  const app = new OrkasTestApp(testInfo, { modelStub: true });
  try {
    await app.launch();
    const page = app.page!;
    await expect(page.locator('html')).toHaveAttribute('data-orkas-boot-ready', 'true');
    expect(app.modelRequests).toHaveLength(0);
    expect(collectLogFiles(app.root)).not.toContain('model API preload finished');
    await app.electronApp!.evaluate(({ app }) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const boot = require(`${app.getAppPath()}/src/main/util/boot_init`);
      boot.noteBootUserActivity();
      const pulse = { last: performance.now(), maxGapMs: 0, timer: null as any };
      pulse.timer = setInterval(() => {
        const now = performance.now();
        pulse.maxGapMs = Math.max(pulse.maxGapMs, now - pulse.last - 10);
        pulse.last = now;
      }, 10);
      (globalThis as any).__preloadPulse = pulse;
    });
    await expect.poll(() => collectLogFiles(app.root).includes('model API preload finished'), {
      timeout: 30_000, intervals: [500],
    }).toBe(true);
    expect(app.modelRequests).toHaveLength(0);
    const pulse = await app.electronApp!.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      const pulse = (globalThis as any).__preloadPulse;
      clearInterval(pulse.timer);
      delete (globalThis as any).__preloadPulse;
      return { maxGapMs: pulse.maxGapMs };
    });
    checkLatencyBudget('main loop response during idle API preload', { elapsedMs: pulse.maxGapMs });
    await page.locator('#new-chat-input').fill('Reply after idle preparation.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]'))
      .toContainText('Hello from the local E2E model.', { timeout: 30_000 });
    expect(app.modelRequests).toHaveLength(1);
    await expect(page.locator('#chat-input')).toBeEditable();
    await testInfo.attach('preload-responsiveness', {
      body: JSON.stringify({ boot_ready_ms: app.lastLaunchReadyMs, main_loop_gap_ms: pulse.maxGapMs }),
      contentType: 'application/json',
    });
  } finally { await app.dispose(); }
});
