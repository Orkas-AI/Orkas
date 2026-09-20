import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-assistance-context-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('conversation entry assistance', () => {
  it('retains app intent across restart and title edits, scoped to the owning account without persisting guidance', async () => {
    const chats = await import('../../../src/main/features/chats');
    const context = await import('../../../src/main/features/conversation_assistance_context');
    const conv = await chats.createConversation('u1', { title: 'Unit converter', assistance: {
      kind: 'app_creation', prompt: 'UNTRUSTED_INSTRUCTIONS',
    } as any });
    const cid = conv.conversation_id;
    expect(conv.assistance).toEqual({ kind: 'app_creation' });
    const first = (await context.resolveConversationAssistanceForTurn('u1', cid)).guidance;
    expect(first).toContain('call create_artifact');
    expect(first).not.toContain('UNTRUSTED_INSTRUCTIONS');
    expect(await context.resolveConversationAssistanceForTurn('u2', cid)).toEqual({ kind: undefined, guidance: '' });
    await chats.updateConversation('u1', cid, { title: 'Renamed app task' });
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/conversation_assistance_context');
    expect(await reloaded.resolveConversationAssistanceForTurn('u1', cid)).toEqual({ kind: 'app_creation', guidance: first });
    const chatRoot = path.join(root, 'u1', 'cloud', 'chats');
    expect(fs.readFileSync(path.join(chatRoot, `${cid}.jsonl`), 'utf8')).toBe('');
    const metadata = fs.readFileSync(path.join(chatRoot, cid, 'meta.json'), 'utf8');
    expect(metadata).not.toContain('UNTRUSTED_INSTRUCTIONS');
    expect(metadata).not.toContain('create_artifact');
    const reloadedChats = await import('../../../src/main/features/chats');
    // Recovery from a missing list index must retain the entry association too.
    fs.unlinkSync(path.join(chatRoot, '_index.json'));
    reloadedChats.invalidateConversationCaches('u1');
    await reloadedChats.repairConversationIndex('u1');
    expect(await reloaded.resolveConversationAssistanceForTurn('u1', cid)).toEqual({ kind: 'app_creation', guidance: first });
  });

  it('preserves connector guidance and leaves ordinary, unknown and deleted tasks empty', async () => {
    const chats = await import('../../../src/main/features/chats');
    const context = await import('../../../src/main/features/conversation_assistance_context');
    const setup = await import('../../../src/main/features/connector_setup_context');
    for (const assistance of [undefined, { kind: 'app-creation' }, ['app_creation']]) {
      const conv = await chats.createConversation('u1', { assistance: assistance as any });
      expect(conv.assistance).toBeUndefined();
      expect((await context.resolveConversationAssistanceForTurn('u1', conv.conversation_id)).guidance).toBe('');
    }
    const conv = await chats.createConversation('u1', {
      assistance: { kind: 'connector_setup', connector_id: 'notion' },
    });
    const cid = conv.conversation_id;
    const original = await setup.formatConnectorSetupForTurn('u1', cid);
    expect(original).toContain('## Connector setup assistance');
    expect((await context.resolveConversationAssistanceForTurn('u1', cid)).guidance).toBe(original);
    await chats.updateConversation('u1', cid, { assistance: { kind: 'app_creation' } });
    expect(await setup.formatConnectorSetupForTurn('u1', cid)).toBe('');
    await chats.deleteConversation('u1', cid);
    expect((await context.resolveConversationAssistanceForTurn('u1', cid)).guidance).toBe('');
  });
});
