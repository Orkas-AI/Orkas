import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from './fixtures/orkas';
import { test } from './fixtures/web-app-eval';
import { exerciseProductInventory, exerciseFlashcards, exerciseSnake } from './fixtures/app-template-journeys';

// Frozen outputs from the same Chinese starter and Codex model on 2026-09-15.
// The first output has a real inline-transform defect; the second uses a valid
// filter UI instead of a list; the third uses dynamic labels and a mastery toggle.
// These are evaluator calibration, not live model
// success evidence. Only the explicit CSS repair and accessible-control variants below
// modify the frozen specimens.
const fixtures = path.join(__dirname, 'fixtures/app-template-flashcards');
for (const scenario of ['list-repaired', 'labeled-list', 'submit-label', 'filter', 'toggle', 'broken-flip', 'broken-toggle'] as const) {
  test(`flashcard oracle ${scenario}`, async ({ sdkOrkas: orkas }, info) => {
    const isToggle = scenario === 'toggle' || scenario === 'broken-toggle';
    const isList = scenario !== 'filter' && !isToggle;
    let html = readFileSync(path.join(fixtures, isToggle ? 'toggle.html' : isList ? 'list-inline-defect.html' : 'filter.html'), 'utf8');
    if (isList && scenario !== 'broken-flip') {
      expect(html).toContain('.inner { position:relative;');
      html = html.replace('.inner { position:relative;', '.inner { display:block; position:relative;');
    }
    if (scenario === 'labeled-list') {
      // A real generated app labels its list "单词列表". Adding the same
      // accessible name must not prevent filling the separate word textbox.
      expect(html).toContain('<ul class="card-list" id="cardList">');
      html = html.replace('<ul class="card-list" id="cardList">', '<ul class="card-list" id="cardList" aria-label="单词列表">');
    }
    if (scenario === 'submit-label') {
      // Preserve submission behavior under a real generated label; a same-name
      // ordinary button must not be mistaken for the form submit control.
      const submit = '<button class="add" type="submit">添加到词卡</button>';
      expect(html).toContain(submit);
      html = html.replace(submit, '<button type="button">添加到卡片组</button><button class="add" type="submit">添加到卡片组</button>');
    }
    if (scenario === 'broken-toggle') {
      const toggle = 'source.mastered = !source.mastered;';
      expect(html).toContain(toggle);
      html = html.replace(toggle, 'if (source.mastered) return; ' + toggle);
    }
    const entry = orkas.createWorkspaceFile('web-app/index.html', html);
    if (isList) orkas.createWorkspaceFile('web-app/orkas-app.json', readFileSync(path.join(fixtures, 'orkas-app.json'), 'utf8'));
    const saved = await orkas.invoke<{ ok: boolean; id: string }>('savedApps.saveFromPath', { path: entry, title: scenario });
    expect(saved.ok).toBe(true);
    await orkas.page.locator('#apps-btn').click();
    const preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${saved.id}"]`).click());
    try {
      const frame = preview.locator('.saved-app-viewer-frame').contentFrame();
      const journey = exerciseFlashcards(frame, preview, name => info.outputPath(name));
      if (scenario === 'broken-flip') {
        await expect(journey).rejects.toThrow('Flip must visibly reveal the answer');
      } else if (scenario === 'broken-toggle') {
        await expect(journey).rejects.toThrow('Returning a card to review must clear mastery');
      } else {
        expect(await journey).toEqual({ added: true, flipped: true, masteryMarked: true, unmasteredPrioritized: true });
      }
      expect(orkas.modelRequests).toHaveLength(0);
    } finally {
      await orkas.closePreview(preview);
    }
  });
}

// Unchanged outputs from the 30-request-budget live run. Mutations below are
// calibration negatives only; never replace the original live evidence.
for (const scenario of ['products', 'products-broken-save', 'flashcards', 'flashcards-broken-answer',
  'flashcards-broken-mastery', 'game', 'game-broken-pause'] as const) {
  test(`starter layout oracle ${scenario}`, async ({ sdkOrkas: orkas }, info) => {
    const id = scenario.split('-')[0];
    const dir = path.join(__dirname, 'fixtures/app-template-live-30', id);
    let html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    const mutate = (before: string, after: string) => {
      expect(html).toContain(before);
      html = html.replace(before, after);
    };
    if (scenario === 'products-broken-save') mutate('event.preventDefault();', 'event.preventDefault(); return;');
    if (scenario === 'flashcards-broken-answer') mutate('<div class="answer">', '<div class="answer" hidden>');
    if (scenario === 'flashcards-broken-mastery') mutate('item.mastered=!item.mastered;', 'if(item.mastered)return; item.mastered=!item.mastered;');
    if (scenario === 'game-broken-pause') mutate('if(!running || paused) return;', 'if(!running) return;');
    const entry = orkas.createWorkspaceFile('web-app/index.html', html);
    if (id === 'products') orkas.createWorkspaceFile('web-app/orkas-app.json', readFileSync(path.join(dir, 'orkas-app.json'), 'utf8'));
    const saved = await orkas.invoke<{ ok: boolean; id: string }>('savedApps.saveFromPath', { path: entry, title: scenario });
    expect(saved.ok).toBe(true);
    await orkas.page.locator('#apps-btn').click();
    let preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${saved.id}"]`).click());
    const reopen = async () => {
      await orkas.closePreview(preview);
      preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${saved.id}"]`).click());
      return preview.locator('.saved-app-viewer-frame').contentFrame();
    };
    try {
      const frame = preview.locator('.saved-app-viewer-frame').contentFrame();
      const journey = id === 'products' ? exerciseProductInventory(frame, reopen)
        : id === 'flashcards' ? exerciseFlashcards(frame, preview, name => info.outputPath(name))
        : exerciseSnake(frame, preview);
      if (scenario === 'products-broken-save') await expect(journey).rejects.toThrow('toContainText');
      else if (scenario === 'flashcards-broken-answer') await expect(journey).rejects.toThrow('The answer must be visible');
      else if (scenario === 'flashcards-broken-mastery') await expect(journey).rejects.toThrow('Returning a card to review');
      else if (scenario === 'game-broken-pause') await expect(journey).rejects.toThrow('Paused snake must stop moving');
      else await journey;
      expect(orkas.modelRequests).toHaveLength(0);
    } finally {
      await orkas.closePreview(preview);
    }
  });
}
