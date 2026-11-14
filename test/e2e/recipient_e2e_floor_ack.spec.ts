import { expect, test } from './fixtures/orkas';

test('follows a newly active Agent after the return to Commander was acknowledged', async ({ orkas: app }, info) => {
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
  await page.evaluate(async () => {
    const w = window as any;
    w.setChatRecipient('conversation', { kind:'commander' });
  });
  await page.evaluate('Promise.all(Array.from(_floorSyncByCid.values()))');
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
  await expect(page.locator('#chat-recipient-name')).toHaveText('FloorFollowAgent');
  expect(await page.evaluate(() => (window as any).applyRecipientPrefix('Continue the work', 'conversation'))).toBe('Continue the work');
  expect(await page.evaluate(() => (window as any).getChatRecipient('conversation').id)).toBe(agent.agent_id);
  await page.locator('#chat-recipient-chip').screenshot({ path:info.outputPath('active-recipient.png') });
});
