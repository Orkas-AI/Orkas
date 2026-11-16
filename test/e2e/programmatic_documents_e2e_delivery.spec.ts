import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import AdmZip from 'adm-zip';
import { expect, test, type OrkasTestApp } from './fixtures/orkas';

/** Final text can precede produced-file commitment. Await the real turn owner
 * using this build's active local identity, without a hosted account fixture. */
async function waitForOutputPublication(app: OrkasTestApp): Promise<void> {
  const cid = await app.page!.evaluate<string>('currentCid');
  expect(typeof cid).toBe('string');
  expect(cid).not.toBe('');
  await expect.poll(() => app.electronApp!.evaluate((_electron, conversationId) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const uid = req('./src/main/features/users.ts').getActiveUserId();
    return req('./src/main/features/group_chat/bus.ts').isQuiescent(uid, conversationId);
  }, cid), { timeout: 20_000 }).toBe(true);
}

test('a program-created Word file reaches the next model request with a real native preview', async ({ modelOrkas: app }, info) => {
  const page = app.page!;
  // This transport case uses local fallback fonts, independently of remote
  // font CSS availability. Native OfficeCLI and Chromium rendering stay real.
  await app.electronApp!.context().route(url =>
    ['d.officecli.ai', 'fonts.googleapis.com'].includes(url.hostname) && url.pathname.endsWith('/css2'),
  route => route.fulfill({ status: 200, contentType: 'text/css', body: '/* Local system fallback fonts. */' }));
  const output = path.join(app.userWorkspaceRoot, 'quarterly.docx');
  let invoked = false;
  app.setModelRequestScript((_request, tools) => {
    if (!tools.has('create_docx')) return { calls: [{ callId: 'load-word', name: 'tool_load', args: { groups: ['office.word'] } }] };
    if (invoked) return { text: 'The Word report is ready for review.' };
    invoked = true;
    return { calls: [{ callId: 'program-word', name: 'run_program', args: { code: `
      const report = await tools.create_docx({ path: ${JSON.stringify(output)}, locale: 'en-US', paragraphs: [{ text: 'Quarterly report 42', font: 'Arial' }] });
      if (!report.ok) throw Error(report.content);
      text('The editable Word report was created.');
    ` } }] };
  });
  await page.locator('#new-chat-input').fill('Create an editable Word report with the quarterly revenue of 42.');
  await page.locator('#new-chat-send-btn').click();
  await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText('The Word report is ready for review.', { timeout: 60000 });
  await waitForOutputPublication(app);
  await expect(page.locator('#chat-history .chat-msg-produced-item')).toContainText('quarterly.docx');
  expect(new AdmZip(output).readAsText('word/document.xml')).toContain('Quarterly report 42');
  // Inspect the actual serialized provider request, after the normal Host cap
  // and SDK conversion. Tool text alone cannot prove model-visible pixels.
  const previewUrls = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(previewUrls);
    if (!value || typeof value !== 'object') return [];
    const block = value as Record<string, any>;
    if (block.type === 'input_image' && typeof block.image_url === 'string') return [block.image_url];
    if (block.type === 'image_url' && typeof block.image_url?.url === 'string') return [block.image_url.url];
    return Object.values(block).flatMap(previewUrls);
  };
  const request = app.modelRequests.at(-1)!;
  const images = previewUrls(request.input ?? request.messages);
  expect(images.length).toBe(1);
  expect(images[0].startsWith('data:image/png;base64,')).toBe(true);
  const pixels = Buffer.from(images[0].split(',')[1], 'base64');
  expect(pixels.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  writeFileSync(info.outputPath('native-word-model-preview.png'), pixels);
});

test('a program creates and edits a PDF, saves it in the project and delivers only the selected file plus a navigation card', async ({ modelOrkas: app }, info) => {
  const page = app.page!;
  const created = await app.invoke<any>('projects.create', { name: 'Program documents' });
  const projectId = created.project.project_id;
  const workspace = await app.electronApp!.evaluate((_electron, projectId) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const uid = req('./src/main/features/users.ts').getActiveUserId();
    return req('./src/main/features/user_workspace.ts').getWorkspacePath(uid, projectId);
  }, projectId);
  const draft = path.join(workspace, 'draft.pdf');
  const final = path.join(workspace, 'final.pdf');
  let invoked = false;
  app.setModelRequestScript((_request, tools) => {
    if (!tools.has('create_pdf') || !tools.has('open_app_view')) return { calls: [{ callId: 'load-documents', name: 'tool_load', args: { groups: ['office.pdf', 'management.app'] } }] };
    if (invoked) return { text: 'The final PDF is saved. Open Apps using the card below.' };
    invoked = true;
    return { calls: [{ callId: 'program-documents', name: 'run_program', args: { code: `
      const draft = await tools.create_pdf({ path: ${JSON.stringify(draft)}, source_type: 'markdown', content: '# Quarterly report\\n\\nRevenue 42.' });
      if (!draft.ok) throw Error(draft.content);
      const firstSelection = await tools.publish_outputs({ paths: [${JSON.stringify(draft)}] });
      if (!firstSelection.ok) throw Error(firstSelection.content);
      const edited = await tools.edit_pdf({ action: 'rotate_pages', input_path: ${JSON.stringify(draft)}, output_path: ${JSON.stringify(final)}, degrees: 90 });
      if (!edited.ok) throw Error(edited.content);
      const saved = await tools.library_save({ source_path: ${JSON.stringify(final)}, name: 'Final report.pdf' });
      if (!saved.ok) throw Error(saved.content);
      const selected = await tools.publish_outputs({ paths: [${JSON.stringify(final)}] });
      if (!selected.ok) throw Error(selected.content);
      const unknown = await tools.open_app_view({ surface_id: 'not-a-surface' });
      if (unknown.ok || !JSON.parse(unknown.content).error.includes('unknown surface_id')) throw Error('Unknown navigation accepted');
      const missingTarget = await tools.open_app_view({ surface_id: 'apps', action: 'configure' });
      if (missingTarget.ok || !JSON.parse(missingTarget.content).error.includes('target_id is required')) throw Error('Missing target accepted');
      for (let i = 0; i < 2; i++) {
        const card = await tools.open_app_view({ surface_id: 'apps' });
        if (!card.ok) throw Error(card.content);
        const receipt = JSON.parse(card.content);
        if (receipt.status !== 'navigation_card_staged' || receipt.surface_id !== 'apps' || receipt.action !== 'open') throw Error('Navigation parameters changed');
      }
      text('Requested deliverables prepared.');
    ` } }] };
  });
  await page.evaluate(id => (window as any).setView('project', id), projectId);
  await page.locator('#project-chat-input').fill('Create a quarterly report PDF, rotate it, save it in this project and show me the Apps shortcut.');
  await page.locator('#project-chat-send-btn').click();
  await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText('The final PDF is saved.', { timeout: 60000 });
  await waitForOutputPublication(app);
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  const request = app.modelRequests.at(-1)!;
  expect(JSON.stringify(request.input ?? request.messages)).toContain('Program completed after 9 tool calls');
  const cid = await page.evaluate<string>('currentCid');
  const files = page.locator('#chat-history .chat-msg-produced-item');
  await expect(files).toHaveCount(1);
  await expect(files).toContainText('final.pdf');
  const nav = page.locator('#chat-history [data-app-nav]');
  await expect(nav).toHaveCount(1);
  await expect(page.locator('#panel-apps')).not.toHaveClass(/\bactive\b/);
  expect(existsSync(draft)).toBe(true);
  expect(readFileSync(final).subarray(0, 5).toString()).toBe('%PDF-');
  const document = await PDFDocument.load(readFileSync(final));
  expect(document.getPages().map(page => page.getRotation().angle)).toEqual([90]);
  const library = await app.invoke<any>('projects.files.absPath', { projectId, name: 'Final report.pdf' });
  expect(readFileSync(library.path)).toEqual(readFileSync(final));
  await page.locator('#chat-history .chat-message.assistant').screenshot({ path: info.outputPath('program-document-delivery.png') });
  await page.reload();
  await page.evaluate(async cid => { await (window as any).loadConversations(); (window as any).setView('conversation', cid); }, cid);
  await expect(files).toHaveCount(1);
  await expect(files).toContainText('final.pdf');
  await expect(nav).toHaveCount(1);
  await nav.click();
  await expect(page.locator('#panel-apps')).toHaveClass(/\bactive\b/);
});

async function sendAndWait(app: OrkasTestApp, request: string, reply: string): Promise<void> {
  const page = app.page!;
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill(request);
  await page.locator('#new-chat-send-btn').click();
  await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', { hasText: reply }))
    .toBeVisible({ timeout: 30_000 });
  await waitForOutputPublication(app);
}

for (const sourceType of ['markdown', 'html'] as const) {
  test(`delivers an exact ${sourceType} PDF through chat and preserves its authored text`, async ({ modelOrkas }, testInfo) => {
    const checkpoints: Array<{ phase: string; at: string }> = [];
    const mark = (phase: string) => { checkpoints.push({ phase, at: new Date().toISOString() }); writeFileSync(testInfo.outputPath('pdf-progress.json'), JSON.stringify(checkpoints)); };
    mark('seed');
    const outputPath = path.join(modelOrkas.userWorkspaceRoot, `report-${sourceType}.pdf`);
    const body = sourceType === 'markdown' ? '# Quarterly report\n\nRevenue 42. Retained content.'
      : '<!doctype html><html><body><h1>Quarterly report</h1><p>Revenue 42. Retained content.</p></body></html>';
    const reply = `The ${sourceType} report is ready.`;
    modelOrkas.setCreatePdfScenario(sourceType, body, outputPath, reply);
    mark('create');
    await sendAndWait(modelOrkas, 'Create the quarterly report as a PDF.', reply);
    mark('published');
    await expect(modelOrkas.page!.locator('.chat-msg-produced-item', { hasText: path.basename(outputPath) })).toBeVisible();
    expect(existsSync(outputPath)).toBe(true);
    const publishedBytes = readFileSync(outputPath);
    expect(publishedBytes.subarray(0, 5).toString()).toBe('%PDF-');
    // Inspect the actual bytes independently, as the ImageStudio PDF journeys
    // do. Calling the app's extractor through the Electron debugger can stall
    // a reused worker; it is not part of the publication outcome under test.
    mark('extract');
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(publishedBytes), isEvalSupported: false });
    const pages: string[] = [];
    try {
      const document = await task.promise;
      for (let page = 1; page <= document.numPages; page++) {
        const content = await (await document.getPage(page)).getTextContent();
        pages.push(content.items.map((item: any) => item.str || '').join(' '));
      }
    } finally { await task.destroy(); }
    mark('extracted');
    expect(pages).toHaveLength(1);
    expect(pages[0].replace(/\s+/g, ' ').trim()).toBe('Quarterly report Revenue 42. Retained content.');
    // Retrying publication cannot regenerate a different PDF or append a mark.
    await modelOrkas.electronApp!.evaluate(async (_electron, file) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      await req('./src/main/features/produced_output_hooks.ts').finalizeProducedFile(file, { userId: req('./src/main/features/users.ts').getActiveUserId() });
    }, outputPath);
    expect(readFileSync(outputPath)).toEqual(publishedBytes);
    mark('complete');
  });
}

test('keeps a real text deliverable unchanged after restart and language changes', async ({ modelOrkas }) => {
  await modelOrkas.relaunch();
  const page = modelOrkas.page!;
  const outputPath = path.join(modelOrkas.userWorkspaceRoot, 'report.md');
  const content = '# Quarterly report\n\nRevenue 42.\n';
  modelOrkas.setWriteFileScenario(outputPath, content, 'The text report is ready.');
  await sendAndWait(modelOrkas, 'Write the quarterly report.', 'The text report is ready.');
  await expect(page.locator('.chat-msg-produced-item', { hasText: 'report.md' })).toBeVisible();
  expect(readFileSync(outputPath, 'utf8')).toBe(content);
  for (const language of ['en', 'zh'] as const) {
    await page.evaluate(async lang => { await (window as any).setLang(lang); }, language);
    expect(readFileSync(outputPath, 'utf8')).toBe(content);
  }
});
