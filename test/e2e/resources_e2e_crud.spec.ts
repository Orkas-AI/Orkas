import { expect, test } from './fixtures/orkas';

type AgentSummary = { agent_id: string; name: string; enabled?: boolean };
type AgentDetail = AgentSummary & {
  description_zh?: string;
  description_en?: string;
  workflow?: string;
  tool_list?: string[];
  category?: string;
};
type SkillSummary = { id: string; name: string; enabled?: boolean };
type RecycleBatch = {
  kind?: string;
  display_items?: Array<{ category: string; id?: string; title: string }>;
};

function toolResultContaining(request: unknown, needle: string): string {
  const messages = Array.isArray((request as { messages?: unknown[] })?.messages)
    ? (request as { messages: Array<{ role?: string; content?: unknown }> }).messages
    : [];
  const hit = messages.find((message) => (
    message?.role === 'tool'
    && typeof message.content === 'string'
    && message.content.includes(needle)
  ));
  return typeof hit?.content === 'string' ? hit.content : '';
}

function systemSection(request: unknown, heading: string): string {
  const messages = Array.isArray((request as { messages?: unknown[] })?.messages)
    ? (request as { messages: Array<{ role?: string; content?: unknown }> }).messages
    : [];
  const system = messages.find((message) => (
    message?.role === 'system'
    && typeof message.content === 'string'
    && message.content.includes(heading)
  ));
  if (typeof system?.content !== 'string') return '';
  const start = system.content.indexOf(heading);
  const tail = system.content.slice(start);
  const nextHeading = tail.slice(heading.length).search(/\n## /);
  return nextHeading < 0
    ? tail
    : tail.slice(0, heading.length + nextHeading);
}

test.describe('agents and skills', () => {
  // Each CRUD case verifies persistence through a complete Electron relaunch.
  // Loading the resource catalog after a cold Windows restart can consume most
  // of the default test budget before the delete/recovery assertions run.
  test.describe.configure({
    timeout: process.platform === 'win32' ? 120_000 : 60_000,
  });

  test('renders the localized Commander profile and persists its color-only avatar choice', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    await orkas.invoke('config.setLanguage', { language: 'pt' });

    let page = await orkas.relaunch();
    await page.locator('#agents-btn').click();
    const card = page.locator('.agent-card[data-id="commander"]');
    await expect(card.locator('.agent-card-name')).toHaveText('Comandante');
    await expect(card.locator('.agent-card-desc')).toContainText('camada de orquestração');

    await card.click();
    await expect(page.locator('#agents-detail-name')).toHaveText('Comandante');
    await expect(page.locator('#agents-detail-desc')).toContainText('camada de orquestração');

    await page.locator('#agents-detail-avatar .avatar-circle').click();
    const picker = page.locator('#avatar-picker');
    await expect(picker).toBeVisible();
    await expect(picker.locator('[data-role="icon-section"]')).toBeHidden();
    await picker.locator('[data-color="sky"]').click();
    await expect.poll(async () => (
      await orkas.invoke<{ avatar: { icon: string; color: string } }>('prefs.getCommanderAvatar')
    ).avatar).toEqual({ icon: 'crown', color: 'sky' });

    page = await orkas.relaunch();
    await page.locator('#agents-btn').click();
    const relaunchedCard = page.locator('.agent-card[data-id="commander"]');
    await expect(relaunchedCard.locator('.agent-card-name')).toHaveText('Comandante');
    await expect(relaunchedCard.locator('.avatar-circle'))
      .toHaveAttribute('style', /--avatar-bg:#7dd3fc/);
  });

  test('creates a runnable Agent from Commander after reading the on-demand authoring contract', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    modelOrkas.setAgentAuthoringScenario([
      'Created the web research Agent.',
      '<agent>',
      '<operation>create</operation>',
      '<name>CommanderWebResearcher</name>',
      '<description>Researches current public sources and delivers cited findings.</description>',
      '<workflow>### 1. Research\n- `web_search(query)` finds current evidence.\n\n### 2. Deliver\n- Return cited findings.</workflow>',
      '<tools>workspace.read\nweb</tools>',
      '<category>data</category>',
      '</agent>',
    ].join('\n'));

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('Create a web research Agent for me.');
    await page.locator('#new-chat-send-btn').click();

    const final = page.locator('#chat-history .chat-message.assistant [data-role="final"]').last();
    await expect(final).toContainText('Created the web research Agent.', { timeout: 20_000 });
    await expect(final).not.toContainText('<agent>');
    const chip = page.locator('.chat-msg-created-agent-chip', {
      hasText: 'CommanderWebResearcher',
    });
    await expect(chip).toBeVisible();

    const listed = await modelOrkas.invoke<{ agents: AgentSummary[] }>('agents.list');
    const summary = listed.agents.find((agent) => agent.name === 'CommanderWebResearcher');
    expect(summary?.agent_id).toMatch(/^[0-9a-f]{12}$/);
    const fetched = await modelOrkas.invoke<{ agent: AgentDetail }>('agents.get', {
      agent_id: summary?.agent_id,
    });
    expect(fetched.agent).toMatchObject({
      name: 'CommanderWebResearcher',
      tool_list: ['workspace.read', 'web'],
      category: 'data',
    });
    expect(fetched.agent.workflow).toContain('web_search(query)');

    expect(modelOrkas.modelRequests).toHaveLength(3);
    const firstRequest = JSON.stringify(modelOrkas.modelRequests[0]);
    const dependencyDirectory = toolResultContaining(
      modelOrkas.modelRequests[1],
      '## Agent tool dependencies',
    );
    const fieldContract = toolResultContaining(
      modelOrkas.modelRequests[2],
      "This is the Agent's default capability boundary",
    );
    expect(firstRequest).not.toContain('## Agent tool dependencies');
    expect(dependencyDirectory).toContain('## Agent tool dependencies');
    expect(dependencyDirectory).toContain('workspace.read');
    expect(dependencyDirectory).not.toContain('add_custom_connector');
    expect(fieldContract).toContain("This is the Agent's default capability boundary");
  });

  test('completes one staged Agent through its edit conversation with a fixed tool list', async ({ modelOrkas }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;
    modelOrkas.setAgentAuthoringScenario([
      'The Agent is configured for current web research.',
      '<agent>',
      '<workflow>### 1. Research\n- `web_search(query)` finds current evidence.\n\n### 2. Deliver\n- Return cited findings.</workflow>',
      '<tools>workspace.read\nweb</tools>',
      '<category>data</category>',
      '</agent>',
    ].join('\n'));

    await page.locator('#agents-btn').click();
    await page.locator('#create-agent-btn').click();
    await page.locator('#agent-name-input').fill('EditChatWebResearcher');
    await page.locator('#agent-desc-input').fill('Researches current sources from an edit conversation.');
    await page.locator('#agent-save-btn').click();

    const final = page.locator('#agents-chat-messages .chat-message.assistant [data-role="final"]').last();
    await expect(final).toContainText('configured for current web research', { timeout: 20_000 });
    await expect(final).not.toContainText('<agent>');

    const listed = await modelOrkas.invoke<{ agents: AgentSummary[] }>('agents.list');
    const matches = listed.agents.filter((agent) => agent.name === 'EditChatWebResearcher');
    expect(matches).toHaveLength(1);
    const fetched = await modelOrkas.invoke<{ agent: AgentDetail }>('agents.get', {
      agent_id: matches[0].agent_id,
    });
    expect(fetched.agent).toMatchObject({
      name: 'EditChatWebResearcher',
      tool_list: ['workspace.read', 'web'],
      category: 'data',
    });
    expect(fetched.agent.description_zh || fetched.agent.description_en)
      .toBe('Researches current sources from an edit conversation.');
    expect(fetched.agent.workflow).toContain('web_search(query)');

    expect(modelOrkas.modelRequests).toHaveLength(3);
    const initialRequest = JSON.stringify(modelOrkas.modelRequests[0]);
    const editorDependencyDirectory = systemSection(
      modelOrkas.modelRequests[0],
      '## Agent tool dependencies',
    );
    expect(editorDependencyDirectory).toContain('## Agent tool dependencies');
    expect(editorDependencyDirectory).toContain('workspace.read');
    expect(editorDependencyDirectory).not.toContain('add_custom_connector');
    expect(initialRequest).toContain('EditChatWebResearcher');
    expect(toolResultContaining(
      modelOrkas.modelRequests[2],
      "This is the Agent's default capability boundary",
    )).toContain("This is the Agent's default capability boundary");
  });

  test('creates an agent, persists its enabled state, and deletes it', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    await page.locator('#agents-btn').click();
    await expect(page.locator('#panel-agents')).toHaveClass(/\bactive\b/);
    await page.locator('#create-agent-btn').click();

    const modal = page.locator('#agent-modal');
    await expect(modal).toHaveClass(/\bopen\b/);
    await page.locator('#agent-name-input').fill('E2EAgent');
    await page.locator('#agent-desc-input').fill('Checks deterministic desktop user flows.');
    await page.locator('#agent-save-btn').click();

    await expect(page.locator('#agents-detail-name')).toHaveText('E2EAgent');
    await expect(page.locator('#agent-edit-btn')).toHaveText('Done');
    await page.locator('#agent-edit-btn').click();
    await expect(page.locator('#agent-enabled-btn')).toBeVisible();
    const created = await orkas.invoke<{ agents: AgentSummary[] }>('agents.list');
    const agent = created.agents.find((item) => item.name === 'E2EAgent');
    expect(agent).toBeTruthy();

    await page.locator('#agent-enabled-btn').click();
    await expect.poll(async () => {
      const result = await orkas.invoke<{ agents: AgentSummary[] }>('agents.list');
      return result.agents.find((item) => item.agent_id === agent?.agent_id)?.enabled;
    }).toBe(false);

    const relaunchedPage = await orkas.relaunch();
    await relaunchedPage.locator('#agents-btn').click();
    const card = relaunchedPage.locator(`.agent-card[data-id="${agent?.agent_id}"]`);
    await expect(card).toHaveClass(/\bis-disabled\b/, { timeout: 30_000 });
    await card.click();
    await expect(relaunchedPage.locator('#agents-detail-name')).toHaveText('E2EAgent');
    await relaunchedPage.locator('#agent-delete-btn').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(relaunchedPage.locator(`.agent-card[data-id="${agent?.agent_id}"]`)).toHaveCount(0);
    const recycle = await orkas.invoke<{ batches: RecycleBatch[] }>('recycle.list');
    expect(recycle.batches).toContainEqual(expect.objectContaining({
      kind: 'agent',
      display_items: expect.arrayContaining([
        expect.objectContaining({
          category: 'agent',
          id: agent?.agent_id,
          title: 'E2EAgent',
        }),
      ]),
    }));
  });

  test('creates a skill, persists its enabled state, and deletes it', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    await page.locator('#skills-btn').click();
    await expect(page.locator('#panel-skills')).toHaveClass(/\bactive\b/);
    await page.locator('#create-skill-btn').click();

    const modal = page.locator('#skill-modal');
    await expect(modal).toHaveClass(/\bopen\b/);
    await page.locator('#skill-name').fill('e2e-desktop-check');
    await page.locator('#skill-description').fill('Verifies deterministic desktop UI behavior.');
    await page.locator('#skill-save-btn').click();

    await expect(page.locator('#skills-detail-name')).toHaveText('e2e-desktop-check');
    await expect(page.locator('#skill-edit-btn')).toHaveText('Done');
    await page.locator('#skill-edit-btn').click();
    await expect(page.locator('#skill-enabled-btn')).toBeVisible();
    const created = await orkas.invoke<{ skills: SkillSummary[] }>('skills.list');
    const skill = created.skills.find((item) => item.name === 'e2e-desktop-check');
    expect(skill).toBeTruthy();

    await page.locator('#skill-enabled-btn').click();
    await expect.poll(async () => {
      const result = await orkas.invoke<{ skills: SkillSummary[] }>('skills.list');
      return result.skills.find((item) => item.id === skill?.id)?.enabled;
    }).toBe(false);

    const relaunchedPage = await orkas.relaunch();
    await relaunchedPage.locator('#skills-btn').click();
    const card = relaunchedPage.locator(`.skill-card[data-id="${skill?.id}"]`);
    await expect(card).toHaveClass(/\bis-disabled\b/, { timeout: 30_000 });
    await card.click();
    await expect(relaunchedPage.locator('#skills-detail-name')).toHaveText('e2e-desktop-check');
    await relaunchedPage.locator('#skill-delete-btn').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(relaunchedPage.locator(`.skill-card[data-id="${skill?.id}"]`)).toHaveCount(0);
    const recycle = await orkas.invoke<{ batches: RecycleBatch[] }>('recycle.list');
    expect(recycle.batches).toContainEqual(expect.objectContaining({
      kind: 'skill',
      display_items: expect.arrayContaining([
        expect.objectContaining({
          category: 'skill',
          id: skill?.id,
          title: 'e2e-desktop-check',
        }),
      ]),
    }));
  });
});
