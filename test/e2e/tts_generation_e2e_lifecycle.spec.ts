import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, OrkasTestApp, test } from './fixtures/orkas';

test.describe('TTS generation lifecycle', () => {
  test('runs the real chat-to-tool-to-provider-to-audio-file path once', async ({}, testInfo) => {
    const audio = Buffer.from([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0xff, 0xfb, 0x90, 0x64,
    ]);
    const requests: Array<{
      authorization: string;
      body: Record<string, unknown>;
    }> = [];
    const provider = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/audio/speech') {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        requests.push({
          authorization: String(request.headers.authorization || ''),
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        response.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(audio.length),
        });
        response.end(audio);
      });
    });
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', () => {
        provider.off('error', reject);
        resolve();
      });
    });

    const address = provider.address() as AddressInfo;

    const app = new OrkasTestApp(testInfo, { modelStub: true });
    try {
      await app.launch();
      if (!app.page) throw new Error('Orkas renderer is unavailable');
      await expect(app.invoke('ttsAuth.add', {
        provider: 'custom',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: 'e2e-speech-model',
        apiKey: 'e2e-speech-secret',
        voice: 'e2e-speech-voice',
        format: 'mp3',
        label: 'E2E speech provider',
      })).resolves.toMatchObject({ ok: true });
      const outputPath = path.join(app.userWorkspaceRoot, 'tts-e2e', 'narration.mp3');
      app.setGenerateSpeechScenario(
        'The release is ready for review.',
        outputPath,
        'E2E speech generation completed once.',
      );

      await app.page.locator('#new-chat-btn').click();
      await app.page.locator('#new-chat-input').fill('Create the deterministic E2E narration.');
      await app.page.locator('#new-chat-send-btn').click();

      await expect(app.page.locator(
        '#chat-history .chat-message.assistant [data-role="final"]',
        { hasText: 'E2E speech generation completed once.' },
      )).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => app.modelRequests.length).toBe(2);
      expect(JSON.stringify(app.modelRequests[1])).toContain('Speech written to');
      await expect.poll(() => existsSync(outputPath)).toBe(true);
      expect(readFileSync(outputPath)).toEqual(audio);
      expect(requests).toEqual([{
        authorization: 'Bearer e2e-speech-secret',
        body: {
          model: 'e2e-speech-model',
          input: 'The release is ready for review.',
          voice: 'e2e-speech-voice',
          response_format: 'mp3',
        },
      }]);
      expect(app.modelRequests).toHaveLength(2);
      const postToolMessages = app.modelRequests[1].messages as Array<{
        role?: unknown;
        content?: unknown;
      }>;
      const toolResult = postToolMessages.find((message) => (
        message.role === 'tool'
        && typeof message.content === 'string'
        && message.content.includes('Speech written to')
      ));
      expect(toolResult).toBeDefined();
      expect(toolResult?.content).toContain('chat_media_url');
      expect(toolResult?.content).toContain(outputPath);
    } finally {
      await app.dispose();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
});
