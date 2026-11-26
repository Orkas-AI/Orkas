// The check every conversation-bearing IPC call passes before its handler: an
// application task's private conversation is not reachable from the window.
// Run from source, like the history handler's timing cases, so the real guard
// and the real project-hint parser are exercised without loading the whole IPC module.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../../../src/main/ipc/index.ts'), 'utf8');
const between = (start: string, end: string) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`guard source not found: ${start}`);
  return source.slice(from, to);
};
const guardJs = ts.transpileModule([
  between('function conversationProjectHint(', '// To-dos may be account-global.'),
  between('async function isPrivateAppConversationPayload(', 'export function broadcastToRenderer('),
  ';isPrivateAppConversationPayload',
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function setup(rows: Record<string, { kind?: string }> = {}) {
  const getConversationMetadata = vi.fn(async (_uid: string, cid: string, _hint?: string | null) => rows[cid] ?? null);
  const guard = vm.runInNewContext(guardJs, {
    safeId: (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value),
    chats: { getConversationMetadata },
  }) as (uid: string, payload: unknown) => Promise<boolean>;
  return { guard, getConversationMetadata };
}

describe('the private application conversation check before every IPC handler', () => {
  it('looks a conversation up in the project the caller named, so only that index is read', async () => {
    const { guard, getConversationMetadata } = setup({ c1: {}, c2: {}, c3: {} });
    expect(await guard('u1', { cid: 'c1', project_id: 'p1' })).toBe(false);
    expect(await guard('u1', { cid: 'c2', project_id: '' })).toBe(false);
    expect(await guard('u1', { cid: 'c3' })).toBe(false);
    expect(getConversationMetadata.mock.calls).toEqual([
      ['u1', 'c1', 'p1'],
      ['u1', 'c2', null],
      ['u1', 'c3', undefined],
    ]);
  });

  it('still refuses an application task kept in the ordinary index, whatever project the caller names', async () => {
    const { guard } = setup({ legacy: { kind: 'app_task' } });
    expect(await guard('u1', { cid: 'legacy' })).toBe(true);
    expect(await guard('u1', { cid: 'legacy', project_id: 'p1' })).toBe(true);
    expect(await guard('u1', { conversation_id: 'legacy', project_id: '' })).toBe(true);
    expect(await guard('u1', { cids: ['c1', 'legacy'], project_id: 'p1' })).toBe(true);
  });

  it('refuses an application conversation id without reading anything', async () => {
    const { guard, getConversationMetadata } = setup();
    expect(await guard('u1', { cid: `app_${'a'.repeat(64)}_once_${'b'.repeat(32)}` })).toBe(true);
    expect(getConversationMetadata).not.toHaveBeenCalled();
  });

  it('leaves a malformed project id for the handler to reject, and checks the conversation anyway', async () => {
    const { guard, getConversationMetadata } = setup({ legacy: { kind: 'app_task' } });
    await expect(guard('u1', { cid: 'c1', project_id: '../elsewhere' })).resolves.toBe(false);
    expect(getConversationMetadata.mock.calls).toEqual([['u1', 'c1', undefined]]);
    await expect(guard('u1', { cid: 'legacy', project_id: { not: 'an id' } })).resolves.toBe(true);
    await expect(guard('u1', undefined)).resolves.toBe(false);
  });
});
