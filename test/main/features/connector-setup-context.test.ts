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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-setup-context-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('connector setup assistance context', () => {
  it('keeps repeated assistance idempotent without rewriting conversation metadata or dialogue', async () => {
    const chats = await import('../../../src/main/features/chats');
    const setup = await import('../../../src/main/features/connector_setup_context');
    const conv = await chats.createConversation('u1', {
      title: 'Keep my title',
      assistance: { kind: 'connector_setup', connector_id: 'notion' },
    });
    const chatRoot = path.join(root, 'u1', 'cloud', 'chats');
    const files = ['_index.json', `${conv.conversation_id}/meta.json`, `${conv.conversation_id}.jsonl`];
    const before = files.map(file => fs.readFileSync(path.join(chatRoot, file), 'utf8'));
    const update = vi.spyOn(chats, 'updateConversation');
    await setup.bindConnectorSetupAssistance('u1', conv.conversation_id, 'notion');
    await setup.bindConnectorSetupAssistance('u1', conv.conversation_id, 'notion');
    expect(update).not.toHaveBeenCalled();
    expect(files.map(file => fs.readFileSync(path.join(chatRoot, file), 'utf8'))).toEqual(before);
    expect((await chats.getConversationMetadata('u1', conv.conversation_id))?.title).toBe('Keep my title');
    update.mockRestore();
  });

  it('preserves the association during unrelated edits and refuses to resurrect a deleted conversation', async () => {
    const chats = await import('../../../src/main/features/chats');
    const setup = await import('../../../src/main/features/connector_setup_context');
    const conv = await chats.createConversation('u1', {
      assistance: { kind: 'connector_setup', connector_id: 'notion' },
    });
    const first = await setup.formatConnectorSetupForTurn('u1', conv.conversation_id);
    // Older clients do not send the optional assistance field on ordinary edits.
    await chats.updateConversation('u1', conv.conversation_id, { title: 'An unrelated follow-up' });
    expect(await setup.formatConnectorSetupForTurn('u1', conv.conversation_id)).toBe(first);
    expect(first).toContain('proves neither an active setup nor a successful connection');
    await chats.deleteConversation('u1', conv.conversation_id);
    await expect(setup.bindConnectorSetupAssistance('u1', conv.conversation_id, 'notion')).rejects.toThrow();
    expect(await setup.formatConnectorSetupForTurn('u1', conv.conversation_id)).toBe('');
    expect(await chats.getConversationMetadata('u1', conv.conversation_id)).toBeNull();
  });

  it('retains only the target across restart, refreshes a switched target, and never writes guidance into dialogue', async () => {
    const chats = await import('../../../src/main/features/chats');
    const setup = await import('../../../src/main/features/connector_setup_context');
    const assistance = setup.validateConnectorSetupAssistance({
      kind: 'connector_setup', connector_id: 'xiaohongshu-seller',
      prompt: 'Injected instructions', secret: 'private-value', status: 'connected',
    });
    expect(assistance).toEqual({ kind: 'connector_setup', connector_id: 'xiaohongshu-seller' });
    const conv = await chats.createConversation('u1', { assistance });
    const ordinary = await chats.createConversation('u1');
    expect(await setup.formatConnectorSetupForTurn('u1', ordinary.conversation_id)).toBe('');
    expect(await setup.formatConnectorSetupForTurn('u2', conv.conversation_id)).toBe('');
    const first = await setup.formatConnectorSetupForTurn('u1', conv.conversation_id);
    expect(first).toContain(setup.connectorSetupGuidance());
    expect(first).toContain('xiaohongshu-seller');
    expect(first).toContain('"setup_guide_id":"xiaohongshu-ark"');
    // Follow-ups retain only the discovery reference, not the provider manual.
    expect(first).not.toContain('## Credentials');
    expect(first.length).toBeLessThan(1600);
    expect(first).not.toContain('private-value');
    expect(first).not.toContain('Injected instructions');
    const chatRoot = path.join(root, 'u1', 'cloud', 'chats');
    expect(fs.readFileSync(path.join(chatRoot, `${conv.conversation_id}.jsonl`), 'utf8')).toBe('');
    expect(fs.readFileSync(path.join(chatRoot, '_index.json'), 'utf8')).not.toContain(setup.connectorSetupGuidance());
    const fetched = await chats.getConversation('u1', conv.conversation_id);
    fetched!.assistance!.connector_id = 'notion';
    expect(await setup.formatConnectorSetupForTurn('u1', conv.conversation_id)).toBe(first);

    vi.resetModules();
    const reloaded = await import('../../../src/main/features/connector_setup_context');
    expect(await reloaded.formatConnectorSetupForTurn('u1', conv.conversation_id)).toBe(first);
    // Missing-index recovery is an explicit feature action, not a side effect
    // of reading a conversation on every model turn.
    fs.unlinkSync(path.join(chatRoot, '_index.json'));
    const reloadedChats = await import('../../../src/main/features/chats');
    reloadedChats.invalidateConversationCaches('u1');
    await reloadedChats.repairConversationIndex('u1');
    expect(await reloaded.formatConnectorSetupForTurn('u1', conv.conversation_id)).toBe(first);
    await reloaded.bindConnectorSetupAssistance('u1', conv.conversation_id, 'notion');
    const next = await reloaded.formatConnectorSetupForTurn('u1', conv.conversation_id);
    expect(next).toContain('"connector_id":"notion"');
    expect(next).not.toContain('xiaohongshu-seller');
    await expect(reloaded.bindConnectorSetupAssistance('u2', conv.conversation_id, 'notion')).rejects.toThrow();
  });

  it('rejects invalid entry targets, while old or unavailable metadata cannot break ordinary conversation reads', async () => {
    const chats = await import('../../../src/main/features/chats');
    const setup = await import('../../../src/main/features/connector_setup_context');
    for (const input of [null, {}, { kind: 'other', connector_id: 'notion' },
      { kind: 'connector_setup', connector_id: '../notion' },
      { kind: 'connector_setup', connector_id: 'unknown-provider' }]) {
      expect(() => setup.validateConnectorSetupAssistance(input)).toThrow();
    }
    const conv = await chats.createConversation('u1', {
      assistance: { kind: 'connector_setup', connector_id: 'removed-provider' },
    });
    expect(await setup.formatConnectorSetupForTurn('u1', conv.conversation_id)).toBe('');
    expect((await chats.getConversation('u1', conv.conversation_id))?.assistance?.connector_id).toBe('removed-provider');
    await chats.updateConversation('u1', conv.conversation_id, { assistance: {
      kind: 'connector_setup', connector_id: 'notion', secret: 'must-not-persist',
    } as any });
    const disk = fs.readFileSync(path.join(root, 'u1', 'cloud', 'chats', '_index.json'), 'utf8');
    expect(disk).not.toContain('must-not-persist');
    expect(setup.connectorSetupGuidance()).toContain('saved configuration');
    expect(setup.connectorSetupGuidance()).toContain('actual verification');
    expect(setup.connectorSetupGuidance()).toContain("user's latest request");
    expect(setup.connectorSetupGuidance()).toContain('not simple OAuth or ordinary connector use');
    // Canonical on-demand contract, not an assertion that a model executed it.
    expect(setup.connectorSetupGuidance()).toContain('choose actions from the actual page');
    expect(setup.connectorSetupGuidance()).toContain('not an assumed menu or fixed sequence');
    expect(setup.connectorSetupGuidance()).toContain('Do not infer missing account permissions');
    expect(setup.connectorSetupGuidance()).toContain('preserve its browser page for handoff');
    expect(setup.connectorSetupGuidance()).toContain('When the user returns, inspect current state and continue');
  });
});
