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
  test('groups both public Orkas API-key models as official models', async ({ appPage, orkas }) => {
    const configured = await orkas.invoke<{ ok: boolean; configured: boolean }>(
      'orkasApi.configureAll',
      { apiKey: 'orkas-e2e-public-key-xxxxxxxx' },
    );
    expect(configured).toMatchObject({ ok: true, configured: true });

    const modelChip = appPage.locator('[data-composer-model-chip="new-chat"]');
    await modelChip.click();
    const officialGroup = appPage.locator(
      '.composer-model-menu-group[data-model-group="official"]',
    );
    await expect(officialGroup.locator('.composer-model-menu-group-label'))
      .toHaveText('Official models');
    const officialRows = officialGroup.locator('.composer-model-menu-item');
    await expect(officialRows).toHaveCount(2);
    await expect(officialRows.locator('.composer-model-menu-title-name'))
      .toHaveText(['Orkas-1.5', 'Orkas-1.5 Pro']);
    await expect(officialRows.nth(0).locator('.composer-model-menu-recommended'))
      .toHaveText('Recommended');
    await expect(officialRows.nth(0).locator('.composer-model-menu-description'))
      .toContainText('DeepSeek V4 · GPT-5.6 Luna · Claude-Sonnet-5 · Gemini-3.6 Flash');
    await expect(officialRows.nth(1).locator('.composer-model-menu-description'))
      .toContainText('GPT-5.6 Sol · Claude Opus 5 · Kimi K3');
    const customGroup = appPage.locator(
      '.composer-model-menu-group[data-model-group="custom"]',
    );
    await expect(customGroup.locator('.composer-model-menu-group-label'))
      .toHaveText('User-configured models');
    await appPage.keyboard.press('Escape');

    await appPage.locator('#settings-btn').click();
    await appPage.locator('.settings-tab[data-settings-tab="credentials"]').click();
    const settingsOfficialRows = appPage.locator('#settings-entries .entry-row').filter({
      has: appPage.locator('.entry-provider', { hasText: /^Orkas$/ }),
    });
    await expect(settingsOfficialRows).toHaveCount(2);
    await expect(settingsOfficialRows.locator('.entry-model-static-name'))
      .toHaveText(['Orkas-1.5', 'Orkas-1.5 Pro']);
  });

  test('keeps explicit Commander mentions visible through send and history reload', async ({ modelOrkas }, testInfo) => {
    const page = modelOrkas.page!;
    await modelOrkas.invoke('agents.create', { name: 'DisplayWriter', description: 'Mention display fixture' });
    await page.evaluate(async () => {
      await (window as any).loadRendererFeature('agents');
      await (window as any).loadAgents(true, { summary: true });
    });
    const draft = page.locator('.chat-rich-editor[data-rich-input-id="new-chat-input"]');
    await draft.fill('@指挥官 @DisplayWriter 你好');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    const first = page.locator('#chat-history .chat-message.user .markdown-body').first();
    await expect(first).toHaveText('@Commander @DisplayWriter 你好');
    await expect(first.locator('.msg-mention')).toHaveText(['@Commander', '@DisplayWriter']);

    const cid = await page.evaluate<string>('currentCid');
    const readHistory = async () => (await modelOrkas.invoke<{ history: any[] }>(
      'conversations.history', { cid, limit: 30 },
    )).history;
    await expect.poll(async () => (await readHistory()).filter((row) => row.from !== 'user').length).toBeGreaterThanOrEqual(2);
    const user = (await readHistory()).find((row) => row.from === 'user');
    expect(user.display_text).toBe('@指挥官 @DisplayWriter 你好');
    expect(user.text).toBe('@DisplayWriter 你好');

    // A panel selection writes the English transport alias, which is also authored.
    const editor = page.locator('.chat-rich-editor[data-rich-input-id="chat-input"]');
    await editor.fill('');
    await editor.press('@');
    await page.locator('#agent-picker [data-id="__commander__"]').click();
    await editor.pressSequentially('continue');
    await editor.press('Enter');
    await expect(page.locator('#chat-history .chat-message.user .markdown-body').last()).toHaveText('@Commander continue');
    await expect.poll(async () => (await readHistory()).filter((row) => row.from !== 'user').length).toBeGreaterThanOrEqual(3);
    await page.reload();
    await expect(first).toHaveText('@Commander @DisplayWriter 你好');
    await expect(page.locator('#chat-history .chat-message.user .markdown-body').last()).toHaveText('@Commander continue');
    // Visible names track the UI language, including already-rendered history
    // and a pending draft; the saved authored text and routing stay unchanged.
    await editor.fill('@commander pending');
    for (const language of ['zh', 'ja', 'pt', 'en']) {
      await page.evaluate(async (lang) => { await (window as any).setLang(lang); }, language);
      const name = language === 'zh' ? '指挥官' : 'Commander';
      await expect(first).toHaveText(`@${name} @DisplayWriter 你好`);
      await expect(page.locator('#chat-history .chat-message.user .markdown-body').last()).toHaveText(`@${name} continue`);
      await expect(editor.locator('.chat-use-inline-name')).toHaveText(name);
      await expect(page.locator('#chat-input')).toHaveValue('@commander pending');
    }
    expect((await readHistory()).find((row) => row.from === 'user').display_text)
      .toBe('@指挥官 @DisplayWriter 你好');
    // HTML-looking canonical text must not bypass the authored projection.
    await editor.fill('@commander <span>visible</span> `@commander` @commander-extra [@commander](https://example.com)');
    await editor.press('Enter');
    const last = page.locator('#chat-history .chat-message.user .markdown-body').last();
    await expect(last).toHaveText('@Commander visible @commander @commander-extra @commander');
    await expect(last.locator('code')).toHaveText('@commander');
    await expect(last.locator('a')).toHaveText('@commander');
    await expect(last.locator('.msg-mention')).toHaveText(['@Commander', '@commander-extra']);
    await expect.poll(async () => (await modelOrkas.invoke<{ processing: boolean }>('groupChat.runtimeStatus', { cid })).processing)
      .toBe(false);
    await page.locator('#chat-history').screenshot({ path: testInfo.outputPath('commander-mentions-history.png') });
  });

  test('preserves a project composer mention while hiding its generated Commander prefix', async ({ modelOrkas }) => {
    const page = modelOrkas.page!;
    const { project } = await modelOrkas.invoke<{ project: { project_id: string } }>('projects.create', {
      name: 'Commander mention display',
    });
    await page.evaluate((pid) => (window as any).setView('project', pid), project.project_id);
    const editor = page.locator('.chat-rich-editor[data-rich-input-id="project-chat-input"]');
    await editor.fill('first instruction @指挥官 second instruction');
    await page.locator('#project-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history .chat-message.user .markdown-body').last())
      .toHaveText('first instruction @Commander second instruction');
    const cid = await page.evaluate<string>('currentCid');
    await expect.poll(async () => (await modelOrkas.invoke<{ processing: boolean }>('groupChat.runtimeStatus', { cid })).processing)
      .toBe(false);
  });

  test('keeps CLI separate and shares model priority selection across composers', async ({ appPage, orkas }) => {
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
      .toHaveText('User-configured models');
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
    await expect(versionList.locator('.composer-model-menu-version-item')).toHaveCount(4);
    await expect(versionList.locator('.composer-model-menu-version-label'))
      .toHaveText(['GPT-6 Astra', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna']);
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

  test('keeps model selection visible but disabled for picked and inline external Agent recipients', async ({
    cliOrkas: orkas,
  }, testInfo) => {
    const appPage = orkas.page!;
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
    await expect(modelChip).toBeVisible();

    const picker = appPage.locator('#agent-picker');
    const selected = appPage.locator('#agent-picker-selected');
    const search = appPage.locator('#agent-picker-search');
    const cliRow = appPage.locator(`.skill-picker-item[data-kind="agent"][data-id="${created.agent.agent_id}"]`);
    const commanderRow = appPage.locator('.skill-picker-item[data-kind="agent"][data-id="__commander__"]');
    const editor = appPage.locator('.chat-rich-editor[data-rich-input-id="new-chat-input"]');
    const input = appPage.locator('#new-chat-input');

    await appPage.locator('#new-chat-recipient-chip').click();
    await expect(commanderRow).toHaveAttribute('aria-checked', 'true');
    await expect(selected.getByRole('button', { name: 'Remove: Commander', exact: true })).toBeVisible();
    await expect(commanderRow.locator('.recipient-picker-check')).toHaveCount(1);
    expect(await commanderRow.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none');
    await cliRow.click();
    await expect(picker).toBeVisible();
    await expect(cliRow).toBeFocused();
    await expect(cliRow).toHaveAttribute('aria-checked', 'true');
    await expect(cliRow.locator('.composer-model-menu-check')).toBeVisible();
    await expect(selected.getByRole('button', { name: 'Remove: ComposerCli', exact: true })).toBeVisible();
    await expect(input).toHaveValue('@ComposerCli ');
    await expect(appPage.locator('#new-chat-recipient-name')).toHaveText('ComposerCli');
    await expect(modelChip).toBeDisabled();
    await expect(modelChip).toBeVisible();
    await expect(modelChip).toHaveCSS('opacity', '0.55');
    await modelChip.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(appPage.locator('#composer-model-menu')).toHaveCount(0);

    await commanderRow.press('Space');
    await expect(commanderRow).toHaveAttribute('aria-checked', 'true');
    await expect(cliRow).toHaveAttribute('aria-checked', 'true');
    await expect(input).toHaveValue('@ComposerCli @commander ');
    await expect(modelChip).toBeVisible();
    await expect(modelChip).toBeEnabled();
    await expect(selected.locator('.chat-recipient-name')).toHaveText(['ComposerCli', 'Commander']);
    // The fixed header retains selected Agents even when search hides their rows.
    await search.fill('ComposerCli');
    await expect(commanderRow).toHaveCount(0);
    await picker.screenshot({ path: testInfo.outputPath('selected-agent-header.png') });
    await selected.getByRole('button', { name: 'Remove: Commander', exact: true }).click();
    await expect(picker).toBeVisible();
    await expect(input).toHaveValue('@ComposerCli ');
    await expect(modelChip).toBeVisible();
    await expect(modelChip).toBeDisabled();
    await search.fill('');
    await expect(commanderRow.locator('.recipient-picker-check')).toHaveCount(0);
    await cliRow.press('Enter');
    await expect(picker).toBeHidden();
    await appPage.locator('#panel-new-chat .new-chat-input-wrapper').screenshot({
      path: testInfo.outputPath('cli-recipient.png'),
    });

    // Reopening retains checkmarks; typing a new @ adds to explicit draft choices.
    await appPage.locator('#new-chat-recipient-chip').click();
    await expect(cliRow).toHaveAttribute('aria-checked', 'true');
    await editor.click();
    await editor.press('End');
    await editor.press('@');
    await expect(cliRow).toHaveAttribute('aria-checked', 'true');
    await expect(cliRow.locator('.recipient-picker-check')).toBeVisible();
    await expect(selected.getByRole('button', { name: 'Remove: ComposerCli', exact: true })).toBeVisible();
    await expect(commanderRow).toHaveAttribute('aria-checked', 'false');
    await commanderRow.press('Enter');
    await expect(input).toHaveValue('@ComposerCli @commander ');
    await expect(modelChip).toBeEnabled();
    await expect(modelChip).toBeVisible();
    await expect(appPage.locator('#new-chat-recipient-name')).toHaveText('ComposerCli, Commander');
    // The @ entry keeps the same removable header, including when search
    // hides every result. Removal must not insert a duplicate mention.
    await editor.click();
    await editor.press('End');
    await editor.press('@');
    await expect(selected.locator('.chat-recipient-name')).toHaveText(['ComposerCli', 'Commander']);
    await picker.screenshot({ path: testInfo.outputPath('at-picker-selected-agents.png') });
    await search.fill('no matching Agent');
    await expect(picker.locator('.skill-picker-item')).toHaveCount(0);
    await selected.getByRole('button', { name: 'Remove: ComposerCli', exact: true }).click();
    await expect(input).toHaveValue('@commander ');
    await selected.getByRole('button', { name: 'Remove: Commander', exact: true }).press('Enter');
    await expect(input).toHaveValue('');
    await expect(selected.getByRole('button', { name: 'Remove: Commander', exact: true })).toBeVisible();
    await expect(selected.getByRole('button', { name: 'Remove: Commander', exact: true })).toBeFocused();
    await expect(picker).toBeVisible();
    await expect(appPage.locator('#new-chat-recipient-name')).toHaveText('Commander');
    await search.fill('');
    await expect(cliRow).toHaveAttribute('aria-checked', 'false');
    await expect(commanderRow).toHaveAttribute('aria-checked', 'true');
    expect(orkas.readCliState().invocations).toHaveLength(0);
  });

  test('renders and edits Agent mentions as the same atomic chips as Skills and Connectors', async ({ cliOrkas: orkas }, testInfo) => {
    const appPage = orkas.page!;
    const { agent } = await orkas.invoke<{ agent: { agent_id: string } }>('agents.create', {
      name: 'OrkasCodex', description: 'Inline Agent chip fixture', runtime: { kind: 'cli', cli: 'codex' },
    });
    expect(agent?.agent_id).toBeTruthy();
    await appPage.evaluate(async () => {
      await (window as any).loadRendererFeature('agents');
      await (window as any).loadAgents(true, { summary: true });
    });
    const editor = appPage.locator('.chat-rich-editor[data-rich-input-id="new-chat-input"]');
    const input = appPage.locator('#new-chat-input');
    const agentChip = editor.locator('[data-kind="agent"]');
    const model = appPage.locator('[data-composer-model-chip="new-chat"]');
    const selection = () => appPage.evaluate(() => (window as any).getChatRichComposerSelection('new-chat-input'));
    const setCaret = async (position: number) => {
      await appPage.evaluate((pos) => {
        const input = document.getElementById('new-chat-input') as HTMLTextAreaElement;
        input.focus();
        input.setSelectionRange(pos, pos);
      }, position);
    };

    await appPage.locator('#new-chat-recipient-chip').click();
    await appPage.locator(`.skill-picker-item[data-id="${agent.agent_id}"]`).click();
    await appPage.locator(`.skill-picker-item[data-id="${agent.agent_id}"]`).press('Enter');
    await expect(agentChip).toHaveText('@OrkasCodex');
    await expect(agentChip).toHaveAttribute('contenteditable', 'false');
    await expect(model).toBeVisible();
    await expect(model).toBeDisabled();
    await setCaret('@OrkasCodex '.length);
    await appPage.evaluate(() => {
      (window as any).setChatSkill('new-chat', 'docs-fixture', 'Docs');
      (window as any).setChatConnector('new-chat', 'drive-fixture', 'Google Drive');
    });
    const chips = editor.locator('.chat-use-inline-chip');
    await expect(chips).toHaveCount(3);
    const appearance = async (index: number) => {
      await chips.nth(index).hover();
      return chips.nth(index).evaluate((el) => {
        const css = getComputedStyle(el);
        const name = getComputedStyle(el.querySelector('.chat-use-inline-name')!);
        return { background: css.backgroundColor, border: css.border, radius: css.borderRadius,
          fontSize: css.fontSize, cursor: css.cursor, color: name.color };
      });
    };
    const agentAppearance = await appearance(0);
    expect(await appearance(1)).toEqual(agentAppearance);
    expect(await appearance(2)).toEqual(agentAppearance);
    await expect(agentChip).toHaveAttribute('title', '@OrkasCodex');
    await appPage.locator('#panel-new-chat .new-chat-input-wrapper').screenshot({ path: testInfo.outputPath('agent-resource-chips.png') });

    // Mouse clicks cannot place an editable caret inside any of the three chips.
    for (let i = 0; i < 3; i += 1) {
      const token = await chips.nth(i).getAttribute('data-token');
      const value = await input.inputValue();
      const start = value.indexOf(token!);
      await chips.nth(i).click();
      const caret = await selection();
      expect([start, start + token!.length]).toContain(caret.start);
      expect([start, start + token!.length]).toContain(caret.end);
    }
    await setCaret(0);
    await editor.press('ArrowRight');
    expect(await selection()).toEqual({ start: 11, end: 11 });
    await editor.press('ArrowLeft');
    expect(await selection()).toEqual({ start: 0, end: 0 });
    await editor.press('Shift+ArrowRight');
    expect(await selection()).toEqual({ start: 0, end: 11 });
    await editor.press('ArrowLeft');
    await editor.press('Delete');
    await expect(agentChip).toHaveCount(0);
    await expect(chips).toHaveCount(2);
    await expect(model).toBeVisible();

    // Pasted/typed names normalize too; deleting one chip retains the other recipient.
    await editor.fill('@OrkasCodex @commander hello');
    await expect(agentChip).toHaveCount(1);
    await expect(editor.locator('[data-kind="commander"]')).toHaveCount(1);
    await setCaret('@OrkasCodex '.length);
    await editor.press('Backspace');
    await expect(input).toHaveValue('@commander hello');
    await expect(appPage.locator('#new-chat-recipient-name')).toHaveText('Commander');

    // Drag across an Agent chip, then replace the selection with ordinary text.
    await editor.fill('before @OrkasCodex after');
    const box = (await agentChip.boundingBox())!;
    await appPage.mouse.move(box.x - 1, box.y + box.height / 2);
    await appPage.mouse.down();
    await appPage.mouse.move(box.x + box.width + 1, box.y + box.height / 2, { steps: 8 });
    await appPage.mouse.up();
    const selected = await selection();
    expect(selected.start).toBeLessThanOrEqual('before '.length);
    expect(selected.end).toBeGreaterThanOrEqual('before @OrkasCodex'.length);
    await appPage.keyboard.type('replacement');
    await expect(agentChip).toHaveCount(0);
    expect(await input.inputValue()).toMatch(/^before\s?replacement\s?after$/);

    // Editing ordinary text beside an existing chip must preserve the caret.
    await editor.fill('@OrkasCodex tail');
    await setCaret(12);
    await editor.press('x');
    await editor.press('y');
    await expect(input).toHaveValue('@OrkasCodex xytail');
    expect(await selection()).toEqual({ start: 14, end: 14 });
    expect(orkas.readCliState().invocations).toHaveLength(0);
  });

  test('resets multi-recipient sends to Commander and retains a later single CLI for follow-ups', async ({ cliOrkas }, testInfo) => {
    const page = cliOrkas.page!;
    const recipients = [];
    for (const name of ['ComposerAlpha', 'ComposerBeta']) {
      const result = await cliOrkas.invoke<{ agent: { agent_id: string; name: string } }>('agents.create', {
        name, description: 'Deterministic recipient continuity fixture', runtime: { kind: 'cli', cli: 'codex' },
      });
      recipients.push(result.agent);
    }
    await page.evaluate(async () => {
      await (window as any).loadRendererFeature('agents');
      await (window as any).loadAgents(true, { summary: true });
    });
    const editor = page.locator('.chat-rich-editor[data-rich-input-id="new-chat-input"]');
    const input = page.locator('#new-chat-input');
    await editor.fill('你好，check the request');
    await editor.press('Home');
    await page.locator('#new-chat-recipient-chip').click();
    await page.locator(`.skill-picker-item[data-id="${recipients[0].agent_id}"]`).click();
    await page.locator(`.skill-picker-item[data-id="${recipients[0].agent_id}"]`).press('Enter');
    await editor.press('Home');
    for (let i = 0; i < 5; i++) await editor.press('ArrowRight');
    await page.locator('#new-chat-recipient-chip').click();
    await page.locator(`.skill-picker-item[data-id="${recipients[1].agent_id}"]`).click();
    await expect(input).toHaveValue('@ComposerAlpha 你好， @ComposerBeta check the request');
    await expect(page.locator('#new-chat-recipient-name')).toHaveText('ComposerAlpha, ComposerBeta');
    await expect(page.locator('.skill-picker-item[data-id="__commander__"]')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('[data-composer-model-chip="new-chat"]')).toBeDisabled();
    // Closing the panel restores the updated cursor; typed text stays after the chosen group.
    await page.locator(`.skill-picker-item[data-id="${recipients[1].agent_id}"]`).press('Enter');
    await expect(editor).toBeFocused();
    await editor.press('X');
    await expect(input).toHaveValue('@ComposerAlpha 你好， @ComposerBeta Xcheck the request');
    // Reopening after moving to the end must use the new caret, including after cancellation.
    await editor.press('End');
    await page.locator('#new-chat-recipient-chip').click();
    await page.locator('#agent-picker-selected').getByRole('button', { name: 'Remove: ComposerBeta', exact: true }).click();
    await page.locator(`.skill-picker-item[data-id="${recipients[1].agent_id}"]`).click();
    await expect(input).toHaveValue('@ComposerAlpha 你好， Xcheck the request @ComposerBeta ');
    await page.locator(`.skill-picker-item[data-id="${recipients[1].agent_id}"]`).press('Enter');
    await editor.pressSequentially('verify the result');
    await expect(page.locator('#new-chat-recipient-name')).toHaveText('ComposerAlpha, ComposerBeta');
    await page.locator('#panel-new-chat .new-chat-input-wrapper').screenshot({ path: testInfo.outputPath('recipient-caret.png') });
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    const cid = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
    expect(cid).toBeTruthy();
    const replies = async () => {
      const result = await cliOrkas.invoke<{ history: Array<{ from?: string; text?: string }> }>('conversations.history', { cid, limit: 30 });
      return recipients.map((agent) => result.history.filter((row) => row.from === agent.agent_id && row.text?.includes('E2E_CODEX_DEFAULT_OK')).length);
    };
    await expect.poll(replies, { timeout: 30_000 }).toEqual([1, 1]);
    const initialHistory = await cliOrkas.invoke<{ history: Array<{ from?: string; to?: string[] }> }>('conversations.history', { cid, limit: 30 });
    expect(initialHistory.history.some((row) => row.from === 'commander')).toBe(false);
    expect(initialHistory.history.find((row) => row.from === 'user')?.to).toEqual(recipients.map((agent) => agent.agent_id));
    await expect(page.locator('#chat-recipient-name')).toHaveText('Commander');
    await expect(page.locator('[data-composer-model-chip="conversation"]')).toBeVisible();
    await expect(page.locator('[data-composer-model-chip="conversation"]')).toBeEnabled();
    const followup = page.locator('.chat-rich-editor[data-rich-input-id="chat-input"]');
    await followup.fill('@ComposerBeta summarize');
    await expect(page.locator('#chat-recipient-name')).toHaveText('ComposerBeta');
    await followup.press('Enter');
    await expect.poll(replies, { timeout: 30_000 }).toEqual([1, 2]);
    await expect(page.locator('#chat-recipient-name')).toHaveText('ComposerBeta');
    await followup.fill('@ComposerBeta @ComposerBeta check the sources too @ComposerAlpha');
    await followup.press('Enter');
    await expect.poll(replies, { timeout: 30_000 }).toEqual([1, 3]);
    await expect(page.locator('#chat-recipient-name')).toHaveText('ComposerBeta');
    await followup.fill('@missing-agent explain `@ComposerAlpha`');
    await followup.press('Enter');
    await expect.poll(replies, { timeout: 30_000 }).toEqual([1, 4]);
    await expect(page.locator('#chat-recipient-name')).toHaveText('ComposerBeta');
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
    // Each card keeps one visible icon without adding another action layer.
    await expect(pptCard.locator('.quick-tile svg')).toBeVisible();
    const restingVisual = await pptCard.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-2)';
      document.body.appendChild(probe);
      const neutralColor = getComputedStyle(probe).color;
      probe.remove();
      const tile = getComputedStyle(element.querySelector('.quick-tile')!);
      return {
        tileColor: tile.color,
        neutralColor,
      };
    });
    expect(restingVisual.tileColor).toBe(restingVisual.neutralColor);
    await pptCard.hover();
    await expect.poll(() => pptCard.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--primary)';
      document.body.appendChild(probe);
      const primaryColor = getComputedStyle(probe).color;
      probe.remove();
      const card = getComputedStyle(element);
      const tile = getComputedStyle(element.querySelector('.quick-tile')!);
      return {
        tileUsesPrimary: tile.color === primaryColor,
        hasTransform: card.transform !== 'none',
        hasShadow: card.boxShadow !== 'none',
      };
    })).toEqual({ tileUsesPrimary: true, hasTransform: true, hasShadow: true });

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
        quickTilesFit: Array.from(document.querySelectorAll('.quick-tile'))
          .every((element) => {
            const tile = element.getBoundingClientRect();
            const card = element.closest('.new-chat-scenario-chip')!.getBoundingClientRect();
            return tile.left >= card.left && tile.right <= card.right
              && tile.top >= card.top && tile.bottom <= card.bottom;
          }),
        // The icon stays proportional to the card while retaining a clear
        // target shape across all server-controlled scenario orders.
        quickTileSizes: Array.from(document.querySelectorAll('.quick-tile'))
          .map((element) => {
            const tile = element.getBoundingClientRect();
            return [Math.round(tile.width), Math.round(tile.height)].join('x');
          }),
        quickIconSizes: Array.from(document.querySelectorAll('.new-chat-scenario-icon'))
          .map((element) => {
            const icon = element.getBoundingClientRect();
            return [Math.round(icon.width), Math.round(icon.height)].join('x');
          }),
        quickCardContentFits: Array.from(document.querySelectorAll('.new-chat-scenario-chip'))
          .every((element) => {
            const card = element.getBoundingClientRect();
            return Array.from(element.querySelectorAll('.quick-tile, .quick-copy'))
              .every((child) => {
                const box = child.getBoundingClientRect();
                return box.left >= card.left && box.right <= card.right
                  && box.top >= card.top && box.bottom <= card.bottom;
              });
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
    expect(layout.quickCardHeight).toBeGreaterThanOrEqual(88);
    expect(layout.quickCardHeight).toBeLessThanOrEqual(94);
    expect(layout.quickCardCount).toBe(9);
    expect(layout.quickGridColumns).toBe(3);
    expect(layout.quickTilesFit).toBe(true);
    expect(layout.quickTileSizes).toEqual(Array(9).fill('40x40'));
    expect(layout.quickIconSizes).toEqual(Array(9).fill('20x20'));
    expect(layout.quickCardContentFits).toBe(true);
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

    await appPage.setViewportSize({ width: 1080, height: 800 });
    await expect.poll(() => appPage.locator('.quick-grid').evaluate((element) => (
      getComputedStyle(element).gridTemplateColumns.split(' ').length
    ))).toBe(2);

    await appPage.setViewportSize({ width: 600, height: 800 });
    const narrowLayout = await appPage.evaluate(() => {
      const landing = document.querySelector('.new-chat-center')!;
      const more = document.querySelector('#quick-panel-oss-more')!.getBoundingClientRect();
      const landingRect = landing.getBoundingClientRect();
      return {
        columns: getComputedStyle(document.querySelector('.quick-grid')!).gridTemplateColumns
          .split(' ').length,
        noHorizontalOverflow: landing.scrollWidth <= landing.clientWidth + 1,
        moreEntryInBounds: more.left >= landingRect.left && more.right <= landingRect.right,
      };
    });
    expect(narrowLayout).toEqual({
      columns: 1,
      noHorizontalOverflow: true,
      moreEntryInBounds: true,
    });
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
      'E2E oversized.png',
      Buffer.alloc(20 * 1024 * 1024 + 1, 0x61),
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
      'E2E mixed oversized.png',
      Buffer.alloc(20 * 1024 * 1024 + 1, 0x61),
    );
    const unsupported = orkas.createFixtureFile('E2E mixed rejected.exe', Buffer.from('not executable'));
    await orkas.selectFilesOnNextDialog([valid, oversized, unsupported]);
    await orkas.page.locator('#new-chat-attach-btn').click();

    const alert = orkas.page.locator('.ui-dialog-overlay:visible .ui-dialog');
    await expect(alert).toContainText('E2E mixed oversized.png');
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
    const imageName = 'E2E compact image.png';
    const firstPath = modelOrkas.createFixtureFile(firstName, '# Multi attachment\n\nFirst body.\n');
    const secondPath = modelOrkas.createFixtureFile(secondName, '{"e2e":true,"kind":"second"}\n');
    const imagePath = modelOrkas.createFixtureFile(imageName, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
      'base64',
    ));
    await modelOrkas.selectFilesOnNextDialog([firstPath, secondPath, imagePath]);

    await page.locator('#new-chat-attach-btn').click();
    await expect(page.locator('#new-chat-attachments .chat-attach-chip')).toHaveCount(3);
    await page.locator('#new-chat-input').fill('Use all deterministic E2E attachments.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText(
      'Hello from the local E2E model.',
      { timeout: 20_000 },
    );
    const userMessage = page.locator('#chat-history .chat-message.user');
    await expect(userMessage).toContainText(firstName);
    await expect(userMessage).toContainText(secondName);
    const imageChip = userMessage.locator('.chat-msg-attach', { hasText: imageName });
    await expect(imageChip).toHaveClass(/\bchat-attach-chip\b/);
    await expect(imageChip.locator('.chat-attach-thumb')).toBeVisible();
    await expect(imageChip.locator('.chat-attach-thumb')).toHaveCSS('width', '22px');
    await expect(imageChip.locator('.chat-attach-thumb')).toHaveCSS('height', '22px');
    await expect(userMessage.locator('video, audio, .chat-msg-attach-thumb-shell')).toHaveCount(0);
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
    await imageChip.locator('.chat-attach-preview').click();
    await expect(page.locator('.chat-lightbox')).toHaveClass(/\bis-open\b/);
    await page.locator('.chat-lightbox-close').click();
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain(firstName);
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain(secondName);
    expect(JSON.stringify(modelOrkas.modelRequests[0])).toContain(imageName);

    const conversationId = await page.locator('#conversation-list .conv-item').first().getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const pending = await modelOrkas.invoke<{ items: unknown[] }>('conversations.attachments.list', {
      cid: conversationId,
    });
    expect(pending.items).toHaveLength(0);

    const relaunchedPage = await modelOrkas.relaunch();
    await relaunchedPage.locator(`#conversation-list .conv-item[data-cid="${conversationId}"]`).click();
    const restoredUserMessage = relaunchedPage.locator('#chat-history .chat-message.user');
    await expect(restoredUserMessage).toContainText(firstName);
    await expect(restoredUserMessage).toContainText(secondName);
    await expect(restoredUserMessage.locator('.chat-msg-attach', { hasText: imageName }))
      .toHaveClass(/\bchat-attach-chip\b/);
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

test('keeps all four recipient tabs on one row, including Library', async ({ appPage }) => {
  await appPage.locator('#new-chat-recipient-chip').click();
  const tabs = appPage.locator('.skill-picker-tabs [data-agent-picker-tab]');
  await expect(tabs).toHaveCount(4);
  const boxes = await tabs.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, width: rect.width, height: rect.height };
  }));
  expect(boxes.every((box) => box.width > 0 && box.height > 0)).toBe(true);
  expect(Math.max(...boxes.map((box) => box.top)) - Math.min(...boxes.map((box) => box.top))).toBeLessThan(2);
  await tabs.filter({ hasText: 'Library' }).click();
  await expect(appPage.locator('[data-agent-picker-tab="library"]')).toHaveClass(/\bactive\b/);
});
