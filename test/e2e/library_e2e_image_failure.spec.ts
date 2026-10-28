import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, openSidebarEntry, test } from './fixtures/orkas';


test('keeps failed images visible in both Libraries and clears the marker after a vision-model retry', async ({ modelOrkas: app }, testInfo) => {
  test.setTimeout(90_000);
  const page = app.page!;
  const main = path.resolve(__dirname, '../../src/main');
  // Configure only the public custom-model capability metadata. The real
  // image preparation, selection, indexing, persistence, IPC and renderer run.
  async function setVision(available: boolean) {
    await app.electronApp!.evaluate(async (_electron, { main, available }) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const auth = req(`${main}/features/auth.ts`);
      const choices = await auth.pickChatEntryGroup();
      if (choices.length !== 1 || !choices[0].customConfig?.baseUrl) throw new Error('Fixture needs its one custom model');
      await auth.addCustomModelEntry({ label: 'E2E Local Model', baseUrl: choices[0].customConfig?.baseUrl,
        model: choices[0].model, apiKey: choices[0].apiKey, contextWindow: 128_000,
        maxTokens: 8_192, supportsVision: available });
    }, { main, available });
  }
  await setVision(false);
  app.setLibraryImageDescriptionReplies(['# Orca\nAn orca with navy, white and blue markings.']);
  const name = '产品配色与状态图例—需要保留颜色的参考图片.png';
  const bytes = readFileSync(path.resolve(__dirname, '../../src/resources/icons/logo.png'));
  const source = app.createFixtureFile(name, bytes);
  await app.selectFilesOnNextDialog([source]);
  await page.evaluate(() => (window as any).setLang('zh'));
  await openSidebarEntry(page, '#contexts-btn');
  await page.locator('#ctx-root-menu-btn').click();
  await page.locator('#ctx-row-menu [data-action="upload"]').click();
  const row = page.locator(`#contexts-tree .ctx-tree-wrap[data-path="${name}"]`);
  const badge = row.locator('button.ctx-kb-chip.is-image-failed');
  await expect(badge).toHaveText('解析失败', { timeout: 30_000 });
  await expect(badge).toHaveAttribute('title', /解析失败.*网络.*图片.*模型识图能力.*重试/);
  const status = await app.invoke<any>('kb.status');
  expect(status.files.find((file: any) => file.path === name)).toMatchObject({ status: 'failed', chunks: 0 });
  expect(app.modelRequests.filter(request => JSON.stringify(request).includes('Library image-understanding assistant'))).toHaveLength(0);
  await row.locator('.skill-tree-label').click();
  await expect(page.locator('#contexts-editor-path')).toHaveText(name);
  await page.screenshot({ path: testInfo.outputPath('library-image-failed-zh.png') });

  await openSidebarEntry(page, '#new-chat-btn');
  await openSidebarEntry(page, '#contexts-btn');
  await expect(badge).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.evaluate(() => (window as any).setLang('en'));
  await expect(badge).toHaveText('Analysis failed');
  await expect(page.locator('#ctx-viewer-reveal')).toHaveText('Open containing folder');
  await expect(page.locator('#ctx-viewer-del')).toHaveText('Delete');
  await expect(page.locator('#contexts-viewer-body img')).toBeVisible();
  await badge.focus();
  await page.screenshot({ path: testInfo.outputPath('library-image-failed-en-narrow.png') });

  const created = await app.invoke<any>('projects.create', { name: '图片理解状态验证' });
  const pid = created.project.project_id;
  await app.invoke('projects.files.upload', { projectId: pid, name, data: bytes.toString('base64') });
  await expect.poll(async () => {
    const status = await app.invoke<any>('projects.files.status', { projectId: pid, skipReconcile: true });
    return status.files.find((file: any) => file.name === name)?.status;
  }, { timeout: 30_000 }).toBe('failed');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(async pid => {
    await (window as any).setLang('zh');
    await (window as any).setView('project', pid);
  }, pid);
  await page.locator('[data-project-side-tabs="resources"] [data-project-side-tab="files"]').click();
  const projectBadge = page.locator(`.project-file-row[data-project-file="${name}"] button.ctx-kb-chip.is-image-failed`);
  await expect(projectBadge).toHaveText('解析失败');
  await page.screenshot({ path: testInfo.outputPath('project-image-failed-zh.png') });

  await setVision(true);
  await projectBadge.focus();
  await page.keyboard.press('Enter');
  await expect(projectBadge).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const status = await app.invoke<any>('projects.files.status', { projectId: pid, skipReconcile: true });
    return status.files.find((file: any) => file.name === name)?.status;
  }).toBe('ready');
  await openSidebarEntry(page, '#contexts-btn');
  await expect(badge).toBeVisible();
  await badge.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => {
    const status = await app.invoke<any>('kb.status');
    return status.files.find((file: any) => file.path === name)?.status;
  }, { timeout: 30_000 }).toBe('ready');
  await expect(badge).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('library-image-recovered-zh.png') });
});
