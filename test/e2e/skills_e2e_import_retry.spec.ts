import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';

test('retries folder-import metadata after relaunch and keeps the installed Skill files intact', async ({ modelOrkas: app }) => {
  await app.selectLocalResponsesModel();
  const id = 'import-retry-e2e';
  const entry = Buffer.from(`---\nname: ${id}\ndescription: Review release notes.\n---\n\n# Original imported body\n`);
  const notes = Buffer.from('Original reference\n');
  const source = path.dirname(app.createFixtureFile('SKILL.md', entry));
  app.createFixtureFile('notes.md', notes);
  app.setModelMode('auth-error');
  await app.selectFilesOnNextDialog([source]);

  let page = app.page!;
  await page.locator('#skills-btn').click();
  await page.locator('#create-skill-btn').click();
  await page.locator('[data-skill-tab="dir"]').click();
  await page.locator('#skill-dir-pick-btn').click();
  await expect(page.locator('#skill-dir-path')).toHaveValue(source);
  await page.locator('#skill-save-btn').click();
  await expect(page.locator('#skills-chat-messages .bubble-retry-btn')).toHaveCount(1);
  const refusals = app.apiResponses.filter(({ path, status }) => status === 401
    && (path === '/api/v1/responses' || path === '/api/v1/chat/completions'));
  expect(refusals.some(({ path }) => path === '/api/v1/responses')).toBe(true);
  for (const { method, path, status } of refusals) app.expectApiFailure(method, path, status);
  const readSkill = () => app.invoke<{ skill: { dir: string; category: string } }>('skills.get', { id });
  const { skill } = await readSkill();
  const installedEntry = readFileSync(path.join(skill.dir, 'SKILL.md'));
  expect(installedEntry.toString()).toContain('# Original imported body');
  expect(readFileSync(path.join(skill.dir, 'notes.md'))).toEqual(notes);

  app.setModelMode('success');
  app.setModelTextReplies([[
    '<skill-meta><category>office</category></skill-meta>',
    '<<<skill-file path=SKILL.md', '---', `name: ${id}`, 'description: Wrong replacement', '---', '# Wrong body', '>>>',
    '<<<skill-file path=notes.md', 'Wrong reference', '>>>',
  ].join('\n')]);
  page = await app.relaunch();
  await page.locator('#skills-btn').click();
  await page.locator(`#skills-grid [data-source="custom"][data-id="${id}"]`).click();
  await page.locator('#skill-edit-btn').click();
  const retry = page.locator('#skills-chat-messages .bubble-retry-btn');
  await expect(retry).toHaveCount(1);
  await retry.click();
  await expect.poll(async () => (await readSkill()).skill.category).toBe('office');
  await expect(page.locator('#skills-chat-messages .chat-message.assistant').last()).toContainText('Skill update complete.');
  expect(readFileSync(path.join(skill.dir, 'SKILL.md'))).toEqual(installedEntry);
  expect(readFileSync(path.join(skill.dir, 'notes.md'))).toEqual(notes);
});
