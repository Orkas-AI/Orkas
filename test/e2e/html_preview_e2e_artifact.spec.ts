import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';
import sharp from 'sharp';

function providerImageUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(providerImageUrls);
  if (!value || typeof value !== 'object') return [];
  const block = value as Record<string, any>;
  if (block.type === 'input_image' && typeof block.image_url === 'string') return [block.image_url];
  if (block.type === 'image_url' && typeof block.image_url?.url === 'string') return [block.image_url.url];
  return Object.values(block).flatMap(providerImageUrls);
}


test('a program creates one visible app then previews its returned ID with two lossless images in the next model request', async ({ modelOrkas: app }, info) => {
  const page = app.page!;
  const scale = await app.electronApp!.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
  const title = 'Program preview app';
  const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{margin:24px;font:18px sans-serif;color:#173453;background:#f2f6fc}
    button{font:inherit;padding:12px;background:#173453;color:white}
    button:focus-visible{outline:3px solid #d24f00;outline-offset:3px}</style>
    <h1>Preview report</h1><p id="status">Ready</p><button id="check">Check report</button>
    <script src="__orkas/bridge.js"></script><script>document.getElementById('check').onclick=()=>{
    window.orkasArtifact.send('Report checked');document.getElementById('status').textContent='Checked';};</script>`;
  let invoked = false;
  app.setModelRequestScript((_request, tools) => {
    if (!tools.has('html_preview')) return { calls: [{ callId: 'load-preview', name: 'tool_load', args: { groups: ['workspace.artifact'] } }] };
    if (invoked) return { text: 'The app preview passed at both requested sizes.' };
    invoked = true;
    return { calls: [{ callId: 'program-app-preview', name: 'run_program', args: { code: `
      const app = await tools.create_artifact({ title: ${JSON.stringify(title)}, files: [{ path: 'index.html', content: ${JSON.stringify(html)} }] });
      if (!app.ok) throw Error(app.content);
      const id = app.content.split('(id ')[1].split(')')[0];
      const preview = await tools.html_preview({ artifact_id: id, target: 'responsive', screenshots: true,
        desktop: { width: 1280, height: 720 }, mobile: { width: 360, height: 780 } });
      if (!preview.ok) throw Error(preview.content);
      const evidence = JSON.parse(preview.content);
      if (evidence.viewports[0].width !== 1280 || evidence.viewports[0].height !== 720
        || evidence.viewports[1].width !== 360 || evidence.viewports[1].height !== 780) throw Error('Requested viewport changed');
      if (evidence.interactions.artifactMessagesObserved < 1 || evidence.interactions.stateChangesObserved < 1) throw Error('Bridge interaction not observed');
      text(preview.content);
    ` } }] };
  });
  await page.locator('#new-chat-input').fill('Create a report app and check it at desktop and mobile sizes.');
  await page.locator('#new-chat-send-btn').click();
  await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText('The app preview passed', { timeout: 60000 });
  const cards = page.locator('#chat-history .chat-artifact-card');
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(title);
  const request = app.modelRequests.at(-1)!;
  expect(JSON.stringify(request.input ?? request.messages)).toContain('Program completed after 2 tool calls');
  const images = providerImageUrls(request.input ?? request.messages);
  expect(images).toHaveLength(2);
  for (const [index, url] of images.entries()) {
    expect(url).toMatch(/^data:image\/webp;base64,/);
    const pixels = Buffer.from(url.split(',')[1], 'base64');
    const metadata = await sharp(pixels).metadata();
    // capturePage preserves physical pixels on high-DPI displays; viewport
    // parameters above are CSS pixels, not the encoded image dimensions.
    expect([metadata.width, metadata.height]).toEqual((index === 0 ? [1280, 720] : [360, 780]).map(size => size * scale));
    writeFileSync(info.outputPath(`program-app-preview-${index}.webp`), pixels);
  }
  const cid = await page.evaluate<string>('currentCid');
  await page.reload();
  await page.evaluate(async cid => { await (window as any).loadConversations(); (window as any).setView('conversation', cid); }, cid);
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(title);
});

test('a program receives real overflow diagnostics without images then explicitly recovers with one mobile screenshot', async ({ modelOrkas: app }, info) => {
  const scale = await app.electronApp!.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
  const broken = app.createWorkspaceFile('program-preview/broken.html', `<!doctype html><style>body{margin:0}main{width:900px}</style><main>Report too wide</main>`);
  const good = app.createWorkspaceFile('program-preview/good.html', `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font:18px sans-serif;margin:24px}button:focus-visible{outline:3px solid blue}</style>
    <h1>Mobile report</h1><button onclick="this.textContent='Checked'">Check</button>`);
  let invoked = false;
  app.setModelRequestScript((_request, tools) => {
    if (!tools.has('html_preview')) return { calls: [{ callId: 'load-preview', name: 'tool_load', args: { groups: ['workspace.artifact'] } }] };
    if (invoked) return { text: 'The overflow was detected and the corrected mobile preview passed.' };
    invoked = true;
    return { calls: [{ callId: 'program-file-preview', name: 'run_program', args: { code: `
      const failed = await tools.html_preview({ path: ${JSON.stringify(broken)}, target: 'mobile', screenshots: true, interactions: false });
      if (failed.ok) throw Error('Overflow was accepted');
      const rejected = JSON.parse(failed.content);
      if (rejected.visual_evidence.attached || rejected.viewports[0].horizontalOverflowPx <= 1) throw Error('Missing overflow diagnostics');
      text(failed.content);
      const recovered = await tools.html_preview({ path: ${JSON.stringify(good)}, target: 'mobile', screenshots: true,
        interactions: false, mobile: { width: 320, height: 480 } });
      if (!recovered.ok) throw Error(recovered.content);
      const evidence = JSON.parse(recovered.content);
      if (evidence.viewports[0].width !== 320 || evidence.viewports[0].height !== 480 || evidence.interactions.performed) throw Error('Mobile options changed');
      text(recovered.content);
    ` } }] };
  });
  await app.page!.locator('#new-chat-input').fill('Check the mobile HTML report, then review the corrected version.');
  await app.page!.locator('#new-chat-send-btn').click();
  await expect(app.page!.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText('corrected mobile preview passed', { timeout: 60000 });
  const request = app.modelRequests.at(-1)!;
  expect(JSON.stringify(request.input ?? request.messages)).toContain('Program completed after 2 tool calls');
  const images = providerImageUrls(request.input ?? request.messages);
  expect(images).toHaveLength(1);
  const pixels = Buffer.from(images[0].split(',')[1], 'base64');
  const metadata = await sharp(pixels).metadata();
  expect([metadata.width, metadata.height]).toEqual([320 * scale, 480 * scale]);
  writeFileSync(info.outputPath('program-mobile-recovery.webp'), pixels);
});

test('creates an app and previews its ID with a working host bridge and no workspace copy', async ({ sdkOrkas: orkas }, info) => {
  const workspaceEntry = orkas.createWorkspaceFile('preview-artifact/placeholder.txt', 'Workspace remains separate.');
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const { createLocalTools } = req(`${args.pcRoot}/src/main/model/core-agent/local-tools.ts`);
    const { getActiveUserId } = req(`${args.pcRoot}/src/main/features/users.ts`);
    const artifacts = req(`${args.pcRoot}/src/main/features/chat_artifacts.ts`);
    const fs = req('node:fs');
    const path = req('node:path');
    const uid = getActiveUserId();
    const cid = 'artifact-preview-e2e';
    let artifactId = '';
    const tools = createLocalTools({ userId: uid, cid,
      onArtifactCreated: (artifact: { id: string }) => { artifactId = artifact.id; } });
    const context = { workingDir: path.dirname(args.workspaceEntry), state: {} };
    const created = await tools.find((t: any) => t.name === 'create_artifact').execute({
      files: [{ path: 'index.html', content: `<!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font:18px sans-serif;padding:24px;color:#173453;background:#f2f6fc}
        button{font:inherit;padding:12px;background:#173453;color:white}
        button:focus-visible{outline:3px solid #d24f00;outline-offset:3px}</style>
        <h1>Artifact preview</h1><p id="status">Ready</p><button id="send">Send update</button>
        <script src="__orkas/bridge.js"></script><script>
        document.getElementById('send').onclick=()=>{
          window.orkasArtifact.send('Preview checked');
          document.getElementById('status').textContent='Bridge worked';
        };</script>` }],
    }, context);
    const entry = artifacts.resolveArtifactFilePath(uid, cid, artifactId, 'index.html');
    const before = entry.ok ? fs.readFileSync(entry.absPath, 'utf8') : '';
    const preview = await tools.find((t: any) => t.name === 'html_preview').execute({
      artifact_id: artifactId, target: 'responsive', screenshots: true,
    }, context);
    const other = createLocalTools({ userId: uid, cid: 'other-conversation' });
    const rejected = await other.find((t: any) => t.name === 'html_preview').execute({ artifact_id: artifactId }, context);
    return { createdError: created.isError, artifactId, preview, rejected,
      sourceUnchanged: entry.ok && fs.readFileSync(entry.absPath, 'utf8') === before,
      workspaceCopy: fs.existsSync(path.join(context.workingDir, 'index.html')),
      bridgeOnDisk: entry.ok && fs.existsSync(path.join(path.dirname(entry.absPath), '__orkas', 'bridge.js')) };
  }, { pcRoot: path.resolve(__dirname, '../..'), workspaceEntry });
  writeFileSync(info.outputPath('artifact-preview.json'), JSON.stringify({ ...result,
    preview: { ...result.preview, images: undefined } }, null, 2));
  expect(result.createdError).toBeUndefined();
  expect(result.preview.isError, result.preview.content).toBeUndefined();
  const evidence = JSON.parse(result.preview.content);
  expect(evidence).toMatchObject({ ok: true, artifact_id: result.artifactId, blockedResourceCount: 0 });
  expect(evidence).not.toHaveProperty('entryPath');
  expect(evidence.interactions.artifactMessagesObserved).toBeGreaterThan(0);
  expect(evidence.interactions.stateChangesObserved).toBeGreaterThan(0);
  expect(result.preview.images).toHaveLength(2);
  result.preview.images.forEach((image: { data: string }, index: number) =>
    writeFileSync(info.outputPath(`artifact-${index}.webp`), Buffer.from(image.data, 'base64')));
  expect(result.rejected.isError).toBe(true);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.workspaceCopy).toBe(false);
  expect(result.bridgeOnDisk).toBe(false);
});
