import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';

test('a descriptive file-link label does not hide the CSV format', async ({ orkas }) => {
  const file = orkas.createWorkspaceFile('report.csv', 'name,value\nOrkas,12\n');
  const preview = await orkas.openPreview(() => orkas.page!.evaluate(file =>
    (window as any).openChatFileViewer(file, '查看数据'), file));
  await expect(preview.locator('.chat-file-viewer-body')).toContainText('Orkas');
});

test('CSV opens from task attachments and the Library without changing cell contents', async ({ orkas }, info) => {
  const page = orkas.page!;
  const bytes = readFileSync(path.resolve(__dirname, '../fixtures/files/sample.csv'));
  const created: any = await orkas.invoke('conversations.create', { title: 'CSV files' });
  const cid = created.conversation.conversation_id;
  const uploaded: any = await orkas.invoke('conversations.attachments.upload', { cid, name: 'sample.csv', data: bytes.toString('base64') });
  expect(uploaded.ok).toBe(true);
  const resolved: any = await orkas.invoke('attachments.absPath', { cid, name: 'sample.csv' });
  expect(resolved.ok).toBe(true);
  const preview = await orkas.openPreview(() => page.evaluate(args =>
    (window as any).openChatFileViewer(args.path, 'sample.csv', { cid: args.cid }), { path: resolved.path, cid }));
  await expect(preview.locator('.chat-file-viewer-body')).toContainText('中文样本');
  await preview.screenshot({ path: info.outputPath('csv-task.png') });
  await expect(preview.locator('.delimited-preview td').filter({ hasText: '包含,逗号' })).toHaveCount(1);
  await expect(preview.locator('.delimited-preview td').filter({ hasText: '<b>原样文本</b>' })).toHaveCount(1);
  await preview.locator('[data-delimited-toggle]').click();
  await expect(preview.locator('pre')).toContainText('"包含,逗号"');
  await preview.locator('[data-tve-action="edit"]').click();
  const edited = bytes.toString('utf8').replace(/^\uFEFF/, '').replace('普通文本', '已编辑');
  await preview.locator('[data-tve-textarea]').fill(edited);
  await preview.locator('[data-tve-action="save"]').click();
  await expect(preview.locator('.delimited-preview td').filter({ hasText: '已编辑' })).toHaveCount(1);
  expect((await orkas.invoke<any>('produced.readText', { path: resolved.path, cid })).text.replace(/\r\n/g, '\n')).toBe(edited.replace(/\r\n/g, '\n'));
  await orkas.closePreview(preview);

  expect((await orkas.invoke<any>('contexts.upload', { path: 'sample.csv', data: bytes.toString('base64') })).ok).toBe(true);
  await page.locator('#contexts-btn').click();
  await page.locator('.ctx-tree-wrap[data-path="sample.csv"] > .skill-tree-node').click();
  await expect(page.locator('#contexts-viewer-body .delimited-preview td').filter({ hasText: '中文样本' })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('csv-library.png') });
  await expect.poll(async () => (await orkas.invoke<any>('kb.status')).files.find((f: any) => f.path === 'sample.csv')?.status,
    { timeout: 30_000 }).toBe('ready');
});

test('HTML attachments render offline interactions while the Library preserves editable source', async ({ orkas }, info) => {
  const page = orkas.page!;
  const source = readFileSync(path.resolve(__dirname, '../fixtures/files/sample.html'), 'utf8');
  const created: any = await orkas.invoke('conversations.create', { title: 'HTML files' });
  const cid = created.conversation.conversation_id;
  expect(await orkas.invoke('conversations.attachments.upload', {
    cid, name: 'sample.html', data: Buffer.from(source).toString('base64'),
  })).toMatchObject({ ok: true });
  const resolved: any = await orkas.invoke('attachments.absPath', { cid, name: 'sample.html' });
  expect(resolved.ok).toBe(true);
  const preview = await orkas.openPreview(() => page.evaluate(args =>
    (window as any).openChatFileViewer(args.path, '查看演示页面', { cid: args.cid }), { path: resolved.path, cid }));
  const frame = preview.frameLocator('.chat-file-viewer-html');
  await expect(frame.locator('h1')).toHaveText('中文页面与本地交互');
  await expect(frame.locator('svg rect')).toHaveCount(3);
  await expect(frame.locator('#count')).toHaveText('0');
  for (let i = 0; i < 3; i++) await frame.locator('#increment').click();
  await expect(frame.locator('#count')).toHaveText('3');
  await preview.screenshot({ path: info.outputPath('html-task.png') });
  await orkas.closePreview(preview);

  expect(await orkas.invoke('contexts.upload', { path: 'sample.html', data: Buffer.from(source).toString('base64') }))
    .toMatchObject({ ok: true });
  await page.locator('#contexts-btn').click();
  await page.locator('.ctx-tree-wrap[data-path="sample.html"] > .skill-tree-node').click();
  await expect(page.locator('#contexts-viewer-body pre')).toContainText('<!doctype html>');
  await expect(page.locator('#contexts-viewer-body #increment')).toHaveCount(0);
  await page.locator('[data-mve-action="edit"]').click();
  const edited = source.replace('中文测试 A', '人工编辑 A');
  await page.locator('[data-mve-textarea]').fill(edited);
  await page.locator('[data-mve-action="save"]').click();
  expect((await orkas.invoke<any>('contexts.read', { path: 'sample.html' })).content).toBe(edited);
  await expect.poll(async () => (await orkas.invoke<any>('kb.status')).files.find((f: any) => f.path === 'sample.html')?.status,
    { timeout: 30_000 })
    .toBe('ready');
});

test('large CSV previews remain bounded and cannot overwrite the original with a prefix', async ({ orkas }) => {
  // Large, valid final whitespace field exercises byte limits without turning
  // a preview regression into thousands of unrelated embedding operations.
  const content = 'name,value\n' + '中文,001\n'.repeat(300) + ' '.repeat(6 * 1024 * 1024);
  const file = orkas.createWorkspaceFile('large.csv', content);
  const preview = await orkas.openPreview(() => orkas.page!.evaluate(file =>
    (window as any).openChatFileViewer(file, 'large.csv'), file));
  await expect(preview.locator('.delimited-preview td').first()).toHaveText('name');
  await expect(preview.locator('.delimited-preview [role="status"]')).toContainText('limited preview');
  await expect(preview.locator('[data-tve-action="edit"]')).toHaveCount(0);
  await expect(preview.locator('.delimited-preview tr')).toHaveCount(200);
  expect(readFileSync(file, 'utf8')).toBe(content);
  await orkas.closePreview(preview);
  expect((await orkas.invoke<any>('contexts.upload', { path: 'large.csv', data: Buffer.from(content).toString('base64') })).ok).toBe(true);
  await orkas.page!.locator('#contexts-btn').click();
  await orkas.page!.locator('.ctx-tree-wrap[data-path="large.csv"] > .skill-tree-node').click();
  await expect(orkas.page!.locator('#contexts-viewer-body .delimited-preview tr')).toHaveCount(200);
  await expect(orkas.page!.locator('#contexts-viewer-actions [data-mve-action="edit"]')).toHaveCount(0);

  const created: any = await orkas.invoke('projects.create', { name: 'CSV project' });
  const projectId = created.project.project_id;
  expect((await orkas.invoke<any>('projects.files.upload', { projectId, name: 'large.csv', data: Buffer.from(content).toString('base64') })).ok).toBe(true);
  await orkas.page!.evaluate(async projectId => {
    await (window as any).switchCtxProject(projectId);
    await (window as any).openCtxFile('large.csv');
  }, projectId);
  await expect(orkas.page!.locator('#contexts-viewer-body .delimited-preview tr')).toHaveCount(200);
  await expect(orkas.page!.locator('#contexts-viewer-actions [data-mve-action="edit"]')).toHaveCount(0);
  // Global indexing completes; Project Library retains files beyond its
  // existing 5 MiB processing budget with an explicit indexing-limit result.
  await expect.poll(async () => (await orkas.invoke<any>('kb.status')).files.find((f: any) => f.path === 'large.csv'),
    { timeout: 30_000 }).toMatchObject({ status: 'ready', bytes: Buffer.byteLength(content) });
  await expect.poll(async () => (await orkas.invoke<any>('projects.files.status', { projectId, skipReconcile: true })).files.find((f: any) => f.name === 'large.csv'))
    .toMatchObject({ status: 'failed', bytes: Buffer.byteLength(content), errorCode: 'E_LIBRARY_FILE_TOO_LARGE' });
});

test('Library source files remain literal and keep unsaved drafts across file switches', async ({ orkas }) => {
  const page = orkas.page!;
  for (const name of ['config.jsonl', 'sample.py']) {
    expect((await orkas.invoke<any>('contexts.write', { path: name, content: name === 'config.jsonl' ? '# literal\n<b>source</b>\n- [ ] text' : '# different source' })).ok).toBe(true);
  }
  await page.locator('#contexts-btn').click();
  await page.locator('.ctx-tree-wrap[data-path="config.jsonl"] > .skill-tree-node').click();
  await expect(page.locator('#contexts-viewer-body pre')).toHaveText('# literal\n<b>source</b>\n- [ ] text');
  await expect(page.locator('#contexts-viewer-body input[type="checkbox"]')).toHaveCount(0);
  await page.locator('[data-mve-action="edit"]').click();
  await expect(page.locator('.ctx-editor-toolbar')).toHaveCount(0);
  await page.locator('[data-mve-textarea]').fill('updated literal');
  await page.locator('.ctx-tree-wrap[data-path="sample.py"] > .skill-tree-node').click();
  await page.locator('.ctx-tree-wrap[data-path="config.jsonl"] > .skill-tree-node').click();
  await expect(page.locator('[data-mve-textarea]')).toHaveValue('updated literal');
  await page.locator('[data-mve-action="save"]').click();
  expect((await orkas.invoke<any>('contexts.read', { path: 'config.jsonl' })).content).toBe('updated literal');
});

test('native local image previews decode common raster formats and aliases', async ({ orkas }) => {
  const fixtures: Array<[string, string]> = [['image.bmp', 'bmp'], ['image.avif', 'avif'], ['image.jfif', 'jpeg']];
  for (const [name, format] of fixtures) {
    const file = path.join(orkas.userWorkspaceRoot, name);
    await orkas.electronApp!.evaluate(async (_electron, args) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      let output;
      if (args.format === 'bmp') {
        const { Jimp } = req(args.jimpModule);
        output = await new Jimp({ width: 1, height: 1, color: 0xff0000ff }).getBuffer('image/bmp');
      } else output = await req(args.sharpModule)({ create: { width: 1, height: 1, channels: 3, background: '#ff0000' } }).toFormat(args.format).toBuffer();
      req('node:fs').writeFileSync(args.file, output);
    }, { file, format, jimpModule: require.resolve('jimp'), sharpModule: require.resolve('sharp') });
    const preview = await orkas.openPreview(() => orkas.page!.evaluate(file =>
      (window as any).openChatFileViewer(file, 'Image'), file));
    await expect.poll(() => preview.locator('.chat-lightbox-img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    await orkas.closePreview(preview);
  }
});
