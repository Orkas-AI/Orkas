import { afterEach, expect, it } from 'vitest';
import { clearTaskCreatedDrafts, isTaskCreatedDraft, observeTaskDraftResult } from '../../../../src/main/features/connectors/task-created-drafts';
import { connectorActionRisk } from '../../../../src/main/features/connectors/action_policy';

const scope = { uid: 'user', cid: 'task', connectorId: 'gmail', accountKey: 'account' };
const result = { content: [{ type: 'text', text: '{"id":"new-draft","messageId":"message"}' }] };
afterEach(() => clearTaskCreatedDrafts(() => true));

it('requires successful native creation evidence, with no cross-task or account inheritance', () => {
  expect(isTaskCreatedDraft(scope, 'new-draft')).toBe(false);
  observeTaskDraftResult(scope, 'create_draft', {}, result);
  expect(isTaskCreatedDraft(scope, 'new-draft')).toBe(true);
  for (const variation of [{ uid: 'other' }, { cid: 'other' }, { connectorId: 'google-workspace' }, { accountKey: 'other' }]) {
    expect(isTaskCreatedDraft({ ...scope, ...variation }, 'new-draft')).toBe(false);
  }
  const tool = { name: 'delete_draft', description: '', input_schema: {} };
  expect(connectorActionRisk({ id: 'gmail', origin: 'catalog' }, tool, { id: 'new-draft' }, scope).risk).toBe('W');
  expect(connectorActionRisk({ id: 'gmail', origin: 'custom' }, tool, { id: 'new-draft' }, scope).risk).toBe('H');
  expect(connectorActionRisk({ id: 'google-workspace', origin: 'catalog' }, {
    ...tool, name: 'create_event',
  }, { attendees: [], visibility: 'private' }, scope).risk).toBe('H');
  clearTaskCreatedDrafts(item => item.uid === 'user');
  expect(isTaskCreatedDraft(scope, 'new-draft')).toBe(false);
});

it.each([
  { ...result, isError: true },
  { content: [{ type: 'text', text: '{"id":"new-draft"}' }] },
  { content: [{ type: 'text', text: 'Created draft new-draft' }] },
  { content: [{ type: 'text', text: '{"id":"new-draft","messageId":"message","padding":"' + 'a'.repeat(4096) + '"}' }] },
])('does not manufacture ownership from an error or unrecognized result shape', raw => {
  observeTaskDraftResult(scope, 'create_draft', {}, raw);
  expect(isTaskCreatedDraft(scope, 'new-draft')).toBe(false);
});
