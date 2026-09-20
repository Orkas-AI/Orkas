import { randomUUID } from 'node:crypto';
import type { FrameLocator, Page } from '@playwright/test';
import { expect } from './orkas';

type Checkpoint = (key: string) => void;

// Values are created after authoring. Exercise visible controls; do not inspect
// app state or execute its functions to manufacture a passing outcome.
export async function exerciseProductInventory(frame: FrameLocator, reopen: () => Promise<FrameLocator>, passed?: Checkpoint) {
  const name = `商品-${randomUUID().slice(0, 8)} <b>原样文本</b>`;
  const nameInput = frame.getByRole('textbox', { name: /^商品名称/ });
  if (!await nameInput.isVisible()) await frame.getByRole('button', { name: /添加商品|新增商品/ }).first().click();
  const form = frame.locator('form').filter({ has: nameInput });
  const submit = form.locator('button[type="submit"], button:not([type]), input[type="submit"]');
  const price = form.getByRole('spinbutton', { name: /售价|价格/ });
  const stock = form.getByRole('spinbutton', { name: /库存/ });
  await nameInput.fill(name);
  await price.fill('12.37');
  await stock.fill('7');
  await submit.click();
  const row = () => frame.getByRole('row').filter({ hasText: name });
  await expect(row()).toContainText('12.37');
  await expect(row()).toContainText('7');
  passed?.('added');
  await row().getByRole('button', { name: /编辑|修改/ }).click();
  await price.fill('21.43');
  await stock.fill('0');
  await submit.click();
  await expect(row()).toContainText('21.43');
  passed?.('edited');
  await expect(row().getByRole('cell').filter({ hasText: /^0$/ })).toBeVisible();
  passed?.('zeroStock');
  frame = await reopen();
  await expect(row()).toContainText('21.43');
  passed?.('reopened');
  await row().getByRole('button', { name: /删除/ }).click();
  const confirm = frame.getByRole('dialog').getByRole('button', { name: /删除/ });
  if (await confirm.count()) await confirm.click();
  await expect(row()).toHaveCount(0);
  frame = await reopen();
  await expect(row()).toHaveCount(0);
  passed?.('deleted');
  return { added: true, edited: true, zeroStock: true, deleted: true, reopened: true };
}

async function selectOptionMatching(select: ReturnType<FrameLocator['getByRole']>, label: RegExp) {
  const options = await select.locator('option').evaluateAll(els => els.map(el => ({ text: el.textContent || '', value: (el as HTMLOptionElement).value })));
  const option = options.find(item => label.test(item.text));
  expect(option, 'The requested option must be available').toBeTruthy();
  await select.selectOption(option!.value);
  return option!.value;
}
export async function exerciseConverter(frame: FrameLocator, passed?: Checkpoint) {
  const from = frame.getByRole('combobox', { name: /输入单位|源单位|从/ });
  const to = frame.getByRole('combobox', { name: /输出单位|目标单位|换算为/ });
  const input = frame.getByRole('spinbutton').first();
  const result = frame.locator('output:visible');
  const value = async () => Number((await result.innerText()).replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/)?.[0]);
  await selectOptionMatching(from, /^千米$|^公里$|^km$/i);
  await selectOptionMatching(to, /^米$|^m$/i);
  await input.fill('2.37');
  await expect.poll(value).toBeCloseTo(2370, 5);
  passed?.('length');
  const before = [await from.inputValue(), await to.inputValue()];
  await frame.getByRole('button', { name: /交换/ }).click();
  expect([await from.inputValue(), await to.inputValue()]).toEqual(before.reverse());
  await input.fill('730');
  await expect.poll(value).toBeCloseTo(0.73, 5);
  passed?.('swapped');
  await frame.getByRole('tab', { name: /重量/ }).click();
  await selectOptionMatching(from, /^千克$|^公斤$|^kg$/i);
  await selectOptionMatching(to, /^克$|^g$/i);
  await input.fill('1.25');
  await expect.poll(value).toBeCloseTo(1250, 5);
  passed?.('weight');
  await frame.getByRole('tab', { name: /温度/ }).click();
  await selectOptionMatching(from, /华氏|°F/i);
  await selectOptionMatching(to, /摄氏|°C/i);
  await input.fill('77');
  await expect.poll(value).toBeCloseTo(25, 5);
  passed?.('temperatureOffset');
  await input.fill('-40');
  await expect.poll(value).toBeCloseTo(-40, 5);
  passed?.('negativeTemperature');
  return { length: true, weight: true, temperatureOffset: true, negativeTemperature: true, swapped: true };
}

export async function exerciseFlashcards(frame: FrameLocator, page: Page, evidencePath: (name: string) => string, passed?: Checkpoint) {
  const words = [`word-${randomUUID().slice(0, 8)}`, `word-${randomUUID().slice(0, 8)}`];
  const meanings = ['含义甲：独立测试数据', '含义乙：另外一张词卡'];
  const wordInput = frame.getByRole('textbox', { name: /^单词/ });
  const addForm = frame.locator('form').filter({ has: wordInput });
  for (let i = 0; i < 2; i++) {
    await wordInput.fill(words[i]);
    await frame.getByLabel(/^释义/).fill(meanings[i]);
    await frame.getByLabel(/^例句/).fill(`This is ${words[i]}.`);
    await addForm.locator('button[type="submit"], button:not([type]), input[type="submit"]').click();
  }
  const flip = frame.getByRole('button', { name: /翻转.*卡|翻.*答案|收起答案|显示释义|显示单词|卡片正面|卡片背面/ });
  // A card may itself be a button or contain a separate flip button.
  const article = frame.getByRole('article').filter({ has: flip });
  const separateFlip = await article.count() === 1;
  const card = separateFlip ? article : flip;
  await expect(card).toContainText(words[1]);
  passed?.('added');
  const before = await card.screenshot({ path: evidencePath('flashcard-front.png') });
  await flip.click();
  await expect(card).toContainText(meanings[1]);
  await expect(card.getByText(meanings[1], { exact: true }), 'The answer must be visible').toBeVisible();
  await page.waitForTimeout(600); // Finish the visible flip before comparing pixels.
  const after = await card.screenshot({ path: evidencePath('flashcard-back.png') });
  expect(after.equals(before), 'Flip must visibly reveal the answer').toBe(false);
  passed?.('flipped');
  await (separateFlip ? card : frame).getByRole('button', { name: /我已掌握|^已掌握$|标记.*掌握|^已经掌握$/ }).click();
  await expect(card).toContainText(words[0]);
  // The template promises mastery and priority, not a particular list layout.
  // Verify the marked word through the app's list or its mastery filter.
  const masteredRow = frame.getByRole('listitem').filter({ hasText: words[1] });
  if (await masteredRow.count()) {
    await expect(masteredRow).toContainText('已掌握');
  } else {
    await filterCards('mastered');
    await expect(card).toContainText(words[1]);
    await expect(card).toContainText('已掌握');
    await filterCards('review');
    await expect(card).toContainText(words[0]);
    await expect(card).not.toContainText(words[1]);
  }
  passed?.('masteryMarked');
  const again = frame.getByRole('button', { name: /还不熟悉|未掌握|不认识/ });
  if (await again.count()) {
    await again.click();
    await expect(card).toContainText(words[0]);
    await expect(card).not.toContainText(words[1]);
  } else if (await masteredRow.count()) {
    // A mastery toggle exposes its reverse action only on a mastered card.
    // Reopen that card through the visible list and verify the state reversal.
    await masteredRow.getByRole('button', { name: words[1], exact: true }).click();
    await frame.getByRole('button', { name: /未掌握/ }).click();
    await expect(masteredRow, 'Returning a card to review must clear mastery').not.toContainText('已掌握');
    await expect(card).toContainText(words[1]);
    await expect(card).not.toContainText(words[0]);
  } else {
    await filterCards('mastered');
    await expect(card).toContainText(words[1]);
    await flip.click();
    await card.getByRole('button', { name: /未掌握/ }).click();
    await expect(card, 'Returning a card to review must remove it from the mastered filter').not.toContainText(words[1]);
    await filterCards('review');
    await expect(card).toContainText(words[1]);
    await expect(card).not.toContainText(words[0]);
  }
  passed?.('unmasteredPrioritized');
  return { added: true, flipped: true, masteryMarked: true, unmasteredPrioritized: true };

  async function filterCards(state: 'mastered' | 'review') {
    const select = frame.getByRole('combobox', { name: /筛选/ });
    if (await select.count()) await selectOptionMatching(select, state === 'mastered' ? /仅已掌握/ : /仅待复习/);
    else await frame.getByRole('group', { name: /筛选/ }).getByRole('button', {
      name: state === 'mastered' ? /^已掌握$/ : /优先复习/,
    }).click();
  }
}

export async function exerciseSnake(frame: FrameLocator, page: Page, passed?: Checkpoint) {
  const board = frame.locator('canvas');
  const pixels = () => board.evaluate((el: HTMLCanvasElement) => el.toDataURL());
  const difficulty = frame.getByRole('combobox', { name: /难度/ });
  const levels = await difficulty.locator('option').evaluateAll(options => options
    .filter(option => !(option as HTMLOptionElement).disabled)
    .map(option => ({ value: (option as HTMLOptionElement).value, label: option.textContent || '' })));
  expect(levels.length, 'Difficulty must offer multiple levels').toBeGreaterThan(1);
  await difficulty.selectOption(levels[0].value);
  await frame.getByRole('button', { name: /重新开始/ }).click();
  await expect(frame.getByText(/^最高分(?:\s*\d+)?$/)).toBeVisible();
  for (const direction of ['上', '下', '左', '右']) {
    await expect(frame.getByRole('button', { name: new RegExp(`向${direction}`) })).toBeVisible();
  }
  const initial = await pixels();
  await frame.getByRole('button', { name: /向上/ }).click();
  await expect.poll(pixels, { timeout: 3000 }).not.toBe(initial);
  passed?.('movement');
  await frame.getByRole('button', { name: /^暂停$/ }).click();
  const paused = await pixels();
  await page.waitForTimeout(400);
  expect(await pixels(), 'Paused snake must stop moving').toBe(paused);
  passed?.('pause');
  await frame.getByRole('button', { name: /^继续$|恢复/ }).click();
  await expect.poll(pixels, { timeout: 3000 }).not.toBe(paused);
  passed?.('resume');
  // Keyboard input is delivered to the app frame, not a generated JS function.
  await frame.getByRole('button', { name: /向右/ }).focus();
  await page.keyboard.press('ArrowRight');
  const turned = await pixels();
  await expect.poll(pixels, { timeout: 3000 }).not.toBe(turned);
  passed?.('keyboard');
  await frame.getByRole('button', { name: /重新开始/ }).click();
  await expect(frame.getByText(/^(?:当前分数|分数)(?:\s*\d+)?$/).first().locator('..')).toContainText('0');
  passed?.('restart');
  await difficulty.selectOption(levels[levels.length - 1].value);
  await expect(difficulty.locator('option:checked')).toHaveText(levels[levels.length - 1].label);
  passed?.('difficulty');
  return { movement: true, pause: true, resume: true, keyboard: true, restart: true, difficulty: true,
    limits: 'Eating, collision, high-score persistence and visual design are not scored by this smoke journey.' };
}
