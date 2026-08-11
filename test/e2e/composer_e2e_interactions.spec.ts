import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/orkas';

test.describe('persistent sidebar', () => {
  test('keeps the commercial external-agent entry above Settings and opens its flow', async ({ appPage }) => {
    const entry = appPage.locator('.sidebar-footer-actions #new-chat-external-agent-btn');
    const settings = appPage.locator('.sidebar-footer-actions #settings-btn');
    await expect(entry).toContainText('Connect agents');
    await expect(entry).toContainText('Claude Code · Codex & more');
    await expect(appPage.locator('#panel-new-chat #new-chat-external-agent-btn')).toHaveCount(0);

    const [entryBox, settingsBox] = await Promise.all([entry.boundingBox(), settings.boundingBox()]);
    expect(entryBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    expect(entryBox!.y + entryBox!.height).toBeLessThanOrEqual(settingsBox!.y);

    await entry.click();
    await expect(appPage.locator('#agent-modal')).toHaveClass(/\bopen\b/);
    await expect(appPage.locator('#agent-modal-tabs')).toBeHidden();
    await expect(appPage.locator('#agent-modal [data-agent-panel="external"]')).toHaveClass(/\bis-active\b/);

    await appPage.locator('#agent-modal .modal-actions .btn').first().click();
    await expect(appPage.locator('#agent-modal')).not.toHaveClass(/\bopen\b/);
  });
});

test.describe('new chat composer', () => {
  test('keeps CLI separate and shares BYO model priority selection across composers', async ({ appPage, orkas }) => {
    await expect(appPage.locator('.new-chat-model-choices')).toHaveCount(0);

    const modelChips = appPage.locator('[data-composer-model-chip]');
    await expect(modelChips).toHaveCount(6);
    expect((await modelChips.evaluateAll((chips) => (
      chips.map((chip) => (chip as HTMLElement).dataset.composerModelChip)
    ))).sort()).toEqual(['agent-edit', 'auto', 'conversation', 'new-chat', 'project', 'skill-edit']);
    const mainComposerOrder = [
      { target: 'new-chat', recipient: '#new-chat-recipient-chip' },
      { target: 'conversation', recipient: '#chat-recipient-chip' },
      { target: 'project', recipient: '#project-chat-recipient-chip' },
      { target: 'auto', recipient: '#auto-recipient-chip' },
    ];
    for (const { target, recipient } of mainComposerOrder) {
      expect(await appPage.locator(recipient).evaluate((element) => (
        (element.previousElementSibling as HTMLElement | null)?.dataset.composerModelChip
      ))).toBe(target);
    }
    for (const target of ['skill-edit', 'agent-edit']) {
      expect(await appPage.locator(`[data-composer-model-chip="${target}"]`).evaluate((element) => (
        element.nextElementSibling?.tagName
      ))).toBe('TEXTAREA');
    }
    await expect(appPage.locator(
      '#panel-new-chat .chat-bottom-bar [data-composer-model-chip="new-chat"]',
    )).toBeVisible();
    await expect(modelChips.locator('.composer-model-chip-icon')).toHaveCount(0);
    await expect(modelChips.locator('.composer-model-chip-prefix')).toHaveCount(0);

    const initialEntries = await orkas.invoke<{
      ok: boolean;
      entries: Array<{ entryId: string }>;
    }>('auth.listEntries');
    for (const entry of initialEntries.entries) {
      const removed = await orkas.invoke<{ ok: boolean }>('auth.removeEntry', {
        entryId: entry.entryId,
      });
      expect(removed.ok).toBe(true);
    }
    await appPage.evaluate(() => {
      window.dispatchEvent(new CustomEvent('orkas:model-entries-changed', {
        detail: { entries: [] },
      }));
    });

    const newChatModelChip = appPage.locator('[data-composer-model-chip="new-chat"]');
    await expect(newChatModelChip.locator('.composer-model-chip-name')).toHaveText('Configure models');
    await newChatModelChip.click();
    await expect(appPage.locator('#composer-model-menu')).toHaveAttribute('data-placement', 'bottom');
    await expect(appPage.locator('.composer-model-menu-item')).toHaveCount(0);
    await expect(appPage.locator('.composer-model-menu-empty')).toBeVisible();
    await expect(appPage.locator('.composer-model-menu-configure')).toHaveText('Configure models');
    await appPage.keyboard.press('Escape');

    const versionedProfile = await orkas.invoke<{ ok: boolean; profileId: string }>('auth.addApiKey', {
      provider: 'openai',
      apiKey: 'sk-composer-version-picker-test',
      label: 'Composer version choice',
    });
    expect(versionedProfile.ok).toBe(true);
    const versionedEntry = await orkas.invoke<{ ok: boolean; entryId: string }>('auth.addEntry', {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      profileId: versionedProfile.profileId,
    });
    expect(versionedEntry.ok).toBe(true);
    const customEntry = await orkas.invoke<{ ok: boolean; entryId: string }>('auth.addCustomModelEntry', {
      label: 'Composer model choice',
      baseUrl: 'https://model-choice.example/v1',
      model: 'custom-composer-model',
      apiKey: 'sk-composer-choice-test',
    });
    expect(customEntry.ok).toBe(true);

    const entriesBefore = await orkas.invoke<{
      ok: boolean;
      entries: Array<{
        entryId: string;
        provider: string;
        model: string;
        profileLabel: string;
        providerLabel: string;
        modelName: string;
      }>;
    }>('auth.listEntries');
    expect(entriesBefore.entries.map((entry) => entry.provider)).toEqual(['custom', 'openai']);
    const entryOrderBefore = entriesBefore.entries.map((entry) => entry.entryId);
    await appPage.evaluate((entries) => {
      window.dispatchEvent(new CustomEvent('orkas:model-entries-changed', {
        detail: { entries },
      }));
    }, entriesBefore.entries);

    const activeModelName = entriesBefore.entries[0]!.modelName;
    for (const chip of await modelChips.all()) {
      await expect(chip.locator('.composer-model-chip-name')).toHaveText(activeModelName);
    }

    await newChatModelChip.click();
    const modelGroup = appPage.locator('.composer-model-menu-group');
    await expect(modelGroup).toHaveCount(1);
    await expect(modelGroup).toHaveAttribute('data-model-group', 'custom');
    await expect(modelGroup.locator('.composer-model-menu-group-label'))
      .toHaveText('Custom models');
    await expect(modelGroup.locator('.composer-model-menu-item'))
      .toHaveCount(entriesBefore.entries.length);

    const customRow = appPage.locator(
      `.composer-model-menu-item[data-entry-id="${customEntry.entryId}"]`,
    );
    await expect(customRow.locator('.composer-model-menu-title')).toContainText('Custom');
    await expect(customRow.locator('.composer-model-menu-meta')).toContainText('Composer-model-choice');
    await expect(customRow.locator('.composer-model-menu-current-model'))
      .toHaveText('custom-composer-model');
    await expect(customRow.locator('.composer-model-menu-disclosure')).toHaveCount(0);

    const versionedRow = appPage.locator(
      `.composer-model-menu-item[data-entry-id="${versionedEntry.entryId}"]`,
    );
    const versionedEntryRow = entriesBefore.entries.find(
      (entry) => entry.entryId === versionedEntry.entryId,
    );
    expect(versionedEntryRow).toBeTruthy();
    await expect(versionedRow.locator('.composer-model-menu-title'))
      .toHaveText(versionedEntryRow!.providerLabel);
    await expect(versionedRow.locator('.composer-model-menu-meta'))
      .toContainText(versionedEntryRow!.profileLabel);
    await expect(versionedRow.locator('.composer-model-menu-current-model'))
      .toHaveText(versionedEntryRow!.modelName);
    await expect(versionedRow.locator('.composer-model-menu-disclosure'))
      .toHaveAttribute('aria-haspopup', 'menu');
    const parentMenu = appPage.locator('#composer-model-menu');
    const parentHeightBefore = await parentMenu.evaluate((element) => element.getBoundingClientRect().height);
    const versionList = appPage.locator(
      `.composer-model-menu-version-list[data-entry-id="${versionedEntry.entryId}"]`,
    );
    await expect(versionList).toHaveCount(0);
    await versionedRow.locator('.composer-model-menu-disclosure').click();
    await expect(versionList).toBeVisible();
    await expect(versionList).toHaveAttribute('data-placement', /^(left|right)$/);
    expect(await versionList.evaluate((element) => element.parentElement === document.body)).toBe(true);
    const parentHeightAfter = await parentMenu.evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(parentHeightAfter - parentHeightBefore)).toBeLessThan(1);
    await expect(versionList.locator('.composer-model-menu-version-item')).toHaveCount(5);
    await expect(versionList.locator('.composer-model-menu-version-label'))
      .toHaveText(['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-5.5', 'GPT-5.4']);
    await expect(versionList.locator('.composer-model-menu-version-current-dot')).toHaveCount(1);
    await expect(versionList.locator('.composer-model-menu-version-check')).toHaveCount(0);
    await versionList.locator(
      '.composer-model-menu-version-item[data-model="gpt-5.6-luna"]',
    ).click();
    await expect(versionList).toBeVisible();
    await expect(versionList.locator(
      '.composer-model-menu-version-item[data-model="gpt-5.6-luna"] .composer-model-menu-version-current-dot',
    )).toBeVisible();
    await expect(versionedRow.locator('.composer-model-menu-current-model')).toHaveText('GPT-5.6 Luna');

    const versionSwitched = await orkas.invoke<{
      ok: boolean;
      entries: Array<{ entryId: string; model: string; modelName: string }>;
    }>('auth.listEntries');
    expect(versionSwitched.entries.map((entry) => entry.entryId)).toEqual(entryOrderBefore);
    expect(versionSwitched.entries.find((entry) => entry.entryId === versionedEntry.entryId))
      .toMatchObject({
        entryId: versionedEntry.entryId,
        model: 'gpt-5.6-luna',
        modelName: 'GPT-5.6 Luna',
      });
    for (const chip of await modelChips.all()) {
      await expect(chip.locator('.composer-model-chip-name')).toHaveText(activeModelName);
    }

    await versionedRow.locator('.composer-model-menu-select').click();

    const selected = await orkas.invoke<{
      ok: boolean;
      entries: Array<{ entryId: string; model: string; modelName: string }>;
    }>('auth.listEntries');
    expect(selected.entries[0]).toMatchObject({
      entryId: versionedEntry.entryId,
      model: 'gpt-5.6-luna',
      modelName: 'GPT-5.6 Luna',
    });
    for (const chip of await modelChips.all()) {
      await expect(chip.locator('.composer-model-chip-name')).toHaveText('GPT-5.6 Luna');
    }
    const recipientNameColor = await appPage.locator('#new-chat-recipient-name')
      .evaluate((element) => getComputedStyle(element).color);
    await expect(newChatModelChip.locator('.composer-model-chip-name'))
      .toHaveCSS('color', recipientNameColor);
    await expect(appPage.locator('#panel-new-chat .workspace-chip-label'))
      .toHaveCSS('color', recipientNameColor);

    await newChatModelChip.click();
    await appPage.locator('.composer-model-menu-configure').click();
    await expect(appPage.locator('#panel-settings')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('.settings-tab[data-settings-tab="credentials"]')).toHaveClass(/\bis-active\b/);
    await expect(appPage.locator('.settings-tab-pane[data-settings-pane="credentials"]')).toBeVisible();
  });

  test('disables model selection while an external Agent is the recipient', async ({
    appPage,
    orkas,
  }) => {
    const created = await orkas.invoke<{
      agent: { agent_id: string; name: string };
    }>('agents.create', {
      name: 'ComposerCli',
      description: 'External Agent model-picker regression fixture',
      runtime: { kind: 'cli', cli: 'codex' },
    });
    expect(created.agent?.agent_id).toBeTruthy();

    await appPage.evaluate(async () => {
      await (window as any).loadRendererFeature('agents');
      await (window as any).loadAgents(true, { summary: true });
    });

    const modelChip = appPage.locator('[data-composer-model-chip="new-chat"]');
    await expect(modelChip).toBeEnabled();

    await appPage.locator('#new-chat-recipient-chip').click();
    await appPage.locator(
      `.skill-picker-item[data-kind="agent"][data-id="${created.agent.agent_id}"]`,
    ).click();
    await expect(appPage.locator('#new-chat-recipient-name')).toHaveText('ComposerCli');
    await expect(modelChip).toBeDisabled();
    await modelChip.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(appPage.locator('#composer-model-menu')).toHaveCount(0);

    await appPage.locator('#new-chat-recipient-chip').click();
    await appPage.locator(
      '.skill-picker-item[data-kind="agent"][data-id="__commander__"]',
    ).click();
    await expect(modelChip).toBeEnabled();
    await modelChip.click();
    await expect(appPage.locator('#composer-model-menu')).toBeVisible();
    await appPage.keyboard.press('Escape');
  });

  test('wires every home quick start to its localized prompt and configured owner', async ({
    appPage,
    orkas,
  }) => {
    const cases = [
      {
        id: 'data',
        agentId: '78900d8758bc',
        agentName: 'DeepResearcher',
        prompt: 'Research AI desktop apps for everyday users, compare their main use cases, platform support, ease of setup, model capabilities, privacy, local operation, and pricing, then recommend options for different needs.',
      },
      {
        id: 'office',
        agentId: 'a19101ba698a',
        agentName: 'OfficeWorker',
        prompt: 'Create an editable ecommerce sales report using sample data, with core metrics, trend charts, and channel charts.',
      },
      {
        id: 'ppt',
        agentId: '7e91cb9ec9e9',
        agentName: 'PptMaker',
        prompt: 'Create an editable 8-slide product presentation for an AI office assistant, aimed at business buyers, covering pain points, the solution, core capabilities, use cases, value, and next steps.',
      },
      {
        id: 'creation',
        agentId: '173d4235a431',
        agentName: 'ContentWriter',
        prompt: 'Write a social post for workplace users about an AI office assistant.',
      },
      {
        id: 'image',
        agentId: '814b61b027f0',
        agentName: 'ImageStudio',
        prompt: 'Design a City Summer Coffee Festival poster for August 16, 2:00–8:00 PM, at Central Plaza, featuring pour-over tastings, a coffee market, and seasonal drinks.',
      },
      {
        id: 'video',
        agentId: '79df9cc89f5f',
        agentName: 'VideoStudio',
        prompt: 'Create a roughly 45-second AI trends explainer video for a general audience.',
      },
      {
        id: 'ui_design',
        agentId: 'bcfcb4921dce',
        agentName: 'UIDesigner',
        prompt: 'Design responsive sign-in, sign-up, and password-recovery UI for a personal finance app, including validation, loading, success, and failure states.',
      },
      {
        id: 'rnd',
        agentId: 'a316881746f9',
        // ProductDeveloper ships with the source bundle (007887ce7), so the
        // offline E2E workspace resolves the real owner rather than the
        // Commander fallback this case asserted while it was Server-installed.
        agentName: 'ProductDeveloper',
        prompt: 'Build a responsive portfolio website for a product designer changing careers, using editable sample projects, experience, contact details, and a downloadable sample resume.',
      },
      {
        id: 'seo_geo',
        agentId: 'e064dca9e1bd',
        agentName: 'SeoGeoAgent',
        prompt: 'Create an SEO and GEO plan for orkas.ai covering keywords, core pages, content, and priorities.',
      },
    ] as const;
    const sourceBundledAgentIds = new Set<string>(cases.map((item) => item.agentId));

    await expect.poll(
      async () => {
        const result = await orkas.invoke<{ agents: Array<{ agent_id: string }> }>('agents.list');
        return result.agents.filter((agent) => sourceBundledAgentIds.has(agent.agent_id)).length;
      },
      { message: 'wait for source-bundled quick-start owners', timeout: 30_000 },
    ).toBe(sourceBundledAgentIds.size);

    const bundledPptMaker = await orkas.invoke<{
      agent: {
        agent_id: string;
        name: string;
        version?: string;
        category: string;
        interactive?: boolean;
        skill_list?: string[];
        seed_source?: string;
      };
    }>('agents.get', { agent_id: '7e91cb9ec9e9' });
    expect(bundledPptMaker.agent).toMatchObject({
      agent_id: '7e91cb9ec9e9',
      name: 'PptMaker',
      category: 'office',
      interactive: false,
      seed_source: 'builtin',
      skill_list: [
        'ppt-router',
        'ppt-planner',
        'ppt-craft',
        'ppt-review',
        'f283632103ba',
      ],
    });
    expect(bundledPptMaker.agent.version).toMatch(/^\d+\.\d+\.\d+$/);

    // The OSS entry has its own header navigation contract below; this table
    // covers the nine prompt/owner scenario cards.
    const cards = appPage.locator('.new-chat-scenario-chip:not(#oss-quick-task-card)');
    await expect(cards).toHaveCount(cases.length);
    const renderedIds = await cards.evaluateAll((elements) => (
      elements.map((element) => (element as HTMLElement).dataset.scenario)
    ));
    expect(renderedIds).toEqual(cases.map((item) => item.id));
    const renderedGroups = await cards.evaluateAll((elements) => (
      elements.map((element) => (element as HTMLElement).dataset.group)
    ));
    expect(renderedGroups).toEqual([
      'knowledge-office', 'knowledge-office', 'knowledge-office',
      'content-creation', 'content-creation', 'content-creation',
      'product-growth', 'product-growth', 'product-growth',
    ]);
    const pptCard = appPage.locator('.new-chat-scenario-chip[data-scenario="ppt"]');
    await expect(pptCard.locator('.quick-cat-name')).toHaveText('Presentation');
    await expect(pptCard.locator('.quick-task')).toHaveText(
      'Create an AI office assistant product deck',
    );
    await expect(pptCard.locator('.quick-deliver')).toHaveText('Deliverable: PPT');
    await expect(pptCard.locator('.quick-thumb')).toHaveAttribute('data-thumb', 'presentation');

    const input = appPage.locator('#new-chat-input');
    for (const item of cases) {
      await appPage.locator(`.new-chat-scenario-chip[data-scenario="${item.id}"]`).click();
      await expect(input, item.id).toHaveValue(item.prompt);
      await expect(appPage.locator('#new-chat-recipient-name'), item.id).toHaveText(item.agentName);
      await expect.poll(
        () => input.evaluate((element) => ({
          agentId: (element as HTMLTextAreaElement).dataset.commanderAgentId,
          entryPoint: (element as HTMLTextAreaElement).dataset.commanderEntryPoint,
          resourceId: (element as HTMLTextAreaElement).dataset.commanderResourceId,
        })),
        { message: `${item.id} quick-start attribution` },
      ).toEqual({
        agentId: item.agentId,
        entryPoint: 'quick_start',
        resourceId: item.id,
      });
    }
  });

  test('keeps the wider landing scale and puts the OSS entry on the quick-start header', async ({ appPage }) => {
    await expect(appPage.locator('#new-chat-scenarios')).toBeVisible();
    await expect(appPage.locator('#quick-panel-oss-more')).toBeVisible();

    const layout = await appPage.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const header = rect('.new-chat-header');
      const composer = rect('.new-chat-input-area');
      const quickPanel = rect('#new-chat-scenarios');
      const quickCard = rect('.new-chat-scenario-chip');
      const landing = rect('.new-chat-center');
      const landingChildren = [
        '.new-chat-header',
        '.new-chat-input-wrapper',
        '#new-chat-scenarios',
      ];

      return {
        widths: [header.width, composer.width, quickPanel.width],
        greetingFontSize: getComputedStyle(document.querySelector('.new-chat-greeting')!).fontSize,
        greetingTextAlign: getComputedStyle(document.querySelector('.new-chat-header')!).textAlign,
        composerHeight: composer.height,
        quickCardHeight: quickCard.height,
        quickCardCount: document.querySelectorAll('.new-chat-scenario-chip').length,
        quickGridColumns: getComputedStyle(document.querySelector('.quick-grid')!).gridTemplateColumns
          .split(' ').length,
        quickThumbsFit: Array.from(document.querySelectorAll('.quick-thumb'))
          .every((element) => {
            const thumb = element.getBoundingClientRect();
            const card = element.closest('.new-chat-scenario-chip')!.getBoundingClientRect();
            return thumb.left >= card.left && thumb.right <= card.right
              && thumb.top >= card.top && thumb.bottom <= card.bottom;
          }),
        // The entry belongs to the header row, not to the grid of runnable tasks.
        ossEntryOnHeaderRow: (() => {
          const link = document.querySelector('#quick-panel-oss-more');
          const title = rect('#quick-panel-title');
          const grid = rect('.quick-grid');
          if (!link || link.closest('.quick-grid')) return false;
          const box = link.getBoundingClientRect();
          return box.left > title.right && box.bottom <= grid.top + 0.5;
        })(),
        landingStartsInBounds: header.top >= landing.top,
        flexShrink: landingChildren.map((selector) => getComputedStyle(document.querySelector(selector)!).flexShrink),
      };
    });

    expect(Math.min(...layout.widths)).toBeGreaterThanOrEqual(895);
    expect(Math.max(...layout.widths)).toBeLessThanOrEqual(902);
    expect(layout.greetingFontSize).toBe('32px');
    expect(layout.greetingTextAlign).toBe('center');
    expect(layout.composerHeight).toBeLessThanOrEqual(150);
    expect(layout.quickCardHeight).toBeGreaterThanOrEqual(112);
    expect(layout.quickCardCount).toBe(9);
    expect(layout.quickGridColumns).toBe(3);
    expect(layout.quickThumbsFit).toBe(true);
    expect(layout.ossEntryOnHeaderRow).toBe(true);
    expect(layout.landingStartsInBounds).toBe(true);
    expect(layout.flexShrink).toEqual(['0', '0', '0']);

    await appPage.setViewportSize({ width: 1280, height: 600 });
    const shortViewport = await appPage.evaluate(() => {
      const landing = document.querySelector('.new-chat-center')!;
      const header = document.querySelector('.new-chat-header')!;
      const landingRect = landing.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const overflows = landing.scrollHeight > landing.clientHeight;
      const startsInBounds = headerRect.top >= landingRect.top;
      landing.scrollTop = landing.scrollHeight;
      const quickPanelRect = document.querySelector('#new-chat-scenarios')!.getBoundingClientRect();
      return {
        overflows,
        startsInBounds,
        endIsReachable: quickPanelRect.bottom <= landingRect.bottom + 0.5,
      };
    });
    expect(shortViewport).toEqual({ overflows: true, startsInBounds: true, endIsReachable: true });
  });

  test('prefills a quick scenario and keeps modified Enter as a newline', async ({ appPage }) => {
    const input = appPage.locator('#new-chat-input');
    await appPage.locator('.new-chat-scenario-chip[data-scenario="data"]').click();
    await expect(input).not.toHaveValue('');
    const selectedSubject = await input.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return field.value.slice(field.selectionStart, field.selectionEnd);
    });
    expect(selectedSubject).toBe('AI desktop apps');

    await input.fill('first line');
    await input.press('Shift+Enter');
    await input.type('second line');

    await expect(input).toHaveValue('first line\nsecond line');
    await expect(appPage.locator('#panel-new-chat')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('.ui-dialog-overlay:visible')).toHaveCount(0);
  });

  test('uploads and removes an attachment through the native picker IPC', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const fileName = 'E2E brief 中文.md';
    const sourcePath = orkas.createFixtureFile(fileName, '# E2E brief\n\nDeterministic attachment.\n');
    await orkas.cancelNextFileDialog();
    await orkas.page.locator('#new-chat-attach-btn').click();
    await expect(orkas.page.locator('#new-chat-attachments')).toBeHidden();

    await orkas.selectFilesOnNextDialog([sourcePath]);

    await orkas.page.locator('#new-chat-attach-btn').click();
    const host = orkas.page.locator('#new-chat-attachments');
    const chip = host.locator('.chat-attach-chip', { hasText: fileName });
    await expect(chip).toBeVisible();
    await expect(chip).not.toHaveClass(/\bis-uploading\b/);
    await expect(chip.locator('.chat-attach-label')).toHaveText(fileName);
    await expect.poll(async () => {
      return orkas.page?.evaluate(async () => {
        const result = await (window as any).orkas.invoke('conversations.attachments.list', {
          cid: 'main_chat',
        });
        return result.items.map((item: { name: string }) => item.name);
      });
    }).toEqual([fileName]);

    await chip.locator('.chat-attach-preview').click();
    await expect(orkas.page.locator('.chat-file-viewer')).toHaveClass(/\bis-open\b/);
    await expect(orkas.page.locator('.chat-file-viewer-title')).toHaveText(fileName);
    await expect(orkas.page.locator('.chat-file-viewer-body')).toContainText('Deterministic attachment.');
    await orkas.page.locator('.chat-file-viewer-close').click();

    await chip.locator('.chat-attach-remove').click();
    await expect(chip).toHaveCount(0);
    await expect(host).toBeHidden();
    await expect.poll(async () => {
      return orkas.page?.evaluate(async () => {
        const result = await (window as any).orkas.invoke('conversations.attachments.list', {
          cid: 'main_chat',
        });
        return result.items.length;
      });
    }).toBe(0);
  });

  test('rejects an oversized attachment without leaving a draft chip', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const oversized = orkas.createFixtureFile(
      'E2E oversized.txt',
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
    );
    await orkas.selectFilesOnNextDialog([oversized]);
    await orkas.page.locator('#new-chat-attach-btn').click();

    const alert = orkas.page.locator('.ui-dialog-overlay:visible .ui-dialog');
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('errors.file_too_large_mb');
    await alert.locator('[data-act="ok"]').click();
    await expect(orkas.page.locator('#new-chat-attachments .chat-attach-chip')).toHaveCount(0);
    const pending = await orkas.invoke<{ items: unknown[] }>('conversations.attachments.list', {
      cid: 'main_chat',
    });
    expect(pending.items).toHaveLength(0);
  });

  test('caps one pending message at twenty distinct attachments', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const paths = Array.from({ length: 21 }, (_, index) => orkas.createFixtureFile(
      `E2E capped attachment ${String(index + 1).padStart(2, '0')}.txt`,
      `attachment-${index + 1}`,
    ));
    await orkas.selectFilesOnNextDialog(paths);
    await orkas.page.locator('#new-chat-attach-btn').click();

    const alert = orkas.page.locator('.ui-dialog-overlay:visible .ui-dialog');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('21');
    await expect(alert).toContainText('20');
    await alert.locator('[data-act="ok"]').click();
    await expect(orkas.page.locator('#new-chat-attachments .chat-attach-chip')).toHaveCount(20);

    const pending = await orkas.invoke<{ items: Array<{ name: string }> }>(
      'conversations.attachments.list',
      { cid: 'main_chat' },
    );
    expect(pending.items).toHaveLength(20);
    expect(pending.items.some((item) => item.name.includes('21'))).toBe(false);
  });

  test('partially accepts a mixed valid, oversized, and unsupported attachment batch', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const valid = orkas.createFixtureFile('E2E mixed valid.md', '# accepted\n');
    const oversized = orkas.createFixtureFile(
      'E2E mixed oversized.txt',
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
    );
    const unsupported = orkas.createFixtureFile('E2E mixed rejected.exe', Buffer.from('not executable'));
    await orkas.selectFilesOnNextDialog([valid, oversized, unsupported]);
    await orkas.page.locator('#new-chat-attach-btn').click();

    const alert = orkas.page.locator('.ui-dialog-overlay:visible .ui-dialog');
    await expect(alert).toContainText('E2E mixed oversized.txt');
    await expect(alert).toContainText('E2E mixed rejected.exe');
    await alert.locator('[data-act="ok"]').click();
    const chips = orkas.page.locator('#new-chat-attachments .chat-attach-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips).toContainText('E2E mixed valid.md');

    const pending = await orkas.invoke<{ items: Array<{ name: string }> }>(
      'conversations.attachments.list',
      { cid: 'main_chat' },
    );
    expect(pending.items.map((item) => item.name)).toEqual(['E2E mixed valid.md']);
  });

  test('preserves three different files that share one display name', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const displayName = 'E2E same name.txt';
    const paths = [
      orkas.createWorkspaceFile(`same-name/first/${displayName}`, 'first body'),
      orkas.createWorkspaceFile(`same-name/second/${displayName}`, 'second body'),
      orkas.createWorkspaceFile(`same-name/third/${displayName}`, 'third body'),
    ];
    await orkas.selectFilesOnNextDialog(paths);
    await orkas.page.locator('#new-chat-attach-btn').click();

    const labels = orkas.page.locator('#new-chat-attachments .chat-attach-label');
    await expect(labels).toHaveCount(3);
    expect(await labels.allTextContents()).toEqual([displayName, displayName, displayName]);

    const pending = await orkas.invoke<{ items: Array<{ name: string }> }>(
      'conversations.attachments.list',
      { cid: 'main_chat' },
    );
    expect(pending.items).toHaveLength(3);
    expect(new Set(pending.items.map((item) => item.name)).size).toBe(3);
    const storedDir = path.join(
      orkas.workspaceRoot,
      'account-e2e',
      'local',
      'chat_attachment_drafts',
      'main_chat',
    );
    const storedBodies = readdirSync(storedDir)
      .filter((name) => !name.startsWith('.'))
      .map((name) => readFileSync(path.join(storedDir, name), 'utf8'))
      .sort();
    expect(storedBodies).toEqual(['first body', 'second body', 'third body']);
  });

  test('sends multiple attachments to the model and restores them with conversation history', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    const firstName = 'E2E multi brief.md';
    const secondName = 'E2E facts.json';
    const firstPath = modelOrkas.createFixtureFile(firstName, '# Multi attachment\n\nFirst body.\n');
    const secondPath = modelOrkas.createFixtureFile(secondName, '{"e2e":true,"kind":"second"}\n');
    await modelOrkas.selectFilesOnNextDialog([firstPath, secondPath]);

    await page.locator('#new-chat-attach-btn').click();
    await expect(page.locator('#new-chat-attachments .chat-attach-chip')).toHaveCount(2);
    await page.locator('#new-chat-input').fill('Use both deterministic E2E attachments.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      'Hello from the local E2E model.',
      { timeout: 20_000 },
    );
    const userMessage = page.locator('#chat-history .chat-message.user');
    await expect(userMessage).toContainText(firstName);
    await expect(userMessage).toContainText(secondName);
    await userMessage.locator('.chat-msg-attach', { hasText: firstName }).click();
    await expect(page.locator('.chat-file-viewer')).toHaveClass(/\bis-open\b/);
    await expect(page.locator('.chat-file-viewer-title')).toHaveText(firstName);
    await expect(page.locator('.chat-file-viewer-body')).toContainText('First body.');
    await page.locator('.chat-file-viewer [data-mve-action="edit"]').click();
    const markdownEditor = page.locator('.chat-file-viewer [data-mve-textarea]');
    await expect(markdownEditor).toBeVisible();
    await markdownEditor.fill('# Multi attachment\n\nEdited through the conversation viewer.\n');
    await page.locator('.chat-file-viewer [data-mve-action="save"]').click();
    await expect(markdownEditor).toBeHidden();
    await expect(page.locator('.chat-file-viewer-body')).toContainText(
      'Edited through the conversation viewer.',
    );
    await page.locator('.chat-file-viewer-close').click();
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain(firstName);
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain(secondName);

    const conversationId = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const pending = await modelOrkas.invoke<{ items: unknown[] }>('conversations.attachments.list', {
      cid: conversationId,
    });
    expect(pending.items).toHaveLength(0);

    const relaunchedPage = await modelOrkas.relaunch();
    await relaunchedPage.locator(`.conv-item[data-cid="${conversationId}"]`).click();
    const restoredUserMessage = relaunchedPage.locator('#chat-history .chat-message.user');
    await expect(restoredUserMessage).toContainText(firstName);
    await expect(restoredUserMessage).toContainText(secondName);
    await expect(relaunchedPage.locator('#chat-history .chat-message.assistant')).toContainText(
      'Hello from the local E2E model.',
    );
    await restoredUserMessage.locator('.chat-msg-attach', { hasText: firstName }).click();
    await expect(relaunchedPage.locator('.chat-file-viewer-title')).toHaveText(firstName);
    await expect(relaunchedPage.locator('.chat-file-viewer-body')).toContainText(
      'Edited through the conversation viewer.',
    );
  });
});
