import { expect, test } from './fixtures/orkas';
import { holdInvokeResponse } from './fixtures/held-invoke-response';

for (const order of ['after', 'before'] as const) test(`follows the Agent when its floor arrives ${order} the Commander acknowledgement`, async ({ orkas: app }, info) => {
  const page = app.page!;
  const { agent } = await app.invoke<any>('agents.create', { name:'FloorFollowAgent', description:'Local routing regression fixture.' });
  const { conversation } = await app.invoke<any>('conversations.create', { title:'Recipient acknowledgement' });
  const cid = conversation.conversation_id;
  await page.evaluate(async () => { await (window as any).loadAgents(); });
  expect((await app.invoke<any>('groupChat.setFloor', { cid, actor_id:agent.agent_id })).ok).toBe(true);
  await page.evaluate(id => (window as any).setView('conversation', id), cid);
  await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#chat-recipient-name')).toHaveText('FloorFollowAgent');
  // Use the real chip action and await its real IPC acknowledgement. No model
  // output, billing form or account identity is required for this transition.
  if (order === 'before') await holdInvokeResponse(app.electronApp!, 'groupChat.setFloor');
  try {
  await page.evaluate(async () => {
    const w = window as any;
    w.setChatRecipient('conversation', { kind:'commander' });
  });
  if (order === 'after') await page.evaluate('Promise.all(Array.from(_floorSyncByCid.values()))');
  else await expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__heldInvokeResponse.ready)).toBe(true);
  await expect(page.locator('#chat-recipient-name')).toHaveText('Commander');
  const next = await app.invoke<any>('groupChat.setFloor', { cid, actor_id:agent.agent_id });
  expect(next.ok).toBe(true);
  // A state_changed event normally delivers this authoritative snapshot. Feed
  // the actual IPC result through its production renderer consumer to avoid
  // coupling the fixture to the idle event-stream reconnect interval.
  await page.evaluate(async ({ cid, state }) => {
    (window as any)._rememberServerFloor(cid, state);
    await (window as any)._evaluateAutoRecipient(cid);
  }, { cid, state:next.state });
  if (order === 'before') {
    await expect(page.locator('#chat-recipient-name')).toHaveText('Commander');
    await app.electronApp!.evaluate(() => (globalThis as any).__heldInvokeResponse.release());
    await page.evaluate('Promise.all(Array.from(_floorSyncByCid.values()))');
  }
  await expect(page.locator('#chat-recipient-name')).toHaveText('FloorFollowAgent');
  expect(await page.evaluate(() => (window as any).applyRecipientPrefix('Continue the work', 'conversation'))).toBe('Continue the work');
  expect(await page.evaluate(() => (window as any).getChatRecipient('conversation').id)).toBe(agent.agent_id);
  await page.locator('#chat-recipient-chip').screenshot({ path:info.outputPath('active-recipient.png') });
  } finally {
    if (order === 'before') await app.electronApp!.evaluate(() => {
      const control = (globalThis as any).__heldInvokeResponse; control.release(); control.restore();
    });
  }
});
