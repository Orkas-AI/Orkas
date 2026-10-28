import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJsonl, readJsonlPage, readJsonlPageWithOffsets } from '../../src/main/storage';
let root:string,file:string;
const strict={strict:true};
const permissionCase=process.platform !== 'win32' && process.getuid?.() !== 0;
beforeEach(() => { root=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-strict-jsonl-'));file=path.join(root,'records.jsonl'); });
afterEach(() => { vi.restoreAllMocks();syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true}); });
describe('strict JSONL reads for durable projections',() => {
  it.each([0,2])('reports a missing source for limit %s while preserving the ordinary empty view',async limit => {
    await expect(readJsonl(file,limit,strict)).rejects.toMatchObject({code:'ENOENT'});
    expect(await readJsonl(file,limit)).toEqual([]);
  });
  it.each([0,2])('rejects corrupt source rows for limit %s without including source text in the error',async limit => {
    fs.writeFileSync(file,'{"id":"first"}\nPRIVATE_FIXTURE_CONTENT\n{"id":"last"}\n');
    await expect(readJsonl(file,limit,strict)).rejects.toThrow('JSONL record is invalid');
    expect(await readJsonl(file,limit)).toEqual([{id:'first'},{id:'last'}]);
  });
  it('accepts valid generic JSON values and blank lines without applying a conversation-specific schema',async () => {
    fs.writeFileSync(file,' \r\nnull\n0\nfalse\n{"ok":true}\n');
    expect(await readJsonl(file,0,strict)).toEqual([null,0,false,{ok:true}]);
    expect(await readJsonl(file,4,strict)).toEqual([null,0,false,{ok:true}]);
  });
  it('preserves UTF-8 records spanning chunks, CRLF, blank lines and an unterminated tail',async () => {
    const rows=[{id:1,text:'中文🚀'.repeat(30_000)},{id:2,text:'tail'}];
    fs.writeFileSync(file,'\r\n'+JSON.stringify(rows[0])+'\r\n\r\n'+JSON.stringify(rows[1]));
    expect(await readJsonl(file,2,strict)).toEqual(rows);
  });
  it('validates only the selected tail page and propagates strictness to offset-preserving older pages',async () => {
    fs.writeFileSync(file,'OLDER_PRIVATE_CORRUPTION\n{"id":"latest"}\n');
    const tail=await readJsonlPage(file,1,undefined,strict);
    expect(tail.records).toEqual([{id:'latest'}]);expect(tail.nextCursor).toBeGreaterThan(0);
    await expect(readJsonlPageWithOffsets(file,1,tail.nextCursor,strict)).rejects.toThrow('JSONL record is invalid');
  });
  it('rejects an actual short read after truncation and closes its owned file handle',async () => {
    fs.writeFileSync(file,'{"id":"before-truncation"}\n');
    const open=fs.promises.open.bind(fs.promises);let close:ReturnType<typeof vi.fn>|undefined;
    vi.spyOn(fs.promises,'open').mockImplementation(async (...args:any[]) => {
      const handle=await (open as any)(...args);if(String(args[0]) !== file) return handle;
      const stat=handle.stat.bind(handle),finish=handle.close.bind(handle);
      handle.stat=async () => { const result=await stat();fs.truncateSync(file,0);return result; };
      close=vi.fn(finish);handle.close=close;return handle;
    });
    syncBuiltinESMExports();
    await expect(readJsonlPageWithOffsets(file,1,undefined,strict)).rejects.toThrow('JSONL read is incomplete');
    expect(close).toHaveBeenCalledOnce();
  });
  it.runIf(permissionCase).each([0,2])('reports native read denial for limit %s while retaining the source',async limit => {
    const source='{"id":"protected"}\n';fs.writeFileSync(file,source);fs.chmodSync(file,0);
    try { await expect(readJsonl(file,limit,strict)).rejects.toMatchObject({code:'EACCES'}); }
    finally { fs.chmodSync(file,0o600); }
    expect(fs.readFileSync(file,'utf8')).toBe(source);
  });
});
