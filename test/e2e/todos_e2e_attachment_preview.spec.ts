import { expect, test } from './fixtures/orkas';



for (const scope of ['global', 'project'] as const) {
  test(`previews ${scope} todo attachments from the card and editor without editing or removing them`, async ({ orkas }, info) => {
    const page = orkas.page!;
    const project = scope === 'project' ? await orkas.invoke<any>('projects.create', { name: 'Preview project' }) : null;
    const projectId = project?.project.project_id || '';
    const created = await orkas.invoke<any>('projects.tasks.create', { projectId, content: 'Read the attached document' });
    const taskId = created.task.id;
    const upload = (name: string, text: string) => orkas.invoke('projects.tasks.attachments.upload', {
      projectId, taskId, name, dataBase64: Buffer.from(text).toString('base64'),
    });
    await upload('brief.txt', 'Original attachment body');
    if (projectId) {
      await page.evaluate(async (pid) => {
        await (window as any).setView('project', pid);
      }, projectId);
      await page.locator('[data-project-tab="todo"]').click();
    } else await page.locator('#todos-btn').click();
    const card = page.locator(`.project-todo-item[data-tid="${taskId}"]:visible`);
    const preview = await orkas.openPreview(() => card.locator('[data-action="todo-attachments"]').click());
    await expect(preview.locator('.chat-file-viewer-body')).toContainText('Original attachment body');
    await expect(preview.locator('[data-tve-action="edit"]')).toHaveCount(0);
    await expect(page.locator('#todo-editor-modal')).not.toHaveClass(/\bopen\b/);
    await preview.close();

    // Multiple files require a choice; selecting one previews its actual bytes.
    await upload('second.txt', 'Second attachment body');
    await page.evaluate(async (pid) => {
      if (pid) await (window as any)._loadProjectTodos(pid);
      else await (window as any)._refreshGlobalTodos('');
    }, projectId);
    await card.locator('[data-action="todo-attachments"]').click();
    const chosen = await orkas.openPreview(() => page.locator('.context-menu-item', { hasText: 'second.txt' }).click());
    await expect(chosen.locator('.chat-file-viewer-body')).toContainText('Second attachment body');
    await chosen.close();

    await card.locator('[data-action="todo-edit"]').click();
    const chip = page.locator('#project-todo-attachments .chat-attach-chip[data-name="brief.txt"]');
    const editorPreview = await orkas.openPreview(() => scope === 'project' ? chip.press('Enter') : chip.click());
    await expect(editorPreview.locator('.chat-file-viewer-body')).toContainText('Original attachment body');
    await editorPreview.close();
    await expect(page.locator('#project-todo-input')).toHaveValue('Read the attached document');
    await page.screenshot({ path: info.outputPath('todo-attachment-editor.png') });
    await chip.locator('.chat-attach-remove').click();
    await expect(chip).toHaveCount(0);
    await page.locator('#project-todo-cancel').click();
    const saved = await orkas.invoke<any>('projects.tasks.list', { projectId });
    expect(saved.tasks.find((task: any) => task.id === taskId).attachments).toEqual(['brief.txt', 'second.txt']);
  });
}
