/**
 * A connector that cannot reach its backend must never render as "已连接".
 *
 * The production failure this pins: Orkas Server's session store went away, so every
 * `/connectors/oauth/refresh` answered `503 系统繁忙`. The refresh error was (correctly) classified
 * transient, and the old code responded by rewriting the row's status back to `connected` — on
 * write, and again as a side effect of merely listing. So the Connectors panel showed a green
 * "已连接" Google Search Console card whose access token had expired ~6 days earlier, while every
 * tool call failed with an opaque `connector unavailable`. The user had no way to see that the
 * data source was unreadable, and neither did the agent.
 *
 * These tests exercise the real `_renderCatalogCard` / `_deriveBundleInstance` / `isConnectorLive`
 * from `modules/connectors.js` against a `degraded` row.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { cssDeclarationsForSelector, cssMediaBlocks } from './helpers/css-oracle';

/** Minimal DOM stand-in: enough for `_renderCatalogCard`'s createElement → innerHTML → querySelector
 *  path, and for asserting the rendered text. Mirrors the harness in connectors-render-cache.test.ts. */
function makeElement(tag: string): any {
  const el: any = {
    tagName: tag,
    className: '',
    dataset: {},
    style: {},
    children: [] as any[],
    _html: '',
    textContent: '',
    title: '',
    get innerHTML() { return el._html; },
    set innerHTML(v: string) { el._html = v; },
    appendChild: (c: any) => { el.children.push(c); return c; },
    addEventListener: () => {},
    setAttribute: () => {},
    closest: () => null,
    // The card looks up `.connector-card-unverified` / `-error` / `-account` / `-name` / `-desc`.
    // Hand back a stub per selector and remember it so the test can read what was written.
    querySelector: (sel: string) => {
      if (!el._q) el._q = new Map<string, any>();
      if (!el._q.has(sel)) el._q.set(sel, { textContent: '', title: '' });
      return el._q.get(sel);
    },
    querySelectorAll: () => [],
  };
  return el;
}

describe('connector setup assistance', () => {
  it.each(['feishu', 'dingtalk', 'wecom'])('shows %s missing permissions alongside both Use and Reauthorize', id => {
    const ctx = loadConnectorsRenderer();
    ctx.t = (key: string, args: any = {}) => `${key} ${args.permissions || ''}`.trim();
    const entry = { id, display_name: 'Lark', auth_mode: 'local_cli' };
    const card = ctx._renderCatalogCard(entry, { id, status: { kind: 'connected' },
      reauthorization_required: true, missing_permissions: id === 'wecom' ? [] : [id === 'feishu' ? 'im:message.send_as_user' : 'chat.message:send'] });
    expect(card.innerHTML).toContain('data-act="use-connector"');
    expect(card.innerHTML).toContain('connectors.action.authorize_permissions');
    expect(card.querySelector('[data-role="permission-notice"]').textContent)
      .toBe(id === 'wecom' ? 'connectors.permissions.limited' : 'connectors.permissions.missing connectors.permissions.send_as_user');
    const ordinary = ctx._renderCatalogCard(entry, { id, status: { kind: 'connected' } });
    expect(ordinary.innerHTML).not.toContain('permission-notice');
  });

  it('names DingTalk message permission and preserves unknown identifiers as text', () => {
    const ctx = loadConnectorsRenderer();
    ctx.t = (key: string, args: any = {}) => `${key} ${args.permissions || ''}`.trim();
    const card = ctx._renderCatalogCard({ id: 'dingtalk', display_name: 'DingTalk', auth_mode: 'local_cli' },
      { id: 'dingtalk', status: { kind: 'connected' }, reauthorization_required: true,
        missing_permissions: ['chat.message:send', 'mail:send', 'calendar.event:get'] });
    expect(card.querySelector('[data-role="permission-notice"]').textContent)
      .toBe('connectors.permissions.missing connectors.permissions.send_as_user, connectors.permissions.send_mail, calendar.event:get');
    expect(card.innerHTML).toContain('data-act="use-connector"');
    expect(card.innerHTML).toContain('connectors.action.authorize_permissions');
  });

  const complex = {
    id: 'seller-app', display_name: 'Seller', auth_mode: 'local_api',
    connection_setup: { requirement: 'provider_application', fields: [] },
  };

  it.each(['feishu', 'dingtalk', 'wecom'].flatMap(id => [false, true].map(required => ({ id, required }))))(
    'keeps $id usable and opens reauthorization only when required: $required', async ({ id, required }) => {
    const ctx = loadConnectorsRenderer();
    const entry = { id, display_name: id, auth_mode: 'local_cli' };
    const instance = { id: entry.id, status: { kind: 'connected' }, reauthorization_required: required };
    ctx.__setCatalog([entry]);
    ctx.__setInstances([instance]);
    ctx.loadConnectors = vi.fn(async () => {});
    ctx._runConnect = vi.fn(async () => {});
    ctx.window.focusConnectorById = vi.fn(async () => true);
    const html = ctx._renderCatalogCard(entry, instance).innerHTML;
    expect(html).toContain('data-act="use-connector"');
    expect(html.includes('connectors.action.authorize_permissions')).toBe(required);
    expect(await ctx.window.openConnectorSetupById(entry.id)).toBe(true);
    expect(ctx._runConnect).toHaveBeenCalledTimes(required ? 1 : 0);
    expect(ctx.window.focusConnectorById).toHaveBeenCalledTimes(required ? 0 : 1);
  });

  it.each(['error', 'degraded'])('offers reauthorization from a %s CLI connection', kind => {
    const ctx = loadConnectorsRenderer();
    const entry = { id: 'dingtalk', display_name: 'DingTalk', auth_mode: 'local_cli' };
    const html = ctx._renderCatalogCard(entry, {
      id: entry.id, status: { kind }, reauthorization_required: true,
    }).innerHTML;
    expect(html).toContain('data-act="connect"');
    expect(html).toContain('connectors.action.authorize_permissions');
  });

  it('offers assistance inside extra-setup panels while catalog cards and unavailable entries keep their normal actions', () => {
    const ctx = loadConnectorsRenderer();
    ctx.__setCatalog([{ ...complex, id: 'seller-region', catalog_parent_id: 'seller' }]);
    for (const entry of [complex, { id: 'cli', auth_mode: 'local_cli' }, {
      id: 'token', connection_setup: { fields: [{ key: 'token' }] },
    }, { id: 'seller', connection_variants: [{ catalog_id: 'seller-region' }] }]) {
      expect(ctx._connectorSetupMarkup(entry, [], 'en', 'setup')).toContain('data-act="setup-assist"');
      expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('data-act="setup-assist"');
    }
    for (const entry of [{ id: 'oauth', auth_mode: 'mcp_dcr' }, {
      ...complex, availability: 'visible_disabled',
    }, { ...complex, _custom: true }]) {
      expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('data-act="setup-assist"');
      expect(ctx._connectorSetupMarkup(entry, [], 'en', 'setup')).not.toContain('data-act="setup-assist"');
    }
    expect(ctx._renderCatalogCard(complex, { status: { kind: 'connected' } }).innerHTML)
      .not.toContain('data-act="setup-assist"');
    expect(ctx._connectorSetupMarkup(complex, [], 'en', 'setup')).toContain('data-act="setup-assist"');
  });

  it('starts one independent Commander task on repeated clicks and sends only connector identity', async () => {
    const ctx = loadConnectorsRenderer();
    let completeCreate!: (value: unknown) => void;
    ctx.ensureModelConfigured = () => true;
    ctx.apiFetch = vi.fn(() => new Promise((resolve) => { completeCreate = resolve; }));
    ctx.conversations = [];
    ctx.renderConversationList = vi.fn();
    ctx._restoreDraft = vi.fn();
    ctx.setView = vi.fn();
    ctx.setChatRecipient = vi.fn();
    ctx.t = (key: string, args: any) => key === 'connectors.setup.assist_request'
      ? `Help configure ${args.name} (${args.id})`
      : key === 'connectors.setup.assist_title' ? `Set up ${args.name}` : key;
    ctx.sendInConversation = vi.fn(async (_cid, _text, _extra, options) => {
      options.onStarted();
      return { started: true };
    });
    const ready = vi.fn();
    const entry = { ...complex, connection_setup: {
      ...complex.connection_setup, fields: [{ key: 'secret', value: 'private-form-value' }],
    } };
    const pending = ctx._assistConnectorSetup(entry, null, ready);
    await ctx._assistConnectorSetup(entry, null, ready);
    expect(ctx.apiFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ctx.apiFetch.mock.calls[0][1].body)).toEqual({
      kind: 'normal', title: 'Set up Seller',
      assistance: { kind: 'connector_setup', connector_id: 'seller-app' },
    });
    expect(ready).not.toHaveBeenCalled();
    completeCreate({ json: async () => ({ ok: true, conversation: { conversation_id: 'fresh-task' } }) });
    await pending;
    expect(ctx.setView).toHaveBeenCalledWith('conversation', 'fresh-task', { skipLoad: true });
    expect(ctx.setChatRecipient).toHaveBeenCalledWith('conversation', { kind: 'commander' });
    expect(ready).toHaveBeenCalledOnce();
    expect(ctx.sendInConversation).toHaveBeenCalledWith('fresh-task', 'Help configure Seller (seller-app)',
      { title_text: 'Help configure Seller (seller-app)' }, expect.any(Object));
    expect(JSON.stringify(ctx.sendInConversation.mock.calls)).not.toContain('private-form-value');
  });

  it('keeps the setup form open on creation failure and permits retry', async () => {
    const ctx = loadConnectorsRenderer();
    ctx.ensureModelConfigured = () => true;
    ctx.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: false }) }));
    ctx.sendInConversation = vi.fn();
    ctx.uiAlert = vi.fn();
    const ready = vi.fn();
    await ctx._assistConnectorSetup(complex, null, ready);
    await ctx._assistConnectorSetup(complex, null, ready);
    expect(ctx.apiFetch).toHaveBeenCalledTimes(2);
    expect(ready).not.toHaveBeenCalled();
    expect(ctx.sendInConversation).not.toHaveBeenCalled();
    expect(ctx.uiAlert).toHaveBeenCalledWith('connectors.setup.assist_failed');
  });

  it('opens the exact protected form even when search hides its card, without reopening the controlled page', async () => {
    const ctx = loadConnectorsRenderer();
    ctx.__setCatalog([complex]);
    ctx.loadConnectors = vi.fn(async () => {});
    ctx.document.querySelectorAll = () => [];
    ctx._runConnect = vi.fn(async () => {});
    expect(await ctx.window.openConnectorSetupById(complex.id)).toBe(true);
    expect(ctx._runConnect).toHaveBeenCalledWith(complex);
    expect(await ctx.window.openConnectorSetupById('missing-connector')).toBe(false);
    expect(ctx._runConnect).toHaveBeenCalledTimes(1);
  });

  it('takes a simple setup entry directly to the existing OAuth launch without a setup dialog', async () => {
    const invoke = vi.fn(async () => ({ ok: true, started: true, attempt_id: 'oauth-entry' }));
    const ctx = loadConnectorsRenderer(invoke);
    ctx.__setCatalog([{ id: 'notion', display_name: 'Notion', auth_mode: 'mcp_dcr' }]);
    ctx.loadConnectors = vi.fn(async () => {});
    const append = vi.spyOn(ctx.document.body, 'appendChild');
    expect(invoke).not.toHaveBeenCalled();
    expect(await ctx.window.openConnectorSetupById('notion')).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connectors.start_oauth', { catalog_id: 'notion' });
    expect(append).not.toHaveBeenCalled();
    expect(ctx.__alerts).toEqual([]);
  });

  it('leaves a recoverable request in the new task if sending never starts', async () => {
    const ctx = loadConnectorsRenderer();
    const input = { value: '', dispatchEvent: vi.fn() };
    ctx.Event = class { constructor(public type: string) {} };
    ctx.ensureModelConfigured = () => true;
    ctx.apiFetch = vi.fn(async () => ({ json: async () => ({
      ok: true, conversation: { conversation_id: 'retry-task' },
    }) }));
    ctx.conversations = [];
    ctx.renderConversationList = vi.fn();
    ctx._restoreDraft = vi.fn();
    ctx.setView = (_view: string, cid: string) => { ctx.currentCid = cid; };
    ctx.document.getElementById = (id: string) => id === 'chat-input' ? input : null;
    ctx.sendInConversation = vi.fn(async () => ({ started: false }));
    ctx.uiAlert = vi.fn();
    await ctx._assistConnectorSetup(complex);
    expect(input.value).toBe('connectors.setup.assist_request');
    expect(input.dispatchEvent).toHaveBeenCalledOnce();
    expect(ctx.uiAlert).toHaveBeenCalledWith('connectors.setup.assist_failed');
    expect(ctx.apiFetch).toHaveBeenCalledTimes(1);
  });
});

function loadConnectorsRenderer(
  invoke: (channel: string, payload: any) => Promise<any> = async () => ({ ok: true }),
  confirmInstall: (args?: any) => Promise<boolean> = async () => true,
) {
  const code = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/connectors.js'),
    'utf8',
  );
  const storage = new Map<string, string>();
  const alerts: string[] = [];
  const clicks: Array<[string, Record<string, unknown>]> = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const errors: Array<[string, Record<string, unknown>]> = [];
  const views: string[] = [];
  const settingsTabs: string[] = [];
  const toasts: string[] = [];
  const apiKeyInput = { focus: vi.fn() };
  const choices: any[] = [];
  const prompts: any[] = [];
  const pushHandlers = new Map<string, (payload: any) => void>();
  const windowHandlers = new Map<string, Array<(payload?: any) => void>>();
  const timers = new Map<number, { at: number; handler: () => void }>();
  let timerNow = 0;
  let timerId = 0;
  const monitor = {
    click: (name: string, data: Record<string, unknown>) => { clicks.push([name, data]); },
    event: (name: string, data: Record<string, unknown>) => { events.push([name, data]); },
    error: (name: string, data: Record<string, unknown>) => { errors.push([name, data]); },
  };
  const context: any = {
    console,
    AbortController,
    setTimeout: (handler: () => void, delay = 0) => {
      const id = ++timerId;
      timers.set(id, { at: timerNow + Number(delay || 0), handler });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    performance: { now: () => 100 },
    currentUserId: 'u-degraded',
    currentView: 'connectors',
    globalThis: { currentUserId: 'u-degraded' },
    createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      key: (index: number) => Array.from(storage.keys())[index] || null,
      get length() { return storage.size; },
    },
    document: {
      createElement: (tag: string) => makeElement(tag),
      getElementById: (id: string) => id === 'settings-orkas-api-key-input' ? apiKeyInput : null,
      querySelectorAll: () => [],
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    window: {
      addEventListener: (name: string, handler: (payload?: any) => void) => {
        const handlers = windowHandlers.get(name) || [];
        handlers.push(handler);
        windowHandlers.set(name, handlers);
      },
      removeEventListener: (name: string, handler: (payload?: any) => void) => {
        windowHandlers.set(name, (windowHandlers.get(name) || []).filter((item) => item !== handler));
      },
      innerWidth: 1200,
      innerHeight: 800,
      Monitor: monitor,
      activateSettingsTab: (tab: string) => { settingsTabs.push(tab); },
      orkas: {
        invoke,
        onPushEvent: (channel: string, handler: (payload: any) => void) => { pushHandlers.set(channel, handler); },
      },
    },
    Monitor: monitor,
    uiAlert: (message: string) => { alerts.push(message); },
    uiConfirmDanger: async () => true,
    uiConfirm: confirmInstall,
    uiChoice: async (args: any) => { choices.push(args); return 'approve'; },
    uiPrompt: async (message: string, defaultValue: string) => {
      prompts.push({ message, defaultValue });
      return defaultValue;
    },
    uiToast: (message: string) => { toasts.push(message); },
    setView: (view: string) => { views.push(view); },
    setChatRecipient: () => {},
    setChatConnector: () => {},
    // Echo the key so assertions can match on it without depending on locale copy.
    t: (key: string, params?: Record<string, unknown>) =>
      (params && 'n' in params ? `${key}:${params.n}` : key),
    getLang: () => 'zh',
    pickDesc: (entry: any) => entry?.description_zh || entry?.description_en || '',
    formatChatUseLabel: ({ name }: { name: string }) => name,
    sanitizeSvgIconHtml: () => '',
    escapeHtml: (value: unknown) => String(value ?? ''),
  };
  context.window.window = context.window;
  context.window.globalThis = context.globalThis;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'connectors.js' });
  // `_connectorsState` is a top-level `let`, so it is NOT a property of the context object (only
  // function declarations are). Reach it by running code inside the context instead.
  context.__setInstances = (list: unknown[]) => {
    context.__pending = list;
    vm.runInContext('_connectorsState.instances = __pending;', context);
  };
  context.__setCatalog = (list: unknown[]) => {
    context.__pendingCatalog = list;
    vm.runInContext('_connectorsState.catalog = __pendingCatalog;', context);
  };
  context.__alerts = alerts;
  context.__clicks = clicks;
  context.__events = events;
  context.__errors = errors;
  context.__views = views;
  context.__settingsTabs = settingsTabs;
  context.__toasts = toasts;
  context.__apiKeyInput = apiKeyInput;
  context.__choices = choices;
  context.__prompts = prompts;
  context.__emitPush = (channel: string, payload: any) => pushHandlers.get(channel)?.(payload);
  context.__emitWindow = (name: string, payload?: any) => {
    for (const handler of windowHandlers.get(name) || []) handler(payload);
  };
  context.__advanceTimers = (durationMs: number) => {
    timerNow += durationMs;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= timerNow)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (!due.length) break;
      const [id, timer] = due[0];
      timers.delete(id);
      timer.handler();
    }
  };
  context.__runInstallConfirm = async (info: unknown) => {
    context.__pendingInstallInfo = info;
    vm.runInContext('_connectorInstallQueue.push(__pendingInstallInfo);', context);
    await context._drainConnectorInstallQueue();
  };
  return context;
}

const GSC_ENTRY = { id: 'gsearch-console', display_name: 'Google Search Console', description_zh: 'GSC' };

function mountCategoryGrid(ctx: any) {
  const elements = new Map<string, any>();
  for (const id of [
    'connectors-grid-view', 'connectors-group-connected', 'connectors-group-available',
    'connectors-grid-connected', 'connectors-grid-available', 'connectors-empty',
    'connectors-group-connected-count', 'connectors-group-available-count',
    'connectors-categories', 'connectors-search-input',
  ]) {
    const element = makeElement('div');
    Object.defineProperty(element, 'innerHTML', {
      get: () => element._html,
      set: (html: string) => { element._html = html; element.children = []; },
    });
    elements.set(id, element);
  }
  const host = elements.get('connectors-categories');
  let buttons: any[] = [];
  host.querySelectorAll = () => {
    buttons = [...host.innerHTML.matchAll(/data-connectors-cat="([^"]*)" aria-pressed="(true|false)"/g)]
      .map((match) => ({
        dataset: { connectorsCat: match[1] }, active: match[2] === 'true',
        addEventListener(_event: string, handler: () => void) { this.click = handler; },
      }));
    return buttons;
  };
  host.querySelector = () => ({ focus: () => {} });
  const search = elements.get('connectors-search-input');
  let onInput = () => {};
  search.addEventListener = (_event: string, handler: () => void) => { onInput = handler; };
  ctx.document.getElementById = (id: string) => elements.get(id) || null;
  return {
    elements,
    categories: () => buttons.map(button => button.dataset.connectorsCat),
    active: () => buttons.find(button => button.active)?.dataset.connectorsCat,
    click: (code: string) => {
      const button = buttons.find(button => button.dataset.connectorsCat === code);
      expect(button, `category ${code} is offered`).toBeDefined();
      button.click();
    },
    search: (value: string) => { search.value = value; onInput(); },
    cards: (group = 'available') => elements.get(`connectors-grid-${group}`).children.map((card: any) => card.dataset.id),
  };
}

describe('connector category browsing', () => {
  it('makes every newly added OAuth service discoverable in exactly one category matching its purpose', async () => {
    const { COMPOSIO_MANAGED_ENTRIES } = await import('../../src/main/features/connectors/catalog-managed');
    // Purpose-based acceptance inventory for the 69-service expansion. Keep this independent
    // of legacy catalog categories so a wrong fallback cannot silently pass the browse test.
    const expected: Record<string, string[]> = {
      ecommerce: ['omnisend'],
      office: [
        'apaleo', 'asana', 'attio', 'blackbaud', 'boldsign', 'cal-com', 'calendly',
        'capsule-crm', 'clickup', 'dart', 'eventbrite', 'excel', 'fathom', 'freshbooks',
        'google-meet', 'google-slides', 'google-tasks', 'greenhouse', 'harvest',
        'microsoft-teams', 'miro', 'monday', 'moneybird', 'mural', 'pinterest-ads',
        'reddit-ads', 'roam', 'servicem8', 'ticktick', 'timely', 'todoist', 'trello',
        'webex', 'wrike', 'zoom',
      ],
      rnd: ['bitbucket', 'crowdin', 'figma', 'hugging-face', 'pagerduty', 'prisma', 'productboard', 'wakatime', 'zeplin'],
      creation: ['canva', 'contentful', 'instagram', 'linkedin', 'reddit', 'twitch', 'youtube'],
      data: ['google-bigquery'],
      education: ['google-classroom'],
      general: [
        'box', 'dialpad', 'dropbox', 'dub', 'exist', 'google-maps', 'google-photos',
        'linkhut', 'pushbullet', 'splitwise', 'stack-exchange', 'ticketmaster',
        'typeform', 'yandex', 'ynab',
      ],
    };
    expect(Object.values(expected).flat().sort()).toEqual(COMPOSIO_MANAGED_ENTRIES.map(entry => entry.id).sort());
    const ctx = loadConnectorsRenderer();
    const grid = mountCategoryGrid(ctx);
    ctx.__setCatalog(COMPOSIO_MANAGED_ENTRIES);
    ctx._renderConnectorsGrid();
    expect(grid.categories()).toEqual(['', 'ecommerce', 'office', 'rnd', 'creation', 'data', 'education', 'general']);
    for (const [category, ids] of Object.entries(expected)) {
      grid.click(category);
      expect(grid.cards().sort(), category).toEqual([...ids].sort());
      expect(grid.elements.get('connectors-group-available-count').textContent, category).toBe(String(ids.length));
    }
    grid.click('');
    expect(grid.cards().sort()).toEqual(Object.values(expected).flat().sort());
  });

  it('organizes the real catalog by purpose and keeps the other categories reachable when filtering', async () => {
    const { CONNECTOR_CATALOG } = await import('../../src/main/features/connectors/catalog');
    const ctx = loadConnectorsRenderer();
    const grid = mountCategoryGrid(ctx);
    ctx.__setCatalog(CONNECTOR_CATALOG);
    ctx.__setInstances([{ id: 'notion', status: { kind: 'degraded' } }]);
    ctx._renderConnectorsGrid();
    expect(grid.categories()).toEqual(['', 'ecommerce', 'office', 'rnd', 'creation', 'data', 'education', 'general']);
    grid.click('rnd');
    expect(grid.cards()).toEqual(expect.arrayContaining(['atlassian', 'cloudflare', 'github', 'gitlab', 'linear', 'sentry', 'supabase', 'memberstack', 'figma', 'zeplin']));
    expect(grid.cards()).not.toContain('stripe');
    expect(grid.cards('connected')).toEqual(['notion']);
    expect(grid.elements.get('connectors-group-available-count').textContent).toBe(String(grid.cards().length));
    grid.click('creation');
    expect(grid.cards()).toEqual(expect.arrayContaining(['facebook', 'pinterest', 'webflow', 'kit', 'canva', 'contentful', 'instagram', 'youtube']));
    expect(grid.cards()).not.toContain('printify');
    grid.click('data');
    expect(grid.cards()).toEqual(expect.arrayContaining(['airtable', 'google-analytics', 'segment', 'gsearch-console']));
    expect(grid.cards()).not.toContain('shopify-admin');
    expect(grid.cards()).not.toContain('gsheets');
    grid.click('office');
    expect(grid.cards()).toEqual(expect.arrayContaining(['feishu', 'dingtalk', 'hubspot', 'quickbooks', 'xero', 'netsuite', 'taxjar', 'gsheets', 'excel', 'mailchimp', 'google-ads', 'zoom']));
    expect(grid.cards()).not.toContain('gmail');
    expect(grid.cards()).not.toContain('gdrive');
    grid.click('ecommerce');
    expect(grid.cards()).toEqual(expect.arrayContaining(['shopify-admin', 'woocommerce', 'printify', 'klaviyo', 'omnisend', 'lemon-squeezy', 'gumroad']));
    expect(grid.cards()).not.toContain('stripe');
    expect(grid.cards()).not.toContain('paypal');
    expect(grid.cards()).not.toContain('google-analytics');
    expect(grid.cards()).not.toContain('quickbooks');
    grid.click('education');
    expect(grid.cards()).toEqual(['google-classroom']);
    grid.click('general');
    expect(grid.cards()).toEqual(expect.arrayContaining(['stripe', 'paypal', 'square', 'hitpay', 'btcpay-server', 'poof', 'gmail', 'outlook', 'slack', 'onedrive', 'box', 'dropbox', 'sendgrid', 'google-maps']));
    expect(grid.cards()).not.toContain('paypal-sandbox');
    expect(grid.cards()).not.toContain('shopify-admin');
    expect(grid.cards()).not.toContain('quickbooks');
    expect(grid.cards()).not.toContain('feishu');
  });

  it('hides categories represented only by hidden children or installed cards and recovers after connecting the last match', () => {
    const ctx = loadConnectorsRenderer();
    const grid = mountCategoryGrid(ctx);
    ctx.__setCatalog([
      { id: 'workspace', display_name: 'Workspace', category: 'productivity', bundle_member_ids: ['sheet'] },
      { id: 'sheet', display_name: 'Sheet', category: 'data' },
      { id: 'legacy', category: 'education', catalog_parent_id: 'workspace' },
      { id: 'github', display_name: 'GitHub', category: 'developer' },
    ]);
    ctx._renderConnectorsGrid();
    expect(grid.categories()).toEqual(['', 'office', 'rnd']);
    grid.click('rnd');
    ctx.__setInstances([{ id: 'github', status: { kind: 'connected' } }]);
    ctx._renderConnectorsGrid();
    expect(grid.categories()).toEqual(['', 'office']);
    expect(grid.active()).toBe('');
    expect(grid.cards()).toEqual(['workspace']);
    expect(grid.cards('connected')).toEqual(['github']);
    ctx.__setInstances([
      { id: 'github', status: { kind: 'connected' } },
      { id: 'sheet', status: { kind: 'connected' } },
    ]);
    ctx._renderConnectorsGrid();
    expect(grid.elements.get('connectors-categories').innerHTML).toBe('');
    expect(grid.elements.get('connectors-group-available').style.display).toBe('none');
    // Disconnecting restores the card and its category without a page reload.
    ctx.__setInstances([{ id: 'sheet', status: { kind: 'connected' } }]);
    ctx._renderConnectorsGrid();
    expect(grid.categories()).toEqual(['', 'rnd']);
    expect(grid.cards()).toEqual(['github']);
    expect(grid.cards('connected')).toEqual(['workspace']);
  });

  it('updates category labels in every locale and restores reachable results as search changes', () => {
    const ctx = loadConnectorsRenderer();
    const grid = mountCategoryGrid(ctx);
    ctx.__setCatalog([
      { id: 'github', display_name: 'GitHub', category: 'developer' },
      { id: 'shopify-admin', display_name: 'Shopify Admin', category: 'commerce' },
    ]);
    ctx._renderConnectorsGrid();
    grid.click('rnd');
    for (const [lang, label] of [['zh', '产研'], ['en', 'R&amp;D'], ['ja', '研究開発'], ['pt', 'P&amp;D']]) {
      const locale = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${lang}.json`), 'utf8'));
      ctx.getLang = () => lang;
      ctx.t = (key: string) => locale[key] || key;
      ctx.__emitWindow('i18n-change');
      expect(grid.elements.get('connectors-categories').innerHTML).toContain(`>${label}</button>`);
      expect(grid.active()).toBe('rnd');
      expect(grid.cards()).toEqual(['github']);
    }
    grid.search('shopify');
    expect(grid.categories()).toEqual(['', 'ecommerce']);
    expect(grid.active()).toBe('');
    expect(grid.cards()).toEqual(['shopify-admin']);
    grid.search('no-such-connector');
    expect(grid.elements.get('connectors-categories').innerHTML).toBe('');
    expect(grid.elements.get('connectors-empty').style.display).toBe('');
    grid.search('');
    expect(grid.categories()).toEqual(['', 'ecommerce', 'rnd']);
    expect(grid.cards()).toEqual(['github', 'shopify-admin']);
  });

  it('makes custom and unrecognized connectors discoverable under General without inventing empty categories', () => {
    const ctx = loadConnectorsRenderer();
    const grid = mountCategoryGrid(ctx);
    ctx.__setCatalog([{ id: 'future', display_name: 'Future service', category: 'unrecognized' }]);
    ctx.__setInstances([{ id: 'custom-service', display_name: 'Custom service', origin: 'custom', status: { kind: 'error' } }]);
    ctx._renderConnectorsGrid();
    expect(grid.categories()).toEqual(['', 'general']);
    grid.click('general');
    expect(grid.cards()).toEqual(['custom-service', 'future']);
  });

  it('accepts categories from a refreshed server catalog while keeping legacy and unknown rows reachable', () => {
    const ctx = loadConnectorsRenderer();
    const grid = mountCategoryGrid(ctx);
    const cached = [{ id: 'notion', display_name: 'Notion', category: 'productivity' }];
    ctx.__setCatalog(cached);
    ctx._renderConnectorsGrid();
    grid.click('office');
    ctx.__setCatalog([
      ...cached,
      { id: 'new-publisher', display_name: 'New publisher', category: 'creation' },
      { id: 'new-service', display_name: 'New service' },
      { id: 'constructor', display_name: 'Unrecognized category', category: '__proto__' },
      { id: 'canva', display_name: 'Canva', category: 'productivity' },
    ]);
    ctx._renderConnectorsGrid();
    expect(grid.active()).toBe('office');
    expect(grid.cards()).toEqual(['notion']);
    expect(grid.categories()).toEqual(['', 'office', 'creation', 'general']);
    grid.click('creation');
    expect(grid.cards()).toEqual(['canva', 'new-publisher']);
    grid.click('general');
    expect(grid.cards()).toEqual(['new-service', 'constructor']);
  });

  it('reveals an explicit connector navigation target hidden by the active category', async () => {
    const ctx = loadConnectorsRenderer();
    const grid = mountCategoryGrid(ctx);
    ctx.document.createElement = (tag: string) => ({ ...makeElement(tag), scrollIntoView: vi.fn(), focus: vi.fn() });
    ctx.document.querySelectorAll = () => grid.elements.get('connectors-grid-available').children;
    ctx.__setCatalog([
      { id: 'github', display_name: 'GitHub', category: 'developer' },
      { id: 'notion', display_name: 'Notion', category: 'productivity' },
    ]);
    ctx._renderConnectorsGrid();
    grid.click('rnd');
    expect(grid.cards()).toEqual(['github']);
    expect(await ctx.window.focusConnectorById('notion')).toBe(true);
    expect(grid.active()).toBe('');
    expect(grid.cards()).toEqual(['github', 'notion']);
  });
});

/** The real shape observed on disk during the incident: last verified 2026-07-10, refresh 503ing. */
function degradedGscInstance(lastVerifiedAt: number) {
  return {
    id: 'gsearch-console',
    display_name: 'Google Search Console',
    status: {
      kind: 'degraded',
      message: 'refresh HTTP 503: {"code":1,"msg":"系统繁忙，请稍后重试"}',
      at: Date.now(),
      last_verified_at: lastVerifiedAt,
    },
    enabled: true,
    tools_cache: [{ name: 'list_sites', description: '', input_schema: {} }],
  };
}

describe('connectors panel — degraded cards never claim 已连接', () => {
  it('keeps the connector search field compact on desktop and narrow layouts', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
    // One desktop rule, one narrow override — nothing else may restyle the field.
    const rules = cssDeclarationsForSelector(css, '.connectors-search');
    expect(rules).toHaveLength(2);
    expect(rules[0].width).toBe('clamp(180px, 20vw, 240px)');
    const narrow = cssMediaBlocks(css)
      .filter((block) => /max-width/.test(block.query))
      .flatMap((block) => cssDeclarationsForSelector(block.body, '.connectors-search'));
    expect(narrow).toEqual([{ width: 'min(240px, 100%)' }]);
  });

  it('starts OAuth from a cold Commander configure hand-off with one catalog load', async () => {
    const invoke = vi.fn(async (channel: string, _payload: unknown) => {
      if (channel === 'connectors.catalog') return { ok: true, catalog: [{ id: 'github', display_name: 'GitHub', auth_mode: 'server_bridge' }] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      if (channel === 'connectors.start_oauth') return { ok: true, started: true, attempt_id: 'commander-oauth' };
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);
    // c3fc230a8 made setup catalog-owned: no painted-card prerequisite or Commander-only
    // guide mode. Exercise the real async connect flow instead of the obsolete sync stub.
    ctx.document.querySelectorAll = () => [];

    await expect(ctx.window.openConnectorSetupById('github')).resolves.toBe(true);

    expect(invoke.mock.calls.filter(([channel]) => channel === 'connectors.catalog')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'connectors.start_oauth'))
      .toEqual([['connectors.start_oauth', { catalog_id: 'github' }]]);
    expect(ctx.__alerts).toEqual([]);
  });

  it('loads before focusing when nothing is painted yet, and again while a load is still in flight', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = false;
    const ctx = loadConnectorsRenderer(async (channel) => {
      calls.push(channel);
      if (channel === 'connectors.catalog') {
        if (!gated) { gated = true; await gate; }
        return { ok: true, catalog: [{ id: 'github', display_name: 'GitHub', auth_mode: 'server_bridge' }] };
      }
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      return { ok: true };
    });
    const card = { dataset: { id: 'github' }, setAttribute() {}, scrollIntoView() {}, focus() {} };
    ctx.document.querySelectorAll = (selector: string) => (selector === '.connector-card[data-id]' ? [card] : []);

    // Cold state: the first focus request has to load (and is held at the gate).
    const cold = ctx.window.focusConnectorById('github');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((channel) => channel === 'connectors.catalog')).toHaveLength(1);
    // In flight: a second request must not focus a card the pending paint replaces.
    const inFlight = ctx.window.focusConnectorById('github');
    release();
    await expect(Promise.all([cold, inFlight])).resolves.toEqual([true, true]);
    expect(calls.filter((channel) => channel === 'connectors.catalog')).toHaveLength(2);

    // Warm and idle: focusing reuses the painted grid.
    await expect(ctx.window.focusConnectorById('github')).resolves.toBe(true);
    expect(calls.filter((channel) => channel === 'connectors.catalog')).toHaveLength(2);
  });

  it('uses real locale tables for cards, setup, errors, custom summaries and sensitive confirmations', async () => {
    const { CONNECTOR_CATALOG } = await import('../../src/main/features/connectors/catalog');
    const ctx = loadConnectorsRenderer();
    ctx.__setCatalog(CONNECTOR_CATALOG);
    const shopee = CONNECTOR_CATALOG.find(row => row.id === 'shopee')!;
    const expected = {
      zh: ['店铺 ID', '中国大陆（open.shopee.cn）', '外部', '飞书'],
      en: ['Shop ID', 'Mainland China (open.shopee.cn)', 'External', 'Lark'],
      ja: ['ショップ ID', '中国本土（open.shopee.cn）', '外部', 'Lark'],
      pt: ['ID da loja', 'China continental (open.shopee.cn)', 'Ação externa', 'Lark'],
    };
    for (const lang of ['zh', 'en', 'ja', 'pt'] as const) {
      const table = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${lang}.json`), 'utf8'));
      ctx.getLang = () => lang;
      ctx.t = (key: string, params: Record<string, unknown> = {}) => String(table[key] || key)
        .replace(/\{(\w+)\}/g, (match: string, name: string) => String(params[name] ?? match));
      const html = ctx._connectorSetupMarkup(shopee, shopee.connection_setup!.fields, lang, 'four-locales');
      expect(html).toContain(expected[lang][0]);
      expect(html).toContain(ctx.escapeHtml(expected[lang][1]));
      expect(html).toContain('value="cn"');
      expect(html).toContain('https://orkas.ai/api/connectors/oauth/dcr-callback');
      for (const entry of CONNECTOR_CATALOG) {
        const card = ctx._renderCatalogCard(entry, null);
        expect(card.querySelector('.connector-card-desc').textContent, `${entry.id}/${lang}`).toBe(entry[`description_${lang}`] || entry.description_en);
        for (const policy of Object.values(entry.tool_policies || {})) {
          if (policy.sensitive_operation) expect(table[`connectors.action_confirm.operation.${policy.sensitive_operation}`], `${entry.id}/${lang}`).toBeTruthy();
        }
      }
      for (const operation of ['external_or_financial_change', 'destructive', 'financial_record_change', 'external_or_workflow_change', 'future_unknown_operation']) {
        const info = { connector_id: 'feishu', display_name: '飞书', sensitive_operation: operation, tool_name: 'send_message', arguments_preview: '{"text":"用户内容"}' };
        const message = ctx._connectorActionMessage(info);
        const details = ctx._connectorActionDetails(info);
        expect(message).not.toContain('connectors.');
        expect(message).not.toContain('future_unknown_operation');
        expect(message).toContain(expected[lang][3]);
        expect(details).not.toContain('connectors.');
        expect(details).not.toContain('future_unknown_operation');
        expect(details).toContain('{"text":"用户内容"}');
      }
      for (const [error, key] of [
        [{ code: 'seller_shop_mismatch', error: 'private upstream detail' }, 'connectors.seller.shop_mismatch'],
        [{ code: 'local_cli_authorization_failed' }, 'connectors.errors.authorization_failed'],
        [{ error: 'invalid connector secret: partner_key' }, 'connectors.errors.invalid_configuration'],
        [{ error: 'refresh HTTP 503: private upstream detail' }, 'connectors.errors.network'],
        [{ error: 'unknown_private_error' }, 'connectors.errors.connect_failed'],
      ] as const) {
        expect(ctx._formatConnectError(error)).toBe(table[key]);
        expect(ctx._formatConnectError(error)).not.toMatch(/private|partner_key|connectors\./);
      }
      expect(ctx._formatConnectError({
        code: 'local_cli_authorization_failed', authorization_detail: 'Provider requires admin approval.',
      })).toBe(table['connectors.errors.authorization_failed_detail'].replace('{detail}', 'Provider requires admin approval.'));
      expect(ctx._customTransportSummary({ transport: { kind: 'stdio', command: 'node', argument_count: 3, summary: 'old' } }))
        .toBe(`node (${ctx.t('connectors.custom.argument_count', { n: 3 })})`);
    }
    expect(ctx._connectorCopy({ description_en: 'Remote fallback' }, 'description', 'ja-JP')).toBe('Remote fallback');
  });

  it('shows the detailed authorization result once without sending provider text to telemetry', () => {
    const ctx = loadConnectorsRenderer();
    const table = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'));
    ctx.t = (key: string, params: Record<string, unknown> = {}) => String(table[key] || key)
      .replace(/\{(\w+)\}/g, (match: string, name: string) => String(params[name] ?? match));
    const reason = '该组织尚未开启 CLI 数据访问权限，请联系管理员开启';
    const outcome = {
      attempt_id: 'attempt-dingtalk-denied', catalog_id: 'dingtalk', result: 'failure',
      code: 'local_cli_authorization_failed', error: 'local_cli_authorization_failed:dingtalk',
      authorization_detail: reason, duration_ms: 14_000,
    };
    ctx.__emitPush('connectors:oauth-result', outcome);
    ctx.__emitPush('connectors:oauth-result', outcome);
    expect(ctx.__alerts).toEqual([`授权失败：${reason}`]);
    expect(JSON.stringify([ctx.__events, ctx.__errors])).not.toContain(reason);
    // Provider words such as "network" must not override an explicit detailed result.
    expect(ctx._formatConnectError({ ...outcome, authorization_detail: 'Network policy blocks this application.' }))
      .toBe('授权失败：Network policy blocks this application.');
    expect(ctx._formatConnectError({ code: 'oauth_failed', authorization_detail: 'untrusted detail' }))
      .toBe(table['connectors.errors.connect_failed']);
  });

  it('shows a device-key recovery message without mislabeling it as expired authorization', () => {
    const ctx = loadConnectorsRenderer();
    const entry = {
      id: 'notion',
      display_name: 'Notion',
      transport_template: { kind: 'streamable-http', url: 'https://mcp.notion.com/mcp' },
    };
    const instance = {
      id: 'notion',
      display_name: 'Notion',
      status: { kind: 'error', message: 'connector_secrets_unavailable', at: 1 },
      tools_cache: [],
    };

    expect(ctx._formatConnectorStatusError(instance.status.message)).toBe('connectors.errors.secrets');
    expect(ctx._formatConnectorStatusError(instance.status.message)).not.toContain('connectors.errors.reconnect');
    expect(ctx._isReconnectableError(entry, instance)).toBe(false);

    const card = ctx._renderCatalogCard(entry, instance);
    expect(card.querySelector('.connector-card-error').textContent).toContain('connectors.errors.secrets');
    expect(card.innerHTML).not.toContain('data-act="connect"');
    expect(card.innerHTML).toContain('data-act="disconnect"');
  });

  it('routes a paid connector to Settings → Models before OAuth when the API key is missing', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'orkasApi.getStatus') {
        return { ok: true, configured: false, connectorAccess: false };
      }
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);

    await ctx._runConnect({
      id: 'composio-mail',
      display_name: 'Mail',
      auth_mode: 'composio',
      requires_credits: true,
    });
    ctx.__advanceTimers(0);

    expect(ctx.__views).toEqual(['settings']);
    expect(ctx.__settingsTabs).toEqual(['credentials']);
    expect(ctx.__apiKeyInput.focus).toHaveBeenCalledOnce();
    expect(ctx.__toasts).toEqual(['connectors.errors.api_key_required']);
    expect(invoke).not.toHaveBeenCalledWith('connectors.start_oauth', expect.anything());
  });

  it('starts a paid connection with a locally configured key without requiring cached permissions', async () => {
    const invoke = vi.fn(async (channel: string) => channel === 'orkasApi.getStatus'
      ? { ok: true, configured: true, scopes: [] }
      : { ok: true, started: true, attempt_id: 'offline-configured' });
    const ctx = loadConnectorsRenderer(invoke);
    await ctx._runConnect({ id: 'composio-mail', auth_mode: 'composio', requires_credits: true });
    expect(invoke).toHaveBeenCalledWith('connectors.start_oauth', { catalog_id: 'composio-mail' });
    expect(ctx.__views).toEqual([]);
  });

  it('renders the failure reason and staleness instead of the connected treatment', () => {
    const ctx = loadConnectorsRenderer();
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    const card = ctx._renderCatalogCard(GSC_ENTRY, degradedGscInstance(sixDaysAgo));

    // Marked unverified, and NOT given the connected card treatment.
    expect(card.className).toContain('is-unverified');

    // The green "connected" dot rides on `.connector-card-account`; a degraded card must not
    // render that element at all — it renders `.connector-card-unverified` instead.
    expect(card.innerHTML).toContain('connector-card-unverified');
    expect(card.innerHTML).not.toContain('connector-card-account');

    // The line states both halves the old UI could never show: why, and how stale.
    const line = card.querySelector('.connector-card-unverified');
    expect(line.textContent).toContain('connectors.status.unverified');
    expect(line.textContent).toContain('connectors.status.verified_days_ago:6');
    expect(line.textContent).toContain('connectors.errors.network');
    expect(line.textContent).not.toContain('503');

    // The action offers retry (refresh), not "使用" — and not a pointless re-OAuth, since the
    // grant is fine and it is the backend that is down.
    expect(card.innerHTML).toContain('data-act="retry-degraded"');
    expect(card.innerHTML).not.toContain('data-act="use-connector"');
  });

  it('does not treat a degraded connector as live for the user', () => {
    const ctx = loadConnectorsRenderer();
    ctx.__setInstances([degradedGscInstance(Date.now() - 60 * 60 * 1000)]);

    // Not offered for @-use / composer pinning, even though the main side still routes it to the
    // LLM so a tool call can heal it.
    expect(ctx.isConnectorLive('gsearch-console')).toBe(false);
    expect(ctx.listUsableConnectorsForPicker().map((c: any) => c.id)).not.toContain('gsearch-console');
  });

  it('reports one diagnostic result for an enable business failure without a paired error', async () => {
    const ctx = loadConnectorsRenderer(async (channel: string) => {
      if (channel === 'connectors.set_enabled') {
        return { ok: false, code: 'E_STORAGE', error: 'network unavailable' };
      }
      return { ok: true };
    });

    await ctx._toggleConnectorEnabled(
      { id: 'notion', display_name: 'Notion' },
      { id: 'notion', status: { kind: 'connected' }, enabled: true },
      false,
    );

    expect(ctx.__alerts).toHaveLength(1);
  });

  it('does not overwrite a committed enable success when the presentation refresh throws', async () => {
    const ctx = loadConnectorsRenderer(async (channel: string) => {
      if (channel === 'connectors.set_enabled') return { ok: true };
      return { ok: true };
    });
    ctx._renderConnectorsGrid = () => { throw new Error('render refresh failed'); };

    await expect(ctx._toggleConnectorEnabled(
      { id: 'notion', display_name: 'Notion' },
      { id: 'notion', status: { kind: 'connected' }, enabled: true },
      false,
    )).rejects.toThrow('render refresh failed');

  });

  it('fails a broken Agent install dialog closed and reports one bounded failure', async () => {
    const invoke = vi.fn(async () => ({ handled: true }));
    const ctx = loadConnectorsRenderer(
      invoke,
      async () => { throw new Error('/Users/test/private/dialog.json'); },
    );

    await ctx.__runInstallConfirm({
      request_id: 'private-request',
      display_name: 'Private Server',
      summary: 'private command',
      kind: 'stdio',
    });

    expect(invoke).toHaveBeenCalledWith('connectors.install_confirm_response', {
      request_id: 'private-request',
      approved: false,
    });
  });

  it('keeps a destructive operation identifiable while details contain only its parameters', () => {
    const ctx = loadConnectorsRenderer();

    const info = {
      request_id: 'action-request',
      cid: 'c1',
      connector_id: 'shop',
      display_name: 'Shop',
      account_label: 'Store A',
      tool_name: 'SHOP_DELETE_ORDER',
      risk: 'D',
      sensitive_operation: 'delete',
      arguments_preview: '{"order_id":"private-order-1"}',
    };
    const message = ctx._connectorActionMessage(info);
    const details = ctx._connectorActionDetails(info);

    expect(message).toBe('connectors.action_confirm.connector: Shop\nconnectors.action_confirm.action: SHOP_DELETE_ORDER');
    expect(details).toBe('{"order_id":"private-order-1"}');
  });

  it('closes a main-cancelled Agent install dialog without a stale response or funnel row', async () => {
    const invoke = vi.fn(async () => ({ handled: true }));
    const ctx = loadConnectorsRenderer(
      invoke,
      async (args) => new Promise<boolean>((resolve) => {
        args.signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
    );

    ctx.__emitPush('connectors:install-confirm', {
      request_id: 'cancelled-install',
      display_name: 'Private Server',
      summary: 'private command',
      kind: 'stdio',
    });
    await Promise.resolve();
    ctx.__emitPush('connectors:install-confirm-cancelled', {
      request_ids: ['cancelled-install'],
      cid: 'c1',
    });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(invoke).not.toHaveBeenCalled();
    expect(ctx.__events).toEqual([]);
    expect(vm.runInContext('_connectorInstallDialogOpen', ctx)).toBe(false);
  });

  it('still renders a genuinely connected card as connected', () => {
    // Guard against over-correcting: a healthy connector must keep the account line (and its green
    // dot) and the "使用" action.
    const ctx = loadConnectorsRenderer();
    const healthy = {
      id: 'gsearch-console',
      display_name: 'Google Search Console',
      status: { kind: 'connected', since: Date.now() },
      enabled: true,
      oauth_grant: { account_label: 'cxw@example.com' },
      tools_cache: [],
    };
    const card = ctx._renderCatalogCard(GSC_ENTRY, healthy);

    expect(card.className).not.toContain('is-unverified');
    expect(card.innerHTML).toContain('connector-card-account');
    expect(card.innerHTML).not.toContain('connector-card-unverified');
    expect(card.innerHTML).toContain('data-act="use-connector"');
  });

  it('marks a bundle unverified when any member is degraded', () => {
    const ctx = loadConnectorsRenderer();
    ctx.__setInstances([
      { id: 'gmail', display_name: 'Gmail', status: { kind: 'connected', since: Date.now() }, enabled: true, tools_cache: [] },
      degradedGscInstance(Date.now() - 2 * 60 * 60 * 1000),
    ]);
    const bundle = ctx._deriveBundleInstance({
      id: 'google-bundle',
      display_name: 'Google',
      bundle_member_ids: ['gmail', 'gsearch-console'],
    });

    // One member that cannot reach its backend makes the whole bundle card unverified — claiming
    // "已连接" for the bundle would be the same lie at bundle scope.
    expect(bundle.status.kind).toBe('degraded');
    expect(bundle.status.message).toContain('503');
  });

  it('fans a degraded bundle retry out to its real member instances', async () => {
    const invoke = vi.fn(async (channel: string, payload: any) => {
      if (channel === 'connectors.refresh') {
        return { ok: true, instance: { id: payload.id, status: { kind: 'connected', since: 1 } } };
      }
      if (channel === 'connectors.catalog') return { ok: true, catalog: [] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);
    const entry = {
      id: 'google-bundle',
      display_name: 'Google',
      bundle_member_ids: ['gmail', 'gsearch-console'],
    };

    await ctx._retryConnect(entry, 'connector_degraded_retry');

    const refreshIds = invoke.mock.calls
      .filter(([channel]) => channel === 'connectors.refresh')
      .map(([, payload]) => payload.id);
    expect(refreshIds).toEqual(['gmail', 'gsearch-console']);
    expect(ctx.__alerts).toEqual([]);
  });

  it('reports retry failure when IPC succeeds but the latest status is still degraded', async () => {
    const invoke = vi.fn(async (channel: string, payload: any) => {
      if (channel === 'connectors.refresh') {
        return {
          ok: true,
          instance: { id: payload.id, status: { kind: 'degraded', message: 'fetch failed', at: 1 } },
        };
      }
      if (channel === 'connectors.catalog') return { ok: true, catalog: [] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);

    await ctx._retryConnect({ id: 'gsearch-console', display_name: 'GSC' }, 'connector_degraded_retry');

    expect(ctx.__alerts).toHaveLength(1);
  });

  it('handles an asynchronous OAuth transport failure without a duplicate alert', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.start_oauth') {
        return { ok: true, started: true, attempt_id: 'attempt-notion' };
      }
      if (channel === 'connectors.catalog') return { ok: true, catalog: [] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);

    await ctx._runConnect({ id: 'notion', display_name: 'Notion' });
    expect(ctx.__events.filter(([name]: [string]) => name === 'connector_connect_result')).toEqual([]);
    ctx.__emitPush('connectors:oauth-callback', {
      attempt_id: 'attempt-notion',
      catalog_id: 'notion',
    });
    ctx.__emitPush('connectors:oauth-result', {
      attempt_id: 'attempt-notion',
      catalog_id: 'notion',
      result: 'failure',
      code: 'mcp_connect_failed',
      error: 'fetch failed',
      duration_ms: 12,
    });

    expect(ctx.__events).toEqual([]);
    expect(ctx.__errors).toEqual([]);
    expect(ctx.__alerts).toEqual([]);
  });

  it.each([
    { id: 'github', display_name: 'GitHub', auth_mode: 'server_bridge' },
    { id: 'dingtalk', display_name: 'DingTalk', auth_mode: 'local_cli' },
    { id: 'feishu', display_name: 'Feishu', auth_mode: 'local_cli' },
    { id: 'wecom', display_name: 'WeCom', auth_mode: 'local_cli' },
  ])('keeps $id connect available on startup despite a persisted connecting status', async (entry) => {
    const instance = { id: entry.id, status: { kind: 'connecting' } };
    const invoke = vi.fn(async (channel: string) => channel === 'connectors.catalog'
      ? { ok: true, catalog: [entry] }
      : { ok: true, instances: [instance] });
    const ctx = loadConnectorsRenderer(invoke);
    await ctx.loadConnectors();
    const restarted = loadConnectorsRenderer();
    const cacheKey = ctx._connectorsRenderCacheKey();
    restarted.localStorage.setItem(cacheKey, ctx.localStorage.getItem(cacheKey));
    expect(restarted._hydrateConnectorsRenderCache()).toBe(true);

    // Both the live list and the next launch's first-paint cache describe stored state,
    // not an authorization attempt in this renderer session.
    for (const surface of [ctx, restarted]) {
      surface.__emitPush('connectors:oauth-callback', {
        attempt_id: 'previous-session', catalog_id: entry.id,
      });
      const card = surface._renderCatalogCard(entry, surface._instanceById(entry.id)).innerHTML;
      expect(card).toContain('data-act="connect"');
      expect(card).toContain('>connectors.action.connect</button>');
      expect(card).not.toContain('is-loading');
      expect(card).not.toContain('disabled');
      expect(card).not.toContain('aria-busy="true"');
      expect(card).not.toContain('data-act="use-connector"');
      expect(surface.isConnectorLive(entry.id)).toBe(false);
    }
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['connectors.catalog', 'connectors.list']);

    const ready = { ...instance, status: { kind: 'connected' } };
    ctx.__setInstances([ready]);
    expect(ctx._renderCatalogCard(entry, ready).innerHTML).not.toContain('is-loading');
    expect(ctx._renderCatalogCard(entry, ready).innerHTML).toContain('data-act="use-connector"');
    expect(ctx.isConnectorLive(entry.id)).toBe(true);

    const failed = { ...instance, status: { kind: 'error', message: 'connection failed' } };
    ctx.__setInstances([failed]);
    const failureCard = ctx._renderCatalogCard(entry, failed);
    expect(failureCard.innerHTML).not.toContain('is-loading');
    expect(failureCard.innerHTML).not.toContain('data-act="use-connector"');
    if (entry.auth_mode === 'local_cli') {
      expect(failureCard.innerHTML).not.toContain('connector-card-error');
      expect(failureCard.innerHTML).toContain('>connectors.action.connect</button>');
    } else {
      expect(failureCard.querySelector('.connector-card-error').textContent).toContain('connectors.status.error');
    }
    expect(ctx.isConnectorLive(entry.id)).toBe(false);
  });

  it('leaves an unfinished DingTalk setup available after restart and reports a new failure once', async () => {
    const entry = {
      id: 'dingtalk', display_name: 'DingTalk', auth_mode: 'local_cli',
      local_cli: { executable: 'dws' },
    };
    let instance: any = {
      id: entry.id, tools_cache: [], tools_cached_at: 0,
      status: { kind: 'error', message: 'connection failed' },
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.catalog') return { ok: true, catalog: [entry] };
      if (channel === 'connectors.list') return { ok: true, instances: [instance] };
      if (channel === 'connectors.local_cli_status') return { ok: true, status: { installed: true } };
      return { ok: true, started: true, attempt_id: 'dingtalk-retry' };
    });
    const ctx = loadConnectorsRenderer(invoke);
    const card = () => ctx._renderCatalogCard(entry, ctx._instanceById(entry.id)).innerHTML;
    await ctx.loadConnectors();
    expect(card()).toContain('>connectors.action.connect</button>');
    expect(card()).not.toContain('connector-card-error');
    expect(ctx.__alerts).toEqual([]);

    await ctx._runConnect(entry);
    expect(card()).toContain('is-loading');
    expect(card()).not.toContain('connector-card-error');
    const failure = {
      attempt_id: 'dingtalk-retry', catalog_id: entry.id,
      result: 'failure', code: 'mcp_connect_failed', error: 'connection failed',
    };
    ctx.__emitPush('connectors:oauth-result', failure);
    ctx.__emitPush('connectors:oauth-result', failure);
    await ctx.loadConnectors();
    expect(ctx.__alerts).toHaveLength(1);
    expect(card()).not.toContain('is-loading');
    expect(card()).not.toContain('connector-card-error');
    expect(card()).toContain('>connectors.action.connect</button>');

    // A previously usable connector losing access remains a real service error.
    instance = { ...instance, tools_cached_at: 1, tools_cache: [{ name: 'execute_read' }] };
    await ctx.loadConnectors();
    expect(card()).toContain('connector-card-error');
    expect(ctx.isConnectorLive(entry.id)).toBe(false);
  });

  it('reports success only after the asynchronous callback provisions the connector', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.start_oauth') {
        return { ok: true, started: true, attempt_id: 'attempt-success' };
      }
      if (channel === 'connectors.catalog') return { ok: true, catalog: [] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);

    const entry = { id: 'github', display_name: 'GitHub' };
    await ctx._runConnect(entry);
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('is-loading');
    expect(ctx.__events.filter(([name]: [string]) => name === 'connector_connect_result')).toEqual([]);

    ctx.__emitPush('connectors:oauth-result', {
      attempt_id: 'attempt-success',
      catalog_id: 'github',
      result: 'success',
      duration_ms: 18,
    });

    expect(ctx.__events).toEqual([]);
    expect(ctx.__errors).toEqual([]);
    expect(ctx.__alerts).toEqual([]);
    expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('is-loading');
  });

  it.each([
    { id: 'github', display_name: 'GitHub', auth_mode: 'server_bridge' },
    { id: 'dingtalk', display_name: 'DingTalk', auth_mode: 'local_cli', local_cli: { executable: 'dws' } },
    { id: 'feishu', display_name: 'Feishu', auth_mode: 'local_cli', local_cli: { executable: 'lark-cli' } },
    { id: 'wecom', display_name: 'WeCom', auth_mode: 'local_cli', local_cli: { executable: 'wecom-cli' } },
  ])('tracks $id loading through user launch, blur, authorization callback and completion', async (entry) => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.local_cli_status') {
        return { ok: true, status: { installed: true, runtime_ready: true } };
      }
      if (channel === 'connectors.start_oauth') {
        return { ok: true, started: true, attempt_id: 'attempt-loading' };
      }
      if (channel === 'connectors.catalog') return { ok: true, catalog: [] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);

    await ctx._runConnect(entry);
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('is-loading');
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('disabled');

    // Opening the system browser moves focus away from Orkas. Only the short launch spinner is
    // cleared; the accepted attempt remains correlated for callback/result telemetry.
    ctx.__emitWindow('blur');
    expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('is-loading');

    ctx.__emitPush('connectors:oauth-callback', {
      attempt_id: 'attempt-loading',
      catalog_id: entry.id,
    });
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('is-loading');
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('connectors.action.connecting');
    ctx.__advanceTimers(2000);
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('is-loading');

    // A stale terminal event must not clear the active callback's feedback.
    ctx.__emitPush('connectors:oauth-result', {
      attempt_id: 'older-attempt',
      catalog_id: entry.id,
      result: 'cancelled',
      code: 'superseded',
      duration_ms: 1,
    });
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('is-loading');

    ctx.__emitPush('connectors:oauth-result', {
      attempt_id: 'attempt-loading',
      catalog_id: entry.id,
      result: 'success',
      duration_ms: 18,
    });
    expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('is-loading');
    expect(ctx.__events).toEqual([]);
  });

  it('throttles clicks for two seconds while keeping launch loading visible until window blur', async () => {
    const resolveStarts: Array<(value: unknown) => void> = [];
    const invoke = vi.fn((channel: string) => {
      if (channel === 'connectors.start_oauth') {
        return new Promise((resolve) => { resolveStarts.push(resolve); });
      }
      return Promise.resolve({ ok: true });
    });
    const ctx = loadConnectorsRenderer(invoke);
    const entry = { id: 'gmail', display_name: 'Gmail' };

    const first = ctx._runConnect(entry);
    const second = ctx._runConnect(entry);

    expect(invoke.mock.calls.filter(([channel]) => channel === 'connectors.start_oauth')).toHaveLength(1);
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('aria-busy="true"');

    ctx.__advanceTimers(1999);
    await ctx._runConnect(entry);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'connectors.start_oauth')).toHaveLength(1);

    ctx.__advanceTimers(1);
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('is-loading');
    expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('disabled');
    const retry = ctx._runConnect(entry);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'connectors.start_oauth')).toHaveLength(2);
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('aria-busy="true"');

    resolveStarts[0]({ ok: true, started: true, attempt_id: 'attempt-old' });
    resolveStarts[1]({ ok: true, started: true, attempt_id: 'attempt-retry' });
    await Promise.all([first, second, retry]);

    ctx.__advanceTimers(2000);
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('is-loading');
    expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('disabled');
    ctx.__emitWindow('blur');
    expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('is-loading');
  });

  it('reports an asynchronous user cancellation without an error or alert', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.start_oauth') {
        return { ok: true, started: true, attempt_id: 'attempt-github' };
      }
      if (channel === 'connectors.catalog') return { ok: true, catalog: [] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);

    await ctx._runConnect({ id: 'github', display_name: 'GitHub' });
    ctx.__emitPush('connectors:oauth-result', {
      attempt_id: 'attempt-github',
      catalog_id: 'github',
      result: 'cancelled',
      code: 'user_cancelled',
      error: 'provider canceled authorization',
      duration_ms: 12,
    });

    expect(ctx.__events).toEqual([]);
    expect(ctx.__errors).toEqual([]);
    expect(ctx.__alerts).toEqual([]);
  });

  it('keeps a cancellation silent when the IPC wrapper only preserves E_UNKNOWN', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.start_oauth') {
        return { ok: false, code: 'E_UNKNOWN', error: 'connector flow cancelled' };
      }
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);

    await ctx._runConnect({ id: 'github', display_name: 'GitHub' });

    expect(ctx.__events).toEqual([]);
    expect(ctx.__errors).toEqual([]);
    expect(ctx.__alerts).toEqual([]);
  });

  it('accepts the browser launch without fabricating a timeout result when no callback arrives', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.start_oauth') {
        return { ok: true, started: true, attempt_id: 'attempt-abandoned' };
      }
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);

    await ctx._runConnect({ id: 'github', display_name: 'GitHub' });

    expect(ctx.__events.filter(([name]: [string]) => name === 'connector_connect_result')).toEqual([]);
    expect(ctx.__events.filter(([name]: [string]) => name === 'connector_connect_request_result')).toEqual([]);
    expect(ctx.__errors).toEqual([]);
    expect(ctx.__alerts).toEqual([]);
  });

  it('surfaces an empty OAuth response as a launch failure', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.start_oauth') return undefined;
      if (channel === 'connectors.catalog') return { ok: true, catalog: [] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);

    const entry = { id: 'github', display_name: 'GitHub' };
    await ctx._runConnect(entry);

    expect(ctx.__events).toEqual([]);
    expect(ctx.__errors).toEqual([]);
    expect(ctx.__alerts).toHaveLength(1);
    expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('is-loading');
  });

  it('reconnects an installed PayPal Sandbox grant without switching to production or offering an environment choice', async () => {
    const calls: Array<[string, any]> = [];
    const invoke = vi.fn(async (channel: string, payload: any) => {
      calls.push([channel, payload]);
      if (channel === 'connectors.start_oauth') {
        return { ok: true, started: true, attempt_id: 'attempt-paypal-sandbox' };
      }
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);
    const { REMOTE_COMMERCE_ENTRIES } = await import('../../src/main/features/connectors/catalog-remote-commerce');
    const parent = REMOTE_COMMERCE_ENTRIES.find(entry => entry.id === 'paypal')!;
    const sandbox = REMOTE_COMMERCE_ENTRIES.find(entry => entry.id === 'paypal-sandbox')!;
    ctx.__setCatalog([parent, sandbox]);
    ctx.__setInstances([{ id: 'paypal-sandbox', status: { kind: 'error', message: 'connector_reconnect_required' } }]);

    await ctx._runConnect(parent);

    expect(calls).toContainEqual([
      'connectors.start_oauth',
      { catalog_id: 'paypal-sandbox' },
    ]);
    expect(ctx.__choices).toEqual([]);
    expect(ctx._catalogUiId('paypal-sandbox')).toBe('paypal');
    ctx.__emitPush('connectors:oauth-callback', {
      attempt_id: 'attempt-paypal-sandbox',
      catalog_id: 'paypal-sandbox',
    });
    expect(ctx._renderCatalogCard(parent, null).innerHTML).toContain('is-loading');

    ctx.__setInstances([{
      id: 'paypal-sandbox',
      display_name: 'PayPal Sandbox',
      status: { kind: 'connected', since: 1 },
    }]);
    expect(ctx._instanceForCatalogEntry(parent)?.id).toBe('paypal-sandbox');
  });

  it('opens new PayPal production authorization directly without an environment dialog', async () => {
    const invoke = vi.fn(async () => ({ ok: true, started: true, attempt_id: 'paypal-production' }));
    const ctx = loadConnectorsRenderer(invoke);
    const { REMOTE_COMMERCE_ENTRIES } = await import('../../src/main/features/connectors/catalog-remote-commerce');
    ctx.__setCatalog(REMOTE_COMMERCE_ENTRIES);
    await ctx._runConnect(REMOTE_COMMERCE_ENTRIES.find(entry => entry.id === 'paypal'));
    expect(ctx.__choices).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('connectors.start_oauth', { catalog_id: 'paypal' });
  });

  it('keeps a failed local sandbox connection recoverable without submitting production credentials', async () => {
    const invoke = vi.fn();
    const ctx = loadConnectorsRenderer(invoke);
    const { DIRECT_COMMERCE_ENTRIES } = await import('../../src/main/features/connectors/catalog-direct-commerce');
    const entry = DIRECT_COMMERCE_ENTRIES.find(row => row.id === 'square')!;
    const existing = { id: 'square', connection_environment: 'sandbox', status: { kind: 'error', message: 'connector_reconnect_required' } };
    ctx.__setCatalog([entry]);
    ctx.__setInstances([existing]);
    const html = ctx._renderCatalogCard(entry, existing).innerHTML;
    expect(html).toContain('data-act="disconnect"');
    expect(html).not.toContain('data-act="connect"');
    await ctx._runConnect(entry);
    expect(ctx.__alerts).toContain('connectors.setup.sandbox_disconnect_required');
    expect(invoke).not.toHaveBeenCalled();
    expect(ctx._formatConnectError({ code: 'connector_sandbox_disconnect_required' }))
      .toBe('connectors.setup.sandbox_disconnect_required');
    expect(ctx._formatConnectError({ code: 'connector_production_only' })).toBe('connectors.setup.production_only');
  });

  it('uses one localized Feishu/Lark connector and lets the official CLI detect the tenant edition', async () => {
    const calls: Array<[string, any]> = [];
    const invoke = vi.fn(async (channel: string, payload: any) => {
      calls.push([channel, payload]);
      if (channel === 'connectors.local_cli_status') {
        return { ok: true, status: { installed: true, runtime_ready: true } };
      }
      if (channel === 'connectors.start_oauth') {
        return { ok: true, started: true, attempt_id: 'attempt-feishu' };
      }
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);
    const parent = {
      id: 'feishu',
      display_name: '飞书',
      display_name_zh: '飞书',
      display_name_en: 'Lark',
      auth_mode: 'local_cli',
      local_cli: { executable: 'lark-cli', package_version: '1.0.93' },
    };
    ctx.__setCatalog([parent]);
    ctx.uiChoice = vi.fn();

    await ctx._runConnect(parent);

    expect(ctx.uiChoice).not.toHaveBeenCalled();
    expect(calls).toContainEqual(['connectors.start_oauth', { catalog_id: 'feishu' }]);
  });

  it('keeps a legacy standalone Lark instance on the unified connector card', () => {
    const ctx = loadConnectorsRenderer();
    const parent = { id: 'feishu', display_name: '飞书' };
    const legacy = { id: 'lark', display_name: 'Lark', catalog_parent_id: 'feishu' };
    ctx.__setCatalog([parent, legacy]);
    ctx.__setInstances([{ id: 'lark', status: { kind: 'connected', since: 1 } }]);

    expect(ctx._instanceForCatalogEntry(parent)?.id).toBe('lark');
    expect(ctx._connectorMatchesSearch(parent, 'lark')).toBe(true);
  });

  it('renders English domestic connector brands in every non-Chinese locale', () => {
    const ctx = loadConnectorsRenderer();
    const entries = [
      { id: 'wecom', display_name: '企业微信', display_name_zh: '企业微信', display_name_en: 'WeCom' },
      { id: 'feishu', display_name: '飞书', display_name_zh: '飞书', display_name_en: 'Lark' },
      { id: 'dingtalk', display_name: '钉钉', display_name_zh: '钉钉', display_name_en: 'DingTalk' },
    ];

    for (const locale of ['en', 'ja', 'pt']) {
      ctx.getLang = () => locale;
      expect(entries.map((entry) => ctx._renderCatalogCard(entry, null)
        .querySelector('.connector-card-name').textContent)).toEqual(['WeCom', 'Lark', 'DingTalk']);
    }
  });

  it('installs once without confirmation, shows Installing, then continues authorization', async () => {
    let finishInstall!: (value: any) => void;
    const installResult = new Promise((resolve) => { finishInstall = resolve; });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.local_cli_status') {
        return { ok: true, status: { installed: false, runtime_ready: true } };
      }
      if (channel === 'connectors.install_local_cli') return installResult;
      if (channel === 'connectors.start_oauth') {
        return { ok: true, started: true, attempt_id: 'attempt-dingtalk' };
      }
      return { ok: true };
    });
    const confirm = vi.fn(async () => false);
    const ctx = loadConnectorsRenderer(invoke, confirm);
    const entry = {
      id: 'dingtalk',
      display_name: '钉钉',
      display_name_en: 'DingTalk',
      auth_mode: 'local_cli',
      local_cli: { executable: 'dws', package_version: '1.0.61' },
    };

    const pending = ctx._runConnect(entry);
    await new Promise((resolve) => setImmediate(resolve));
    expect(confirm).not.toHaveBeenCalled();
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('connectors.action.installing');
    expect(ctx._renderCatalogCard(entry, null).innerHTML).toContain('disabled');
    expect(invoke.mock.calls.filter(([channel]) => channel === 'connectors.start_oauth')).toHaveLength(0);
    await ctx._runConnect(entry);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'connectors.install_local_cli')).toHaveLength(1);

    finishInstall({ ok: true, status: { installed: true, runtime_ready: true } });
    await pending;
    expect(invoke).toHaveBeenCalledWith('connectors.start_oauth', { catalog_id: 'dingtalk' });
    expect(confirm).not.toHaveBeenCalled();
    expect(ctx.__alerts).toEqual([]);
  });

  it('continues authorization directly when the required CLI is already installed', async () => {
    const invoke = vi.fn(async (channel: string) => channel === 'connectors.local_cli_status'
      ? { ok: true, status: { installed: true, runtime_ready: true } }
      : { ok: true, started: true, attempt_id: 'existing-cli' });
    const confirm = vi.fn(async () => false);
    const ctx = loadConnectorsRenderer(invoke, confirm);
    await ctx._runConnect({ id: 'feishu', auth_mode: 'local_cli', local_cli: { executable: 'lark-cli' } });
    expect(confirm).not.toHaveBeenCalled();
    expect(ctx.__errors).toEqual([]);
    expect(ctx.__alerts).toEqual([]);
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['connectors.local_cli_status', 'connectors.start_oauth']);
  });

  it('does not duplicate main-owned authorization results or expose private error text', () => {
    const ctx = loadConnectorsRenderer();
    ctx.__emitPush('connectors:oauth-result', {
      attempt_id: 'main-owned', catalog_id: 'shopee', result: 'failure',
      code: 'seller_shop_mismatch', error: 'private_shop_canary', telemetry_reported: true,
    });
    expect(ctx.__events.filter(([name]: [string]) => name === 'connector_connect_result')).toEqual([]);
    expect(ctx.__alerts).toEqual(['connectors.seller.shop_mismatch']);
    expect(JSON.stringify(ctx.__events)).not.toContain('private_shop_canary');
  });

  it('keeps a safe install error on the card and offers retry', async () => {
    let failInstall = true;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.local_cli_status') {
        return { ok: true, status: { installed: false, runtime_ready: true } };
      }
      if (channel === 'connectors.install_local_cli') {
        return failInstall
          ? { ok: false, code: 'local_cli_install_registry_unavailable', error: 'hidden raw output' }
          : { ok: true, status: { installed: true, runtime_ready: true } };
      }
      if (channel === 'connectors.start_oauth') return { ok: true, started: true, attempt_id: 'retry-cli' };
      return { ok: true };
    });
    const ctx = loadConnectorsRenderer(invoke);
    const entry = {
      id: 'wecom',
      display_name: '企业微信',
      display_name_en: 'WeCom',
      auth_mode: 'local_cli',
      local_cli: { executable: 'wecom-cli', package_version: '1.2.0' },
    };

    await ctx._runConnect(entry);

    const card = ctx._renderCatalogCard(entry, null);
    expect(card.innerHTML).toContain('connectors.action.retry_install');
    expect(card.querySelector('.connector-card-error').textContent)
      .toBe('connectors.local_cli.install_registry_unavailable');
    expect(ctx.__alerts).toEqual(['connectors.local_cli.install_registry_unavailable']);
    expect(JSON.stringify(ctx.__events)).not.toContain('hidden raw output');
    expect(invoke.mock.calls.filter(([channel]) => channel === 'connectors.start_oauth')).toHaveLength(0);

    failInstall = false;
    await ctx._runConnect(entry);
    expect(invoke).toHaveBeenCalledWith('connectors.start_oauth', { catalog_id: 'wecom' });
    expect(ctx._renderCatalogCard(entry, null).innerHTML).not.toContain('connector-card-error');
    expect(ctx.__alerts).toHaveLength(1);
  });

  it('searches localized names, descriptions, ids, and hidden bundle members', () => {
    const ctx = loadConnectorsRenderer();
    const gmail = {
      id: 'gmail',
      display_name: 'Gmail',
      description_zh: '读取和发送邮件',
      description_en: 'Read and send email',
    };
    const workspace = {
      id: 'google-workspace',
      display_name: 'Google Workspace',
      description_zh: '谷歌工作套件',
      description_en: 'Google productivity suite',
      bundle_member_ids: ['gmail'],
    };
    ctx.__setCatalog([workspace, gmail]);

    expect(ctx._connectorMatchesSearch(workspace, '谷歌')).toBe(true);
    expect(ctx._connectorMatchesSearch(workspace, 'productivity suite')).toBe(true);
    expect(ctx._connectorMatchesSearch(workspace, 'google-workspace')).toBe(true);
    expect(ctx._connectorMatchesSearch(workspace, '发送邮件')).toBe(true);
    expect(ctx._connectorMatchesSearch(workspace, 'shopify')).toBe(false);
  });

  it('filters the visible groups as the connector search input changes', () => {
    const ctx = loadConnectorsRenderer();
    const ids = [
      'connectors-grid-view', 'connectors-group-connected', 'connectors-group-available',
      'connectors-grid-connected', 'connectors-grid-available', 'connectors-empty',
      'connectors-group-connected-count', 'connectors-group-available-count',
    ];
    const elements = new Map(ids.map((id) => [id, makeElement('div')]));
    const search = makeElement('input');
    let onInput = () => {};
    search.value = '';
    search.addEventListener = (name: string, handler: () => void) => {
      if (name === 'input') onInput = handler;
    };
    elements.set('connectors-search-input', search);
    ctx.document.getElementById = (id: string) => elements.get(id) || null;
    ctx.__setCatalog([
      { id: 'shopify-admin', display_name: 'Shopify Admin', description_zh: '管理商店商品和订单' },
      { id: 'netsuite', display_name: 'Oracle NetSuite', description_zh: '管理 ERP 数据' },
    ]);

    ctx._renderConnectorsGrid();
    expect(elements.get('connectors-group-available-count')!.textContent).toBe('2');

    search.value = 'shopify';
    onInput();
    expect(elements.get('connectors-group-available-count')!.textContent).toBe('1');

    search.value = '不存在';
    onInput();
    expect(elements.get('connectors-group-available')!.style.display).toBe('none');
    expect(elements.get('connectors-empty')!.textContent).toBe('connectors.search.empty');
  });

  it('renders every setup field in one form and masks secret values', () => {
    const ctx = loadConnectorsRenderer();
    const entry = {
      id: 'shopify-admin',
      display_name: 'Shopify Admin',
    };
    const fields = [
      { key: 'shop_domain', input: 'text', required: true, label_zh: '商店域名' },
      { key: 'client_id', input: 'text', required: true, label_zh: '应用 Client ID' },
      { key: 'client_secret', input: 'secret', required: true, label_zh: '应用 Client Secret', help_zh: '仅加密保存在本机。' },
      {
        key: 'environment', input: 'choice', required: true, label_zh: '环境',
        options: [{ value: 'live', label_zh: '正式环境' }],
      },
    ];

    const markup = ctx._connectorSetupMarkup(entry, fields, 'zh', 'dialog-1');

    expect(markup.match(/data-connector-field/g)).toHaveLength(4);
    expect(markup).toContain('data-act="setup-form"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('应用 Client Secret');
    expect(markup).toContain('<select');
    expect(markup).toContain('value="live"');
  });

  it('renders real user-app fields, guidance and a read-only callback in all four languages', async () => {
    const { DIRECT_COMMERCE_ENTRIES } = await import('../../src/main/features/connectors/catalog-direct-commerce');
    const ctx = loadConnectorsRenderer();
    for (const entry of DIRECT_COMMERCE_ENTRIES.filter(row => row.connection_setup?.requirement)) {
      const setup = entry.connection_setup!;
      for (const lang of ['zh', 'en', 'ja', 'pt'] as const) {
        const html = ctx._connectorSetupMarkup(entry, setup.fields, lang, 'app-dialog');
        expect(html.match(/data-connector-field/g), entry.id).toHaveLength(setup.fields.length);
        expect(html.match(/<form /g)).toHaveLength(1);
        expect(html).toContain('connectors.setup.user_app_message');
        expect(setup.fields.filter(field => field.storage === 'credential').every(field => field.help_zh && field.help_en), entry.id)
          .toBe(true);
        expect(html).toContain(ctx.escapeHtml(setup[`instructions_${lang}`]!));
        expect(html).toContain('data-act="open-setup-guide"');
        expect(html.includes('data-act="copy-setup-callback"')).toBe(Boolean(setup.callback_url));
        if (setup.callback_url) {
          expect(html).toContain('readonly value="https://orkas.ai/api/connectors/oauth/dcr-callback"');
          expect(html).toMatch(/class="connectors-setup-callback-row">\s*<input[^>]+readonly[^>]*\/>\s*<button[^>]+type="button"[^>]+aria-label="connectors.setup.copy_callback"[^>]*>common.copy<\/button>\s*<\/div>/);
          expect(html).toContain(ctx.escapeHtml(setup[`callback_help_${lang}`]!));
          expect(html).not.toContain('data-field-index="redirect_uri"');
        }
      }
    }
  });

  it('does not show the local-only app credential notice for hosted DCR or webhook setup', () => {
    const ctx = loadConnectorsRenderer();
    for (const entry of [
      { id: 'netsuite', auth_mode: 'mcp_dcr' },
      { id: 'kofi', auth_mode: 'local_api', local_api: { provider: 'kofi' } },
    ]) {
      const html = ctx._connectorSetupMarkup(entry, [], 'en', 'dialog-privacy');
      expect(html).toContain('connectors.setup.form_message');
      expect(html).not.toContain('connectors.setup.user_app_message');
    }
  });

  it('copies the fixed callback, reports clipboard failure, and excludes it from submitted credentials', async () => {
    const ctx = loadConnectorsRenderer();
    const callbackUrl = 'https://orkas.ai/api/connectors/oauth/dcr-callback';
    const entry = { id: 'taobao-tmall-seller', connection_setup: {
      callback_url: callbackUrl, fields: [{ key: 'app_key', input: 'text', required: true }],
    } };
    const listeners = new Map<string, (event?: any) => any>();
    const status = { textContent: '' };
    const control = { dataset: { fieldIndex: '0' }, value: 'my-app', focus: vi.fn() };
    const form = { reportValidity: () => true, addEventListener: (name: string, fn: any) => listeners.set(name, fn) };
    const cancel = { focus: vi.fn(), addEventListener: vi.fn() };
    const copy = { addEventListener: (name: string, fn: any) => listeners.set('copy:' + name, fn) };
    const elements: Record<string, any> = {
      '[data-act="setup-form"]': form, '[data-act="cancel"]': cancel,
      '[data-act="copy-setup-callback"]': copy, '[data-act="callback-copy-status"]': status,
    };
    const overlay: any = { innerHTML: '', querySelector: (key: string) => elements[key] || null,
      querySelectorAll: () => [control], remove: vi.fn() };
    ctx.document.createElement = () => overlay;
    ctx._uiNextDialogId = () => 'app-dialog';
    ctx._uiKeepDialogFocus = () => () => {};
    ctx._uiIsTopDialogOverlay = () => true;
    ctx._uiRestoreDialogFocus = () => {};
    ctx.navigator = { clipboard: { writeText: vi.fn(async () => undefined) } };
    const result = ctx._collectConnectionParameters(entry);
    await listeners.get('copy:click')!();
    expect(ctx.navigator.clipboard.writeText).toHaveBeenCalledWith(callbackUrl);
    expect(status.textContent).toBe('chat.copy_done');
    ctx.navigator.clipboard.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await listeners.get('copy:click')!();
    expect(status.textContent).toBe('connectors.setup.copy_callback_failed');
    expect(overlay.remove).not.toHaveBeenCalled();
    listeners.get('submit')!({ preventDefault: vi.fn() });
    await expect(result).resolves.toEqual({ app_key: 'my-app' });
  });

  it('shows Douyin prerequisites and opens the first-party setup guide through guarded IPC', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const ctx = loadConnectorsRenderer(invoke);
    const fields = [{ key: 'shop_id', input: 'text', required: true, label_zh: '店铺 ID' }];
    const entry = {
      id: 'douyin-shop-seller', display_name: 'Douyin Shop Seller',
      connection_setup: {
        instructions_zh: '先完成自用型应用审核和店铺授权；Orkas 自动刷新令牌。',
        instructions_en: 'Complete app review and shop authorization first.',
        guide_url: 'https://op.jinritemai.com/docs/guide-docs/140/583',
        guide_label_zh: '查看官方入驻指南',
        guide_label_en: 'Open official onboarding guide',
        fields,
      },
    };
    const markup = ctx._connectorSetupMarkup(entry, fields, 'zh', 'dialog-douyin');
    expect(markup).toContain('先完成自用型应用审核和店铺授权');
    expect(markup).toContain('data-act="open-setup-guide"');
    expect(markup).toContain('https://op.jinritemai.com/docs/guide-docs/140/583');

    const controls = [{ dataset: { fieldIndex: '0' }, value: '700000000000000001', focus: vi.fn() }];
    const formListeners = new Map<string, (event?: any) => void>();
    const guideListeners = new Map<string, (event?: any) => void>();
    const form = { addEventListener: (name: string, fn: any) => formListeners.set(name, fn), reportValidity: () => true };
    const cancel = { addEventListener: vi.fn(), focus: vi.fn() };
    const guide = {
      dataset: { url: 'https://op.jinritemai.com/docs/guide-docs/140/583' },
      addEventListener: (name: string, fn: any) => guideListeners.set(name, fn),
    };
    const overlay: any = {
      id: '', className: '', innerHTML: '',
      querySelector: (selector: string) => selector === '[data-act="setup-form"]' ? form
        : selector === '[data-act="open-setup-guide"]' ? guide : cancel,
      querySelectorAll: () => controls,
      remove: vi.fn(),
    };
    ctx.document.createElement = () => overlay;
    ctx.document.body.appendChild = vi.fn();
    ctx.document.body.contains = () => true;
    ctx._uiNextDialogId = () => 'dialog-douyin';
    ctx._uiKeepDialogFocus = () => () => {};
    ctx._uiIsTopDialogOverlay = () => true;
    ctx._uiRestoreDialogFocus = () => {};

    const result = ctx._collectConnectionParameters(entry);
    guideListeners.get('click')!();
    expect(invoke).toHaveBeenCalledWith('auth.openExternal', {
      url: 'https://op.jinritemai.com/docs/guide-docs/140/583',
    });
    formListeners.get('submit')!({ preventDefault: vi.fn() });
    await expect(result).resolves.toEqual({ shop_id: '700000000000000001' });
  });

  it('validates once and returns all setup values from the combined panel', async () => {
    const ctx = loadConnectorsRenderer();
    const fields = [
      { key: 'shop_domain', input: 'text', required: true, label_zh: '商店域名' },
      { key: 'client_id', input: 'text', required: true, label_zh: 'Client ID' },
      { key: 'client_secret', input: 'secret', required: true, label_zh: 'Client Secret' },
    ];
    const controls = [
      { dataset: { fieldIndex: '0' }, value: 'shop.myshopify.com', focus: vi.fn() },
      { dataset: { fieldIndex: '1' }, value: 'client-id', focus: vi.fn() },
      { dataset: { fieldIndex: '2' }, value: 'client-secret', focus: vi.fn() },
    ];
    const listeners = new Map<string, (event?: any) => void>();
    let valid = false;
    let removed = false;
    const form = {
      addEventListener: (name: string, handler: (event?: any) => void) => listeners.set(name, handler),
      reportValidity: vi.fn(() => valid),
    };
    const cancel = {
      addEventListener: (name: string, handler: (event?: any) => void) => listeners.set(`cancel:${name}`, handler),
      focus: vi.fn(),
    };
    const overlay: any = {
      id: '', className: '', innerHTML: '',
      querySelector: (selector: string) => selector === '[data-act="setup-form"]' ? form : cancel,
      querySelectorAll: (selector: string) => selector === '[data-connector-field]' ? controls : [],
      remove: () => { removed = true; },
    };
    ctx.document.createElement = () => overlay;
    ctx.document.body.appendChild = vi.fn();
    ctx.document.body.contains = () => true;
    ctx._uiNextDialogId = () => 'dialog-setup';
    ctx._uiKeepDialogFocus = () => () => {};
    ctx._uiIsTopDialogOverlay = () => true;
    ctx._uiTrapDialogTab = () => false;
    ctx._uiRestoreDialogFocus = () => {};

    const resultPromise = ctx._collectConnectionParameters({
      id: 'shopify-admin', display_name: 'Shopify Admin', connection_setup: { fields },
    });
    const submit = listeners.get('submit')!;
    submit({ preventDefault: vi.fn() });
    expect(form.reportValidity).toHaveBeenCalledTimes(1);
    expect(removed).toBe(false);

    valid = true;
    submit({ preventDefault: vi.fn() });
    await expect(resultPromise).resolves.toEqual({
      shop_domain: 'shop.myshopify.com',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
    expect(removed).toBe(true);
  });

  it('collects the NetSuite account ID in one setup panel before starting OAuth', async () => {
    const invoke = vi.fn(async (channel: string) => channel === 'connectors.start_oauth'
      ? { ok: true, started: true, attempt_id: 'attempt-netsuite' }
      : { ok: true });
    const ctx = loadConnectorsRenderer(invoke);
    const entry = {
      id: 'netsuite',
      display_name: 'Oracle NetSuite',
      connection_setup: {
        fields: [{
          key: 'account_id',
          label_zh: 'NetSuite Account ID',
          label_en: 'NetSuite Account ID',
          help_zh: '管理员准备说明',
          help_en: 'Admin setup instructions',
        }],
      },
    };
    ctx.__setCatalog([entry]);
    ctx._collectConnectionParameters = vi.fn(async () => ({ account_id: '123456_SB1' }));

    await ctx._runConnect(entry);

    expect(ctx._collectConnectionParameters).toHaveBeenCalledTimes(1);
    expect(ctx._collectConnectionParameters).toHaveBeenCalledWith(entry);
    expect(ctx.__prompts).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('connectors.start_oauth', {
      catalog_id: 'netsuite',
      connection_parameters: { account_id: '123456_SB1' },
    });
  });

  it('submits direct-commerce choices and credentials together', async () => {
    const invoke = vi.fn(async (channel: string) => channel === 'connectors.start_oauth'
      ? { ok: true, started: true, attempt_id: 'attempt-reloadly' }
      : { ok: true });
    const ctx = loadConnectorsRenderer(invoke);
    const { DIRECT_COMMERCE_ENTRIES } = await import('../../src/main/features/connectors/catalog-direct-commerce');
    const entry = DIRECT_COMMERCE_ENTRIES.find(row => row.id === 'reloadly')!;
    ctx.__setCatalog([entry]);
    ctx._collectConnectionParameters = vi.fn(async () => ({
      product: 'giftcards',
      client_id: 'reloadly-client',
      client_secret: 'reloadly-secret',
    }));

    await ctx._runConnect(entry);

    expect(ctx._collectConnectionParameters).toHaveBeenCalledTimes(1);
    expect(ctx.__choices).toEqual([]);
    expect(ctx.__prompts).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('connectors.start_oauth', {
      catalog_id: 'reloadly',
      connection_parameters: {
        product: 'giftcards',
        client_id: 'reloadly-client', client_secret: 'reloadly-secret',
      },
    });
  });
});

describe('explicit connector failure codes', () => {
  it.each([
    [{ code: 'user_cancelled', error: 'User cancelled' }, false],
    [{ code: 'superseded', error: 'A newer request replaced it' }, false],
    [{ code: 'E_UNKNOWN', error: 'Operation canceled' }, false],
    [{ code: 'storage_unavailable', error: 'Storage failed after another request was cancelled' }, true],
    [{ code: 'invalid_grant', error: 'Previous operation canceled; grant invalid' }, true],
  ])('shows hard failures without mistaking incidental cancel text for user cancellation: %j', (error, shouldAlert) => {
    const context = loadConnectorsRenderer();
    context._handleConnectFailure({}, 0, error);
    expect(context.__alerts.length).toBe(shouldAlert ? 1 : 0);
    if (error.code === 'storage_unavailable') expect(context.__alerts[0]).toBe(context.t('connectors.errors.storage_unavailable'));
  });
});
