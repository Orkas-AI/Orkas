import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';

/** Reproduce the observed Windows metadata collision without supplying file
 * contents or an expected revision. All reads still use the real changed file. */
export function freezeFileMetadata(files: string[], beforeClose?: (file: string) => Promise<void>): () => void {
  const snapshots = new Map(files.map(file => [path.resolve(file), {
    number: fs.lstatSync(file), bigint: fs.lstatSync(file, { bigint: true }),
  }]));
  const snapshot = (file: unknown, options: any) => typeof file === 'string'
    ? snapshots.get(path.resolve(file))?.[options?.bigint ? 'bigint' : 'number'] : undefined;
  const lstatSync = fs.lstatSync.bind(fs);
  const lstat = fs.promises.lstat.bind(fs.promises);
  const open = fs.promises.open.bind(fs.promises);
  const syncSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: any, options: any) =>
    snapshot(file, options) ?? lstatSync(file, options)) as any);
  const asyncSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation(((file: any, options: any) =>
    snapshot(file, options) ? Promise.resolve(snapshot(file, options)) : lstat(file, options)) as any);
  const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    handle.stat = ((options: any) => snapshot(args[0], options)
      ? Promise.resolve(snapshot(args[0], options)) : stat(options)) as any;
    if (beforeClose) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        try { await beforeClose(String(args[0])); }
        finally { await close(); }
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  return () => {
    openSpy.mockRestore(); asyncSpy.mockRestore(); syncSpy.mockRestore();
    syncBuiltinESMExports();
  };
}
