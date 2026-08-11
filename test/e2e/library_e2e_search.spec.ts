import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/orkas';

test.describe('library and global search', () => {
  test('indexes a Library file and closes the model kb_search to kb_read loop', async ({ modelOrkas }) => {
    test.setTimeout(90_000);
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const filePath = 'polaris-recovery-e2e.md';
    const expectedFact = 'Polaris recovery code is cobalt-741';
    await modelOrkas.invoke('contexts.write', {
      path: filePath,
      content: `# Polaris recovery\n\n${expectedFact}. Use it only in the deterministic E2E fixture.\n`,
    });

    // Reports the record's own status plus its error/summary on timeout. This
    // case fails intermittently only in a full-suite run (it is stable alone and
    // within its own spec), and a bare `undefined`/`pending` cannot distinguish
    // "indexing is merely slow under load" from "the record errored" or "the
    // file never reached the indexer at all".
    await expect.poll(async () => {
      const status = await modelOrkas.invoke<{
        summary?: Record<string, unknown>;
        files: Array<{ path: string; status: string; error?: string }>;
      }>('kb.status');
      const record = status.files.find((file) => file.path === filePath);
      if (!record) return `absent (files=${status.files.length}, summary=${JSON.stringify(status.summary || {})})`;
      return record.error ? `${record.status} (error=${record.error})` : record.status;
    }, {
      message: 'the Library fixture should finish vector indexing',
      timeout: 40_000,
    }).toBe('ready');

    modelOrkas.setKnowledgeBaseScenario(
      'What recovery code does Polaris use?',
      filePath,
      expectedFact,
      'E2E Library retrieval returned cobalt-741.',
    );
    await page.locator('#new-chat-input').fill('Read the Library and tell me the Polaris recovery code.');
    await page.locator('#new-chat-send-btn').click();

    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      'E2E Library retrieval returned cobalt-741.',
      { timeout: 30_000 },
    );
  });

  test('makes an uploaded Library image searchable through the open-build description path', async ({
    modelOrkas,
  }) => {
    test.setTimeout(90_000);
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const fileName = 'library-vision-e2e.png';
    const expectedFact = 'The indexed image contains an orca with navy, white, and blue markings.';
    modelOrkas.setLibraryImageDescriptionReplies([expectedFact]);
    const source = modelOrkas.createFixtureFile(
      fileName,
      readFileSync(path.resolve(__dirname, '../../src/resources/icons/logo.png')),
    );
    await modelOrkas.selectFilesOnNextDialog([source]);

    await page.locator('#contexts-btn').click();
    await page.locator('#ctx-root-menu-btn').click();
    await page.locator('#ctx-row-menu .ctx-row-menu-item[data-action="upload"]').click();
    await expect(page.locator(`.ctx-tree-wrap[data-path="${fileName}"]`)).toBeVisible();

    await expect.poll(async () => {
      const status = await modelOrkas.invoke<{
        files: Array<{ path: string; status: string }>;
      }>('kb.status');
      return status.files.find((file) => file.path === fileName)?.status;
    }, {
      message: 'the image should become ready after local vision description and embedding',
      timeout: 40_000,
    }).toBe('ready');

    const visionRequest = modelOrkas.modelRequests.find((request) => (
      JSON.stringify(request).includes('Library image-understanding assistant')
    ));
    expect(visionRequest).toBeDefined();
    const visionRequestText = JSON.stringify(visionRequest);
    // The deterministic open-build fixture uses a text-only BYO model. The
    // synchronized image-describer unit suite covers multimodal payloads;
    // this E2E protects the filename fallback, indexing, search, and retrieval.
    expect(visionRequestText.includes('Source filename JSON')).toBe(true);
    expect(visionRequestText.includes(fileName)).toBe(true);

    const searchShortcut = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
    await page.keyboard.press(searchShortcut);
    const searchOverlay = page.locator('#search-overlay');
    const searchInput = page.locator('#search-input');
    await expect(searchOverlay).toBeVisible();
    await searchInput.fill('orca navy white blue markings');
    const imageSearchResult = page.locator('#search-body .search-result', {
      hasText: fileName,
    }).first();
    await expect(imageSearchResult).toBeVisible({ timeout: 20_000 });
    await imageSearchResult.click();
    await expect(searchOverlay).toBeHidden();
    await expect(page.locator('#panel-contexts')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#contexts-editor-path')).toHaveText(fileName);

    modelOrkas.setKnowledgeBaseScenario(
      'Which animal and colors are recorded in the uploaded image?',
      fileName,
      expectedFact,
      'E2E Library image retrieval returned the indexed orca description.',
    );
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill(
      'Search the Library image and tell me which animal and colors it contains.',
    );
    await page.locator('#new-chat-send-btn').click();

    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      'E2E Library image retrieval returned the indexed orca description.',
      { timeout: 30_000 },
    );
  });

  test('finds chats, agents, skills, and Library content with filters and keyboard navigation', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const query = 'omniflow-e2e';
    const searchShortcut = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
    const openSearch = async () => {
      await page.keyboard.press(searchShortcut);
      const overlay = page.locator('#search-overlay');
      const input = page.locator('#search-input');
      await expect(overlay).toBeVisible();
      await expect(input).toBeFocused();
      // The conversation view hands its composer a default focus on a 50ms
      // timer. Wait past that window and re-check: a convenience focus must
      // not pull the caret out of the search box the user just opened.
      await page.waitForTimeout(80);
      await expect(input).toBeFocused();
      return { overlay, input };
    };
    await modelOrkas.invoke('agents.create', {
      name: 'OmniflowE2EAgent',
      description: `Agent result for ${query}.`,
      category: 'general',
    });
    await modelOrkas.invoke('skills.create', {
      name: 'omniflow-e2e-skill',
      description: `Skill result for ${query}.`,
      category: 'general',
    });
    await modelOrkas.invoke('contexts.write', {
      path: 'omniflow-e2e-library.md',
      content: `# Search fixture\n\nLibrary result for ${query}.\n`,
    });

    // Warm and trust the chat index before the new message is written. Without
    // the real bus → incremental-index wiring, the later search can otherwise
    // pass only because the first query performs a full repair scan.
    let { overlay, input } = await openSearch();
    const emptySearchHeight = await page.locator('.search-modal').evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    await input.fill(query);
    await expect(page.locator('.search-result-kind.is-chat')).toHaveCount(0);
    await input.press('Escape');
    await expect(overlay).toBeHidden();

    await page.locator('#new-chat-input').fill(`Remember this searchable chat marker: ${query}.`);
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      'Hello from the local E2E model.',
      { timeout: 20_000 },
    );

    ({ overlay, input } = await openSearch());
    await expect(page.locator('.search-history-item', { hasText: query })).toBeVisible();
    const historySearchHeight = await page.locator('.search-modal').evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(historySearchHeight).toBeCloseTo(emptySearchHeight, 1);
    await input.fill(query);
    await expect(page.locator('.search-result-kind.is-chat').first()).toBeVisible();
    await expect(page.locator('.search-result-kind.is-agent').first()).toBeVisible();
    await expect(page.locator('.search-result-kind.is-skill').first()).toBeVisible();
    await expect(page.locator('.search-result-kind.is-context').first()).toBeVisible();
    const visibleResults = page.locator('#search-body .search-result');
    await input.press('ArrowDown');
    await expect(visibleResults.nth(1)).toHaveClass(/\bactive\b/);
    await input.press('ArrowUp');
    await expect(visibleResults.nth(0)).toHaveClass(/\bactive\b/);

    const tabs = [
      ['chat', 'is-chat'],
      ['agent', 'is-agent'],
      ['skill', 'is-skill'],
      ['context', 'is-context'],
    ] as const;
    for (const [tab, resultClass] of tabs) {
      await page.locator(`.search-tab[data-tab="${tab}"]`).click();
      await expect(page.locator(`.search-result-kind.${resultClass}`).first()).toBeVisible();
      await expect(page.locator(`.search-result-kind:not(.${resultClass})`)).toHaveCount(0);
    }

    await page.locator('.search-tab[data-tab="chat"]').click();
    await input.press('Enter');
    await expect(overlay).toBeHidden();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history .chat-message.user')).toContainText(query);

    ({ overlay, input } = await openSearch());
    await input.fill('zzqxvbnm741963');
    await expect(page.locator('#search-body .search-empty')).toBeVisible();
    await expect(page.locator('#search-body .search-result')).toHaveCount(0);
    await input.press('Escape');
    await expect(overlay).toBeHidden();
  });

  test('scopes Library body search across global and project sources and opens the owning file', async ({ orkas }) => {
    test.setTimeout(90_000);
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const projectName = 'E2E Searchable Project';
    const otherProjectName = 'E2E Other Searchable Project';
    const fileName = 'opaque-project-source.md';
    const otherFileName = 'opaque-other-project-source.md';
    const globalFileName = 'opaque-global-source.md';
    const marker = 'cross-scope-body-orbit-741';
    const created = await orkas.invoke<{
      ok: boolean;
      project: { project_id: string };
    }>('projects.create', { name: projectName });
    const other = await orkas.invoke<{
      ok: boolean;
      project: { project_id: string };
    }>('projects.create', { name: otherProjectName });
    expect(created.ok).toBe(true);
    expect(other.ok).toBe(true);
    for (const [projectId, name, heading] of [
      [created.project.project_id, fileName, 'Primary project evidence'],
      [other.project.project_id, otherFileName, 'Other project evidence'],
    ]) {
      await orkas.invoke('projects.files.createText', { projectId, name });
      await orkas.invoke('projects.files.updateText', {
        projectId,
        name,
        content: `# ${heading}\n\nThe shared body-only marker is ${marker}.`,
      });
    }
    await orkas.invoke('contexts.write', {
      path: globalFileName,
      content: `# Global evidence\n\nThe shared body-only marker is ${marker}.`,
    });

    await expect.poll(async () => {
      const primaryStatus = await orkas.invoke<{
        files: Array<{ name: string; status: string }>;
      }>('projects.files.status', {
        projectId: created.project.project_id,
        skipReconcile: true,
      });
      const otherStatus = await orkas.invoke<{
        files: Array<{ name: string; status: string }>;
      }>('projects.files.status', {
        projectId: other.project.project_id,
        skipReconcile: true,
      });
      const globalStatus = await orkas.invoke<{
        files: Array<{ path: string; status: string }>;
      }>('kb.status');
      return {
        primary: primaryStatus.files.find((file) => file.name === fileName)?.status,
        other: otherStatus.files.find((file) => file.name === otherFileName)?.status,
        global: globalStatus.files.find((file) => file.path === globalFileName)?.status,
      };
    }, {
      message: 'all global and project Library fixtures should finish vector indexing',
      timeout: 40_000,
    }).toEqual({
      primary: 'ready',
      other: 'ready',
      global: 'ready',
    });

    const searchShortcut = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
    await page.keyboard.press(searchShortcut);
    const overlay = page.locator('#search-overlay');
    const input = page.locator('#search-input');
    await expect(overlay).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill(marker);

    const allResults = page.locator('#search-body .search-result', { hasText: marker });
    await expect(allResults).toHaveCount(3, { timeout: 20_000 });
    await expect(allResults.locator('.search-result-project')).toHaveCount(2);
    await expect(allResults.locator('.search-result-project', { hasText: projectName })).toHaveCount(1);
    await expect(allResults.locator('.search-result-project', { hasText: otherProjectName })).toHaveCount(1);
    const primaryResult = allResults.filter({
      has: page.locator('.search-result-project', { hasText: projectName }),
    });
    await primaryResult.click();

    await expect(overlay).toBeHidden();
    await expect(page.locator('#panel-project')).toHaveClass(/\bactive\b/);
    await expect(page.locator('.chat-file-viewer')).toBeVisible();
    await expect(page.locator('.chat-file-viewer')).toContainText(marker);

    await page.keyboard.press(searchShortcut);
    await expect(overlay).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('');
    await input.fill(marker);

    const scopedResults = page.locator('#search-body .search-result', { hasText: marker });
    await expect(scopedResults).toHaveCount(2, { timeout: 20_000 });
    await expect(scopedResults.locator('.search-result-project', { hasText: projectName })).toHaveCount(1);
    await expect(scopedResults.locator('.search-result-project', { hasText: otherProjectName })).toHaveCount(0);
    await expect(scopedResults.locator('.search-result-project')).toHaveCount(1);
  });

  test('uploads, previews, renames, persists, and deletes a Library file', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const originalName = 'E2E Library 中文.md';
    const renamedName = 'E2E Library renamed.md';
    const source = orkas.createFixtureFile(originalName, '# Library E2E\n\nUnique library preview body.\n');
    await orkas.selectFilesOnNextDialog([source]);

    await page.locator('#contexts-btn').click();
    await expect(page.locator('#panel-contexts')).toHaveClass(/\bactive\b/);
    await page.locator('#ctx-root-menu-btn').click();
    await page.locator('#ctx-row-menu .ctx-row-menu-item[data-action="upload"]').click();

    let row = page.locator(`.ctx-tree-wrap[data-path="${originalName}"]`);
    await expect(row).toBeVisible();
    await row.locator(':scope > .skill-tree-node').click();
    await expect(page.locator('#contexts-viewer-wrap')).toBeVisible();
    await expect(page.locator('#contexts-editor-path')).toHaveText(originalName);
    await expect(page.locator('#contexts-viewer-body')).toContainText('Unique library preview body.');

    await row.hover();
    await row.locator('[data-menu]').click();
    await page.locator('#ctx-row-menu .ctx-row-menu-item[data-action="rename"]').click();
    const renameInput = page.locator('.ctx-tree-rename-input');
    await expect(renameInput).toBeFocused();
    await renameInput.fill(renamedName);
    await renameInput.press('Enter');
    row = page.locator(`.ctx-tree-wrap[data-path="${renamedName}"]`);
    await expect(row).toBeVisible();

    const relaunchedPage = await orkas.relaunch();
    await relaunchedPage.locator('#contexts-btn').click();
    row = relaunchedPage.locator(`.ctx-tree-wrap[data-path="${renamedName}"]`);
    await expect(row).toBeVisible();
    await row.hover();
    await row.locator('[data-menu]').click();
    await relaunchedPage.locator('#ctx-row-menu .ctx-row-menu-item[data-action="delete"]').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(row).toHaveCount(0);
    await expect(relaunchedPage.locator('#contexts-tree .empty')).toBeVisible();
  });

  test('moves a Library file into a project and persists exactly one destination', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    let page = orkas.page;
    const fileName = 'E2E transfer source.md';
    const projectName = 'E2E Transfer Destination';
    const created = await orkas.invoke<{
      ok: boolean;
      project: { project_id: string };
    }>('projects.create', { name: projectName });
    expect(created.ok).toBe(true);
    await orkas.invoke('contexts.write', {
      path: fileName,
      content: '# Transfer proof\n\nThis file must have one durable owner.',
    });

    await page.locator('#contexts-btn').click();
    let sourceRow = page.locator(`.ctx-tree-wrap[data-path="${fileName}"]`);
    await expect(sourceRow).toBeVisible();
    await sourceRow.hover();
    await sourceRow.locator('[data-menu]').click();
    await page.locator('#ctx-row-menu .ctx-row-menu-item[data-action="organize"]').click();

    const dialog = page.locator('#library-transfer-overlay');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-transfer-library] .ai-select-trigger').click();
    const popover = page.locator('body > .ai-select-popover:not([hidden])');
    await popover.locator('.ai-select-item', { hasText: projectName }).click();
    const confirm = dialog.locator('[data-transfer-confirm]');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(dialog).toHaveCount(0);
    sourceRow = page.locator(`.ctx-tree-wrap[data-path="${fileName}"]`);
    await expect(sourceRow).toHaveCount(0);
    let destination = await orkas.invoke<{
      tree: Array<{ name: string }>;
    }>('projects.files.tree', { projectId: created.project.project_id });
    expect(destination.tree.filter((entry) => entry.name === fileName)).toHaveLength(1);

    page = await orkas.relaunch();
    await page.locator('#contexts-btn').click();
    await expect(page.locator(`.ctx-tree-wrap[data-path="${fileName}"]`)).toHaveCount(0);
    destination = await orkas.invoke<{
      tree: Array<{ name: string }>;
    }>('projects.files.tree', { projectId: created.project.project_id });
    expect(destination.tree.filter((entry) => entry.name === fileName)).toHaveLength(1);
  });

  test('searches a real agent and navigates to its detail page', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const name = 'SearchableE2EAgent';
    const created = await orkas.invoke<{ ok: boolean; agent: { agent_id: string } }>('agents.create', {
      name,
      description: 'Owns the unique nebula-search E2E workflow.',
      category: 'general',
    });
    expect(created.ok).toBe(true);

    await page.locator('#sidebar-search-btn').click();
    const overlay = page.locator('#search-overlay');
    await expect(overlay).toBeVisible();
    const input = page.locator('#search-input');
    await expect(input).toBeFocused();
    await input.fill(name);

    const result = page.locator('.search-result', { hasText: name });
    await expect(result).toBeVisible();
    await page.locator('.search-tab[data-tab="agent"]').click();
    await expect(result).toBeVisible();
    await result.click();

    await expect(overlay).toBeHidden();
    // Opening a resource from search presents its detail as an overlay over the
    // view the search started from, rather than switching the agents panel on.
    // That is what lets the user return to where they were.
    await expect(page.locator('#panel-agents')).toHaveClass(/\bresource-detail-overlay\b/);
    await expect(page.locator('#agents-detail-name')).toHaveText(name);
  });
});
