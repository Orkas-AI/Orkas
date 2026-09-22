import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';
import { recoveredPreviewWindows } from './fixtures/preview-recovery';

for (const errorKind of ['pageerror', 'console'] as const) {
  test(`attributes and verifies recovered preview ${errorKind}`, async ({ sdkOrkas: orkas }, info) => {
    const source = (broken: boolean) => `<!doctype html>
      <style>button:focus-visible,input:focus-visible{outline:2px solid blue}</style>
      <form onsubmit="event.preventDefault();${broken
        ? errorKind === 'pageerror' ? "throw new TypeError('Preview recovery fixture fault')" : "console.error('Preview recovery fixture fault')"
        : "document.getElementById('result').textContent='Saved'"}">
      <label>Name<input required></label><button>Save</button></form><p id="result"></p>`;
    const entry = orkas.createWorkspaceFile('app-a/index.html', source(true));
    orkas.createWorkspaceFile('app-a/orkas-app.json', '{"sdkVersion":1,"capabilities":[]}');
    const preview = (file: string, interactions = true) => orkas.electronApp!.evaluate(async (_, args) => {
      const { createLocalTools } = (process as any).mainModule.require(args.modulePath);
      const tool = createLocalTools({ extraRoots: [args.root] }).find((candidate: any) => candidate.name === 'html_preview');
      const result = await tool.execute({ path: args.file, desktop: { width:1280, height:800 }, interactions:args.interactions },
        { workingDir: args.root, state: {} });
      return { ...JSON.parse(result.content), toolIsError: result.isError === true };
    }, { file, interactions, root:orkas.userWorkspaceRoot,
      modulePath:path.resolve(__dirname,'../../src/main/model/core-agent/local-tools.ts') });
    const snapshot = () => orkas.electronApp!.evaluate(() => (globalThis as any).__previewRecovery.read());
    const failed = await preview(entry);
    expect(failed.ok).toBe(false);
    expect(failed.toolIsError).toBe(true);
    expect(failed.viewports[0].consoleErrors).toHaveLength(1);
    expect(recoveredPreviewWindows(await snapshot())).toEqual([]);
    const other = orkas.createWorkspaceFile('app-b/index.html', source(false));
    expect((await preview(other)).ok).toBe(true);
    expect(recoveredPreviewWindows(await snapshot())).toEqual([]);
    orkas.createWorkspaceFile('app-a/index.html', source(false));
    expect((await preview(entry, false)).ok).toBe(true);
    expect(recoveredPreviewWindows(await snapshot())).toEqual([]);
    expect((await preview(entry)).ok).toBe(true);
    expect(recoveredPreviewWindows(await snapshot())).toHaveLength(1);
    orkas.createWorkspaceFile('app-a/extra.js', '// changed after the previous preview');
    expect(recoveredPreviewWindows(await snapshot())).toEqual([]);
    expect((await preview(entry)).ok).toBe(true);
    const evidence = await snapshot();
    const recovery = recoveredPreviewWindows(evidence);
    expect(recovery).toHaveLength(1);
    const errors = await orkas.rendererErrorEvidence();
    expect(errors.some(record => recovery.some(item => item.windowId === record.windowId))).toBe(true);
    writeFileSync(info.outputPath('scenario-evidence.json'), JSON.stringify({ evidence, recovery, errors }, null, 2));
    // Independent final UI behavior is still exercised, not inferred from the log.
    const saved = await orkas.invoke<{ok:boolean;id:string}>('savedApps.saveFromPath', {path:entry,title:'Recovered app'});
    expect(saved.ok).toBe(true);
    await orkas.page.locator('#apps-btn').click();
    const panel = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${saved.id}"]`).click());
    const frame = panel.locator('.saved-app-viewer-frame').contentFrame();
    await frame.getByRole('textbox', {name:'Name'}).fill('Independent test');
    await frame.getByRole('button', {name:'Save'}).click();
    await expect(frame.locator('#result')).toHaveText('Saved');
    await orkas.closePreview(panel);
  });
}
