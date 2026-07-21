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

function loadConnectorsRenderer(
  invoke: (channel: string, payload: any) => Promise<any> = async () => ({ ok: true }),
) {
  const code = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/connectors.js'),
    'utf8',
  );
  const storage = new Map<string, string>();
  const alerts: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const errors: Array<[string, Record<string, unknown>]> = [];
  const pushHandlers = new Map<string, (payload: any) => void>();
  const monitor = {
    click: () => {},
    event: (name: string, data: Record<string, unknown>) => { events.push([name, data]); },
    error: (name: string, data: Record<string, unknown>) => { errors.push([name, data]); },
  };
  const context: any = {
    console,
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
      getElementById: () => null,
      querySelectorAll: () => [],
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1200,
      innerHeight: 800,
      Monitor: monitor,
      orkas: {
        invoke,
        onPushEvent: (channel: string, handler: (payload: any) => void) => { pushHandlers.set(channel, handler); },
      },
    },
    Monitor: monitor,
    uiAlert: (message: string) => { alerts.push(message); },
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
  context.__alerts = alerts;
  context.__events = events;
  context.__errors = errors;
  context.__emitPush = (channel: string, payload: any) => pushHandlers.get(channel)?.(payload);
  return context;
}

const GSC_ENTRY = { id: 'gsearch-console', display_name: 'Google Search Console', description_zh: 'GSC' };

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
    expect(line.textContent).toContain('503');

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

    await ctx._runConnect({ id: 'github', display_name: 'GitHub' });
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

    await ctx._runConnect({ id: 'github', display_name: 'GitHub' });

    expect(ctx.__events).toEqual([]);
    expect(ctx.__errors).toEqual([]);
    expect(ctx.__alerts).toHaveLength(1);
  });
});
