import { existsSync, readFileSync } from 'node:fs';
import { openSidebarEntry, expect, test } from './fixtures/orkas';


for (const scope of ['global', 'project'] as const) {
  test(`adds pasted and dropped files to a ${scope} todo and preserves their bytes on Save`, async ({ orkas }, info) => {
    const page = orkas.page!;
    await page.evaluate(() => (window as any).setLang('en'));
    const project = scope === 'project' ? await orkas.invoke<any>('projects.create', { name: 'Attachment project' }) : null;
    const projectId = project?.project.project_id || '';
    if (projectId) {
      await page.evaluate(async (pid) => { await (window as any).setView('project', pid); }, projectId);
      await page.locator('[data-project-tab="todo"]').click();
      await page.locator('#project-todo-add-btn').click();
    } else {
      await openSidebarEntry(page, '#todos-btn');
      await page.locator('#todos-add-btn').click();
    }
    const input = page.locator('#project-todo-input');
    await input.fill('Review the attached files');
    const pasteHandled = await input.evaluate((element) => {
      const clipboard = new DataTransfer();
      clipboard.items.add(new File(['Pasted document bytes'], 'pasted.txt', { type: 'text/plain' }));
      clipboard.items.add(new File(['Second pasted document'], 'second.md', { type: 'text/markdown' }));
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(pasteHandled).toBe(true);
    const chips = page.locator('#project-todo-attachments .chat-attach-chip');
    await expect(chips).toHaveCount(2);
    await expect(page.locator('#project-todo-attachments .is-uploading')).toHaveCount(0);

    // Dropping directly on the textarea bubbles to the generous composer target.
    const dropHandled = await input.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['Dropped document bytes'], 'dropped.txt', { type: 'text/plain' }));
      const handled = [];
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
        element.dispatchEvent(event);
        handled.push(event.defaultPrevented);
      }
      return handled;
    });
    expect(dropHandled).toEqual([true, true, true]);
    await expect(chips).toHaveCount(3);
    await expect(page.locator('#project-todo-attachments .is-uploading')).toHaveCount(0);
    await expect(input).toHaveValue('Review the attached files');
    await expect(page.locator('#project-todo-composer')).not.toHaveClass(/drag-over/);
    await page.locator('#todo-editor-modal').screenshot({ path: info.outputPath('pasted-and-dropped-attachments.png') });
    await page.locator('#project-todo-save').click();
    await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/\bopen\b/);
    const saved = await orkas.invoke<any>('projects.tasks.list', { projectId });
    const task = saved.tasks.find((item: any) => item.content === 'Review the attached files');
    expect(task.attachments).toEqual(['pasted.txt', 'second.md', 'dropped.txt']);
    for (const [name, body] of [
      ['pasted.txt', 'Pasted document bytes'], ['second.md', 'Second pasted document'], ['dropped.txt', 'Dropped document bytes'],
    ]) {
      const file = await orkas.invoke<any>('projects.tasks.attachments.absPath', { projectId, taskId: task.id, name });
      expect(file.ok).toBe(true);
      expect(readFileSync(file.path, 'utf8')).toBe(body);
    }
  });
}

test('keeps ordinary text paste native and discards pasted draft attachments on Cancel', async ({ orkas }) => {
  const page = orkas.page!;
  await openSidebarEntry(page, '#todos-btn');
  await page.locator('#todos-add-btn').click();
  const input = page.locator('#project-todo-input');
  const textHandled = await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', 'Ordinary pasted text');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(textHandled).toBe(false);
  await expect(page.locator('#project-todo-attachments .chat-attach-chip')).toHaveCount(0);
  await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File(['Cancelled attachment bytes'], 'cancelled.txt', { type: 'text/plain' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  const chip = page.locator('#project-todo-attachments .chat-attach-chip');
  await expect(chip).toContainText('cancelled.txt');
  await expect(chip).not.toHaveClass(/is-uploading/);
  const taskId = await page.evaluate(() => eval('_todoEditorTid'));
  const file = await orkas.invoke<any>('projects.tasks.attachments.absPath', { taskId, name: 'cancelled.txt' });
  expect(file.ok).toBe(true);
  await page.locator('#project-todo-cancel').click();
  await expect.poll(() => existsSync(file.path)).toBe(false);
  const saved = await orkas.invoke<any>('projects.tasks.list', {});
  expect(saved.tasks.some((task: any) => task.id === taskId)).toBe(false);
  await page.locator('#todos-add-btn').click();
  await expect(page.locator('#project-todo-attachments .chat-attach-chip')).toHaveCount(0);
  await page.locator('#project-todo-cancel').click();
});
