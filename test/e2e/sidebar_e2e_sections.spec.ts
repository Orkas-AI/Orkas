import { expect, test } from './fixtures/orkas';

test.describe('sidebar sections', () => {
  test('collapses and expands Projects and Tasks from their title controls', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const projectsToggle = page.locator('#projects-section-toggle');
    const tasksToggle = page.locator('#tasks-section-toggle');

    await expect(projectsToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(tasksToggle).toHaveAttribute('aria-expanded', 'true');

    await projectsToggle.locator('.sidebar-section-title').click();
    await expect(projectsToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#projects-list')).toBeHidden();

    await tasksToggle.locator('.sidebar-section-title').click();
    await expect(tasksToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#conversation-list')).toBeHidden();

    await projectsToggle.locator('.sidebar-section-title').click();
    await tasksToggle.locator('.sidebar-section-title').click();
    await expect(projectsToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(tasksToggle).toHaveAttribute('aria-expanded', 'true');
  });
});
