import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { test as base, expect, OrkasTestApp } from './orkas';
import { recoveredPreviewWindows } from './preview-recovery';

export const test = base.extend<{ sdkOrkas: OrkasTestApp }>({
  sdkOrkas: async ({}, use, info) => {
    const previous = process.env.ORKAS_E2E_KEEP_LOGS;
    process.env.ORKAS_E2E_KEEP_LOGS = '1';
    const app = new OrkasTestApp(info, { modelStub: true, captureRendererErrorWindows: true });
    let recoveredRanges: Awaited<ReturnType<OrkasTestApp['recoverPreviewRendererErrors']>> = [];
    try {
      await app.launch();
      expect(await app.electronApp!.evaluate(() => Boolean((globalThis as any).__previewRecovery)),
        'Preview observer must be installed before production tools load').toBe(true);
      await app.electronApp!.evaluate(({ app: electron, BrowserWindow }) => {
        const observe = (win: Electron.BrowserWindow) => {
          const id = win.id;
          const record = (event: string, reason?: string) => console.log('[sdk-eval-lifecycle]', JSON.stringify({ id, event, reason }));
          record('created');
          win.on('close', () => record('close'));
          win.on('closed', () => record('closed'));
          win.webContents.on('render-process-gone', (_event, details) => record('render-process-gone', details.reason));
        };
        BrowserWindow.getAllWindows().forEach(observe);
        electron.on('browser-window-created', (_event, win) => observe(win));
      });
      await use(app);
    }
    finally {
      try {
        mkdirSync(info.outputDir, { recursive: true });
        const calls = await app.electronApp?.evaluate(() => (globalThis as any).__webAppObserver?.read() || []).catch(() => null);
        writeFileSync(info.outputPath('host-calls.json'), JSON.stringify(calls, null, 2));
        try {
          const snapshot = await app.electronApp?.evaluate(() => {
            const observer = (globalThis as any).__previewRecovery;
            try { return observer?.read() ?? null; } finally { observer?.restore(); }
          });
          if (snapshot) {
            const recovered = recoveredPreviewWindows(snapshot);
            recoveredRanges = await app.recoverPreviewRendererErrors(recovered.map(item => item.windowId));
            writeFileSync(info.outputPath('preview-recovery.json'), JSON.stringify({ ...snapshot, recovered,
              rendererErrors: await app.rendererErrorEvidence(), recoveredRanges }, null, 2));
          }
        } finally { await app.dispose(); }
      } finally {
        if (previous === undefined) delete process.env.ORKAS_E2E_KEEP_LOGS;
        else process.env.ORKAS_E2E_KEEP_LOGS = previous;
        const logPath = info.outputPath('electron-main.log');
        expect(existsSync(logPath), 'Full process logs must be retained even on pass').toBe(true);
      }
    }
  },
});
