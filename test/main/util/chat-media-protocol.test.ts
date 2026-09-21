import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual registration block with real resolvers, without booting
// Electron or accessing a real account. Only the successful byte stream is fake.
const source = fs.readFileSync(path.resolve(__dirname, '../../../src/main/index.ts'), 'utf8');
const block = source.slice(source.indexOf('function _pathnameToAbsPath('), source.indexOf('// `chat-app://cid/', source.indexOf('function _pathnameToAbsPath(')));
const compiled = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let root: string;
let previousRoot: string | undefined;
let media: typeof import('../../../src/main/features/chat_attachments');
let handle: (request: Request) => Promise<Response>;
let logs: unknown[][];
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-media-protocol-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser('media-test');
  media = await import('../../../src/main/features/chat_attachments');
  logs = [];
  vm.runInNewContext(compiled + '\nregisterChatMediaProtocol();', {
    URL, Response, Buffer, fs, path, process, chatAttachments: media, users,
    protocol: { handle: (_scheme: string, handler: typeof handle) => { handle = handler; } },
    log: { warn: (...args: unknown[]) => logs.push(args), info: () => {} },
    _mediaKindForContentType: () => 'image', _protocolServeFailureCode: () => 'serve_failed',
    serveFileRange: () => new Response('fixture-image'),
    withHtmlPreviewPolicy: (response: Response) => response,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
async function requestLocal(file: string) {
  const { chatMediaLocalUrl } = await import('../../../src/main/util/chat-media-url');
  return handle(new Request(chatMediaLocalUrl(file)));
}
function failStat(file: string, code: string) {
  const original = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(((candidate: any, ...args: any[]) => {
    if (candidate === file) throw Object.assign(new Error('private-message'), { code });
    return (original as any)(candidate, ...args);
  }) as typeof fs.statSync);
  syncBuiltinESMExports();
}
describe('chat media original failure diagnostics', () => {
  it.each([
    ['ENOENT', 'not_found'], ['ENOTDIR', 'not_found'], ['EACCES', 'permission_denied'],
    ['EPERM', 'permission_denied'], ['EIO', 'io_error'], ['PRIVATE_ERROR', 'io_error'],
  ])('preserves %s at the failed stat with unchanged HTTP response', async (code, diagnosticCode) => {
    const file = path.join(root, 'private-image.png');
    failStat(file, code);
    const response = await requestLocal(file);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not found');
    expect(logs).toEqual([['chat-media/local: reject', { error_code: diagnosticCode }]]);
    expect(JSON.stringify(logs)).not.toMatch(/private|PRIVATE/);
  });
  it('distinguishes a directory without changing the rejection', async () => {
    const file = path.join(root, 'folder.png');
    fs.mkdirSync(file);
    const response = await requestLocal(file);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not a file');
    expect(logs).toEqual([['chat-media/local: reject', { error_code: 'not_file' }]]);
  });
  it('keeps attachment denial distinct from a later successful metadata check', async () => {
    const { chatAttachmentDirForConversation } = await import('../../../src/main/util/project-layout');
    const file = path.join(chatAttachmentDirForConversation('media-test', 'conversation-test'), 'image.png');
    failStat(file, 'EACCES');
    const response = await handle(new Request('chat-media://cid/conversation-test/image.png'));
    expect(response.status).toBe(404);
    expect(logs).toEqual([['chat-media/cid: reject', { error_code: 'permission_denied' }]]);
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true, size: 4 } as fs.Stats);
    expect(await media.diagnoseMediaFile('media-test', { localPath: file }))
      .toMatchObject({ diagnosis: 'stat_available' });
    expect(logs[0][1]).toEqual({ error_code: 'permission_denied' });
  });
  it('records SVG read denial even when metadata is available', async () => {
    const file = path.join(root, 'image.svg');
    fs.writeFileSync(file, '<svg/>');
    const original = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((candidate: any, ...args: any[]) => {
      if (candidate === file) throw Object.assign(new Error('private-message'), { code: 'EACCES' });
      return (original as any)(candidate, ...args);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    const response = await requestLocal(file);
    expect(response.status).toBe(404);
    expect(logs).toEqual([['chat-media/local: reject', { error_code: 'permission_denied' }]]);
  });
  it('retains the reason while materializing an SVG referenced image', async () => {
    const file = path.join(root, 'image.svg');
    fs.writeFileSync(file, '<svg><image href="child.png"/></svg>');
    failStat(path.join(root, 'child.png'), 'EIO');
    const response = await requestLocal(file);
    expect(response.status).toBe(404);
    expect(logs).toEqual([['chat-media/local: SVG materialize rejected', { error_code: 'io_error' }]]);
  });
  it('serves a valid image without adding a failure record', async () => {
    const file = path.join(root, 'image.png');
    fs.writeFileSync(file, 'fixture');
    const response = await requestLocal(file);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fixture-image');
    expect(logs).toEqual([]);
  });
});
