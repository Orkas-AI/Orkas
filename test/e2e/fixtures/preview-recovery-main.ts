/** Installed only in the isolated evaluation Electron process. Wrap the real
 * renderer dependency seam to bind each window to one actual preview attempt. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PreviewAttempt, PreviewRecoverySnapshot } from './preview-recovery';

function bundleVersion(entry: string): string | null {
  try {
    const root = path.dirname(fs.realpathSync(entry));
    const hash = createHash('sha256');
    let count = 0, bytes = 0;
    const scan = (dir: string) => {
      for (const name of fs.readdirSync(dir).sort()) {
        if (++count > 256) throw new Error('Snapshot file budget exceeded');
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('Snapshot requires regular local files');
        hash.update(JSON.stringify([path.relative(root, file), stat.isDirectory() ? 'directory' : 'file', stat.isDirectory() ? null : stat.size]));
        if (stat.isDirectory()) scan(file);
        else if (stat.isFile()) {
          bytes += stat.size;
          if (bytes > 8 * 1024 * 1024) throw new Error('Snapshot byte budget exceeded');
          hash.update(fs.readFileSync(file));
        } else throw new Error('Unsupported snapshot entry');
      }
    };
    scan(root);
    return hash.digest('hex');
  } catch { return null; }
}

export function observePreviewRecovery() {
  const moduleId = require.resolve('../../../src/main/features/html_preview');
  const feature = require(moduleId);
  const cached = require.cache[moduleId]!;
  const original = feature.renderResponsiveHtmlPreview;
  const attempts: PreviewAttempt[] = [];
  const entries = new Map<string, string>();
  let sequence = 0;
  const wrapper = async (entry: string, viewports: any[], deps: any = {}, options: any = {}) => {
    const entryKey = createHash('sha256').update(path.resolve(entry)).digest('hex');
    entries.set(entryKey, entry);
    const before = bundleVersion(entry);
    const record: PreviewAttempt = { id: attempts.length + 1, entryKey, version: before, stable: false,
      started: ++sequence, ended: 0, interactions: options.interactions !== false, ok: false,
      windows: [], viewports: viewports.map(v => `${v.name}:${v.width}x${v.height}`), runtimeErrorWindows: [] };
    attempts.push(record);
    try {
      const runtime = await (deps.loadElectron?.() ?? import('electron'));
      const BrowserWindow = runtime.BrowserWindow;
      const result = await original(entry, viewports, { ...deps, loadElectron: async () => ({ ...runtime,
        BrowserWindow: function (windowOptions: any) {
          const win = new BrowserWindow(windowOptions);
          record.windows.push(win.id);
          return win;
        },
      }) }, options);
      record.ok = result.evidence.ok === true;
      record.runtimeErrorWindows = result.evidence.viewports.flatMap((v: any, i: number) =>
        v.consoleErrors?.length ? [record.windows[i]] : []).filter((id: unknown) => typeof id === 'number');
      return result;
    } finally {
      record.ended = ++sequence;
      record.stable = before !== null && before === bundleVersion(entry);
    }
  };
  const observed = { ...feature, renderResponsiveHtmlPreview: wrapper };
  cached.exports = observed;
  return {
    read(): PreviewRecoverySnapshot {
      return { attempts, currentVersions: Object.fromEntries([...entries].map(([key, entry]) => [key, bundleVersion(entry)])) };
    },
    restore() { if (cached.exports === observed) cached.exports = feature; },
  };
}
