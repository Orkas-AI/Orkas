import { expect, test } from './fixtures/orkas';


test('a delayed global Library cannot replace the current project picker', async ({ orkas }, info) => {
  const page = orkas.page!;
  const { project } = await orkas.invoke<any>('projects.create', { name: 'Picker destination' });
  expect(await orkas.invoke('projects.files.mkdir', { projectId: project.project_id, path: 'Selected' })).toMatchObject({ ok: true });
  await page.evaluate(async pid => {
    const w = window as any;
    await w.setLang('en'); await w.loadRendererFeature('kb-picker');
    const original = w.apiFetch;
    w.pickerReceipts = [];
    w.apiFetch = async (...args: any[]) => {
      if (args[0] === '/api/contexts/tree') await new Promise(resolve => { w.releasePickerTree = resolve; });
      const response = await original(...args); w.oldPickerTreeReturned = true; return response;
    };
    w.pickKbLocation({ defaultName: 'Obsolete' }).then((result: unknown) => w.pickerReceipts.push({ caller: 'old', result }));
    w.pickKbLocation({ defaultName: 'Current', defaultDir: 'Selected', scope: { type: 'project', projectId: pid } })
      .then((result: unknown) => w.pickerReceipts.push({ caller: 'current', result }));
    w.restorePickerApi = () => { w.apiFetch = original; };
  }, project.project_id);
  try {
    await expect(page.locator('#kb-picker-modal')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#kb-picker-title')).toHaveText('Save to Project Library');
    await expect.poll(() => page.evaluate(() => (window as any).pickerReceipts)).toEqual([{ caller: 'old', result: null }]);
    await page.evaluate(() => (window as any).releasePickerTree());
    // The real Main response is awaited before checking stale-render behavior.
    await expect.poll(() => page.evaluate(() => {
      const w = window as any; return w.oldPickerTreeReturned === true;
    })).toBe(true);
    await expect(page.locator('#kb-picker-name')).toHaveValue('Current');
    await expect(page.locator('#kb-picker-target')).toContainText('Selected/');
    await page.screenshot({ path: info.outputPath('latest-project-picker.png') });
    await page.locator('#kb-picker-confirm').click();
    await expect.poll(() => page.evaluate(() => (window as any).pickerReceipts)).toEqual([
      { caller: 'old', result: null }, { caller: 'current', result: { path: 'Selected/Current.md' } },
    ]);
    await expect(page.locator('#kb-picker-modal')).not.toHaveClass(/\bopen\b/);
  } finally { await page.evaluate(() => { const w = window as any; w.releasePickerTree(); w.restorePickerApi(); w.closeKbPicker(); }); }
});

test('cancelling a loading picker does not reopen it and a later picker remains usable', async ({ orkas }, info) => {
  const page = orkas.page!;
  await page.evaluate(async () => {
    const w = window as any; await w.setLang('zh'); await w.loadRendererFeature('kb-picker');
    const original = w.apiFetch; w.pickerReceipts = []; w.pendingPickerLoads = [];
    w.apiFetch = async (...args: any[]) => {
      if (args[0] === '/api/contexts/tree') await new Promise(resolve => w.pendingPickerLoads.push(resolve));
      const response = await original(...args); w.pickerLoadsFinished = (w.pickerLoadsFinished || 0) + 1; return response;
    };
    w.pickKbLocation({ defaultName: 'Cancelled' }).then((result: unknown) => w.pickerReceipts.push(result));
    w.closeKbPicker(); w.restorePickerApi = () => { w.apiFetch = original; };
  });
  try {
    await expect.poll(() => page.evaluate(() => (window as any).pickerReceipts)).toEqual([null]);
    await page.evaluate(() => (window as any).pendingPickerLoads[0]());
    await expect.poll(() => page.evaluate(() => (window as any).pickerLoadsFinished)).toBe(1);
    await expect(page.locator('#kb-picker-modal')).not.toHaveClass(/\bopen\b/);
    await page.evaluate(() => {
      const w = window as any; w.restorePickerApi();
      w.pickKbLocation({ defaultName: 'Current' }).then((result: unknown) => w.pickerReceipts.push(result));
    });
    await expect(page.locator('#kb-picker-name')).toHaveValue('Current');
    await expect(page.locator('#kb-picker-cancel')).toBeVisible();
    await expect(page.locator('#kb-picker-confirm')).toBeVisible();
    await page.screenshot({ path: info.outputPath('cancel-and-reopen-picker.png') });
    await page.locator('#kb-picker-cancel').click();
    await expect.poll(() => page.evaluate(() => (window as any).pickerReceipts)).toEqual([null, null]);
  } finally { await page.evaluate(() => { const w = window as any; for (const resolve of w.pendingPickerLoads) resolve(); w.restorePickerApi(); w.closeKbPicker(); }); }
});
