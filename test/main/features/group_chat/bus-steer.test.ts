import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/chat_attachments', () => ({
  resolveAttachmentAbsPath: (_uid: string, _cid: string, name: string) => ({
    ok: true,
    absPath: `/tmp/orkas-rich-steer/${name}`,
    kind: name.endsWith('.png') ? 'image' : 'pdf',
  }),
  buildAttachmentManifest: async (_uid: string, _cid: string, names: string[]) => ({
    manifest: `<attachments>${names.map((name) => `<file name="${name}"/>`).join('')}</attachments>`,
    images: names.filter((name) => name.endsWith('.png')).map(() => ({
      data: 'aW1hZ2U=',
      mediaType: 'image/png',
    })),
    skipped: [],
    metadata: {
      hasAttachments: names.length > 0,
      attachmentTypes: names.map((name) => name.split('.').pop() || 'unknown'),
    },
  }),
}));

vi.mock('../../../../src/main/model/core-agent/skill-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSystemPromptBlock: async ({ allowlist }: { allowlist?: string[] }) => (
    allowlist?.length
      ? `<available_skills><skill id="${allowlist[0]}"><instructions>Review carefully.</instructions></skill></available_skills>`
      : ''
  ),
}));

import {
  drainCliSteerInto,
  drainSteerInto,
} from '../../../../src/main/features/group_chat/bus';

/**
 * Unit tests for CoreAgent active-turn steering. Matching top-level USER rows
 * are hydrated into rich CoreAgent messages, but remain durable in the FIFO
 * queue until AgentRunner acknowledges that Session accepted them.
 */

type AnyItem = Record<string, any>;
let itemSequence = 0;
function item(o: AnyItem): AnyItem {
  itemSequence++;
  return { turnId: `t-${itemSequence}`, msgId: `m-${itemSequence}`, ...o };
}
function fakeW(queue: AnyItem[]): any {
  return { uid: 'user-test', cid: 'cid1', queue };
}
const commander = { kind: 'commander', id: 'commander', name: 'Commander' } as any;
const agentX = { kind: 'agent', id: 'agentX', name: 'X' };
const agentY = { kind: 'agent', id: 'agentY', name: 'Y' };

function steerText(message: AnyItem): string {
  return message.content
    .filter((entry: AnyItem) => entry.type === 'text')
    .map((entry: AnyItem) => entry.text)
    .join('');
}

async function acknowledge(messages: AnyItem[]): Promise<void> {
  await Promise.all(messages.map((message) => message.onApplied?.()));
}

describe('group_chat bus › drainSteerInto (interrupt-steer)', () => {
  it('prepares matching rich messages in FIFO order and removes them only after acknowledgement', async () => {
    const w = fakeW([
      item({ actor: commander, fromActorId: 'user', llmPayload: 'U1' }),
      item({ actor: agentX, fromActorId: 'commander', llmPayload: 'DISPATCH' }),
      item({
        actor: commander,
        fromActorId: 'user',
        llmPayload: 'TEXT_REFERENCE',
        references: [{ source_msg_id: 'source-1', text: 'quoted text' }],
      }),
      item({ actor: agentY, fromActorId: 'user', llmPayload: 'OTHER_ACTOR' }),
      item({ actor: commander, fromActorId: 'user', llmPayload: 'HAS_ATT', attachments: ['a.pdf'] }),
      item({ actor: commander, fromActorId: 'user', llmPayload: 'NESTED', nested: true }),
    ]);

    const folded = await drainSteerInto(w, commander);

    expect(folded.map(steerText)).toEqual([
      'U1',
      'TEXT_REFERENCE',
      expect.stringContaining('HAS_ATT'),
    ]);
    expect(folded[2].historyResources).toEqual([
      expect.objectContaining({
        kind: 'attachment',
        path: '/tmp/orkas-rich-steer/a.pdf',
        name: 'a.pdf',
      }),
    ]);
    // Preparation is not a dequeue acknowledgement: a failed Session commit
    // must leave all source rows recoverable.
    expect(w.queue).toHaveLength(6);

    await acknowledge(folded);
    expect(w.queue.map((q: AnyItem) => q.llmPayload)).toEqual([
      'DISPATCH',
      'OTHER_ACTOR',
      'NESTED',
    ]);
  });

  it('folds a rich user update addressed to the currently running Agent', async () => {
    const payload = '<msg from="user" to="agentX">\nchange direction\n</msg>';
    const w = fakeW([
      item({
        actor: agentX,
        fromActorId: 'user',
        llmPayload: payload,
        attachments: ['diagram.png'],
      }),
    ]);
    const metadata = { hasAttachments: false, attachmentTypes: [] as string[] };

    const folded = await drainSteerInto(w, agentX, { attachmentMetadata: metadata });

    expect(folded).toHaveLength(1);
    expect(steerText(folded[0])).toContain(payload);
    expect(folded[0].content).toContainEqual({
      type: 'image',
      data: 'aW1hZ2U=',
      mediaType: 'image/png',
    });
    expect(w.queue).toHaveLength(1);
    await acknowledge(folded);
    expect(w.queue).toEqual([]);
    expect(metadata).toEqual({ hasAttachments: true, attachmentTypes: ['png'] });
  });

  it('admits a host-verified referenced output as a durable, dynamic read-only resource', async () => {
    const referencedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-steer-reference-'));
    try {
      const produced = path.join(referencedRoot, 'report.md');
      fs.writeFileSync(produced, '# referenced report\n');
      const queued = item({
        actor: commander,
        fromActorId: 'user',
        llmPayload: 'USE_REFERENCED_OUTPUT',
        references: [{
          source_cid: 'source-conversation',
          source_msg_id: 'source-produced',
          text: 'quoted with output',
          produced: [produced],
        }],
      });
      const w = fakeW([queued]);
      const runtimeReadOnlyRoots: string[] = [];

      const folded = await drainSteerInto(w, commander, { runtimeReadOnlyRoots });

      expect(folded).toHaveLength(1);
      expect(folded[0].historyResources).toContainEqual(expect.objectContaining({
        kind: 'explicit',
        path: produced,
        name: 'report.md',
      }));
      expect(runtimeReadOnlyRoots).toEqual([]);
      await acknowledge(folded);
      expect(runtimeReadOnlyRoots).toEqual([referencedRoot]);
      expect(w.queue).toEqual([]);
    } finally {
      fs.rmSync(referencedRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'direct attachment',
      fields: { attachments: ['brief.pdf'] },
      expectedText: '<attachments>',
    },
    {
      label: 'reference attachment',
      fields: {
        references: [{
          source_msg_id: 'source-attachment',
          text: 'quoted with a file',
          attachments: [{ name: 'evidence.csv' }],
        }],
      },
      expectedText: 'RESOURCE_UPDATE',
    },
    {
      label: 'reference produced file',
      fields: {
        references: [{
          source_msg_id: 'source-produced',
          text: 'quoted with output',
          produced: ['/workspace/report.pdf'],
        }],
      },
      expectedText: 'RESOURCE_UPDATE',
    },
    {
      label: 'Skill selection',
      fields: { useSelections: [{ kind: 'skill', id: 'review' }] },
      expectedText: '<runtime-skill-selection',
    },
    {
      label: 'Connector selection',
      fields: { useSelections: [{ kind: 'connector', id: 'notion' }] },
      expectedText: '<runtime-connector-selection',
    },
  ])('hydrates a $label update for the active CoreAgent turn', async ({ fields, expectedText }) => {
    const queued = item({
      actor: commander,
      fromActorId: 'user',
      llmPayload: 'RESOURCE_UPDATE',
      ...fields,
    });
    const w = fakeW([queued]);

    const folded = await drainSteerInto(w, commander);

    expect(folded).toHaveLength(1);
    expect(steerText(folded[0])).toContain(expectedText);
    expect(w.queue).toEqual([queued]);
    await acknowledge(folded);
    expect(w.queue).toEqual([]);
  });

  it('returns [] and leaves the queue intact when nothing matches the running actor', async () => {
    const w = fakeW([
      item({ actor: agentX, fromActorId: 'commander', llmPayload: 'DISPATCH' }),
      item({ actor: agentY, fromActorId: 'user', llmPayload: 'OTHER_ACTOR' }),
    ]);
    expect(await drainSteerInto(w, commander)).toEqual([]);
    expect(w.queue.length).toBe(2);
  });

  it('drains all matching messages even when interleaved with non-matching ones', async () => {
    const w = fakeW([
      item({ actor: commander, fromActorId: 'user', llmPayload: 'A' }),
      item({ actor: agentX, fromActorId: 'commander', llmPayload: 'D1' }),
      item({ actor: commander, fromActorId: 'user', llmPayload: 'B' }),
      item({ actor: agentX, fromActorId: 'commander', llmPayload: 'D2' }),
      item({ actor: commander, fromActorId: 'user', llmPayload: 'C' }),
    ]);
    const folded = await drainSteerInto(w, commander);
    expect(folded.map(steerText)).toEqual(['A', 'B', 'C']);
    expect(w.queue).toHaveLength(5);
    await acknowledge(folded);
    expect(w.queue.map((q: AnyItem) => q.llmPayload)).toEqual(['D1', 'D2']);
  });
});

describe('group_chat bus › native CLI interrupt-steer', () => {
  it('hydrates and acknowledges text, image attachment, Skill and Connector in one CLI submission', async () => {
    const queued = item({
      actor: agentX,
      fromActorId: 'user',
      llmPayload: '<msg from="user" to="agentX">\nCLI_RICH_UPDATE\n</msg>',
      attachments: ['diagram.png', 'brief.pdf'],
      useSelections: [
        { kind: 'skill', id: 'review' },
        { kind: 'connector', id: 'notion', name: 'Notion' },
      ],
    });
    const submitted: AnyItem[] = [];
    const ingress = {
      submit: vi.fn(async (input: AnyItem) => {
        submitted.push(input);
        return { mode: 'steered' as const, acceptedId: input.id };
      }),
    };
    const w = fakeW([queued]);
    w.currentTurnIngress = ingress;

    const applied = await drainCliSteerInto(w, agentX as any, ingress, {
      connectorTools: {
        list: 'orkas_list_connector_tools',
        call: 'orkas_call_connector_tool',
      },
    });

    expect(applied).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].id).toBe(queued.turnId);
    expect(submitted[0].text).toContain('CLI_RICH_UPDATE');
    expect(submitted[0].text).toContain('<attachments>');
    expect(submitted[0].text).toContain('<runtime-resources source="host-validated">');
    expect(submitted[0].text).toContain(`path="${path.resolve('/tmp/orkas-rich-steer/brief.pdf')}"`);
    expect(submitted[0].text).toContain('<runtime-skill-selection');
    expect(submitted[0].text).toContain('orkas_list_connector_tools/orkas_call_connector_tool');
    expect(submitted[0].localImages).toEqual([{
      path: path.resolve('/tmp/orkas-rich-steer/diagram.png'),
      mediaType: 'image',
    }]);
    expect(w.queue).toEqual([]);
  });

  it('includes host-verified cross-conversation files in the CLI update frame', async () => {
    const referencedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-steer-reference-'));
    try {
      const produced = path.join(referencedRoot, 'report & evidence.md');
      fs.writeFileSync(produced, '# referenced report\n');
      const queued = item({
        actor: agentX,
        fromActorId: 'user',
        llmPayload: 'USE_CROSS_CONVERSATION_OUTPUT',
        references: [{
          source_cid: 'source-conversation',
          source_msg_id: 'source-produced',
          text: 'quoted with output',
          produced: [produced],
        }],
      });
      const ingress = {
        submit: vi.fn(async () => ({ mode: 'steered' as const })),
      };
      const w = fakeW([queued]);
      w.currentTurnIngress = ingress;

      expect(await drainCliSteerInto(w, agentX as any, ingress)).toBe(1);
      const input = ingress.submit.mock.calls[0][0];
      expect(input.text).toContain('<runtime-resources source="host-validated">');
      expect(input.text).toContain('kind="explicit"');
      expect(input.text).toContain(`path="${produced.replace('&', '&amp;')}"`);
      expect(input.text).toContain('name="report &amp; evidence.md"');
      expect(input.localImages).toBeUndefined();
      expect(w.queue).toEqual([]);
    } finally {
      fs.rmSync(referencedRoot, { recursive: true, force: true });
    }
  });

  it('retains the current and later FIFO rows when a CLI ingress cannot accept the first update', async () => {
    const first = item({ actor: agentX, fromActorId: 'user', llmPayload: 'FIRST' });
    const second = item({ actor: agentX, fromActorId: 'user', llmPayload: 'SECOND' });
    const ingress = {
      submit: vi.fn(async () => ({
        mode: 'queued_followup' as const,
        reason: 'native turn already completed',
      })),
    };
    const w = fakeW([first, second]);
    w.currentTurnIngress = ingress;

    const applied = await drainCliSteerInto(w, agentX as any, ingress);

    expect(applied).toBe(0);
    expect(ingress.submit).toHaveBeenCalledTimes(1);
    expect(w.queue).toEqual([first, second]);
  });
});
