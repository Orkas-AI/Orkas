import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import {
  APP_NAV_ACTIONS,
  APP_NAV_SURFACES,
  appNavSurfaceDescription,
  findAppNavSurface,
  validateAppNavRequest,
} from '../../../../src/main/features/group_chat/app_nav';
import { SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS } from '../../../../src/core-agent/src/tools';

const RENDERER_CONVERSATION = path.join(
  __dirname, '..', '..', '..', '..', 'src', 'renderer', 'modules', 'conversation.js',
);
const RENDERER_CONNECTORS = path.join(
  __dirname, '..', '..', '..', '..', 'src', 'renderer', 'modules', 'connectors.js',
);
const RENDERER_AUTO = path.join(
  __dirname, '..', '..', '..', '..', 'src', 'renderer', 'modules', 'auto.js',
);
const RENDERER_PROJECTS = path.join(
  __dirname, '..', '..', '..', '..', 'src', 'renderer', 'modules', 'projects.js',
);
const RENDERER_STYLE = path.join(
  __dirname, '..', '..', '..', '..', 'src', 'renderer', 'style.css',
);

function extractAssignedAsyncFunction(source: string, marker: string): string {
  const markerAt = source.indexOf(marker);
  expect(markerAt, `${marker} must exist`).toBeGreaterThan(-1);
  const functionAt = source.indexOf('async function', markerAt);
  expect(functionAt).toBeGreaterThan(markerAt);
  const bodyAt = source.indexOf('{', functionAt);
  let depth = 0;
  for (let i = bodyAt; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(functionAt, i + 1);
    }
  }
  throw new Error(`unterminated assigned function: ${marker}`);
}

function rendererSurfaceIds(): string[] {
  const source = fs.readFileSync(RENDERER_CONVERSATION, 'utf8');
  const start = source.indexOf('const _APP_NAV_SURFACES = {');
  expect(start, 'renderer executor map _APP_NAV_SURFACES must exist in conversation.js').toBeGreaterThan(-1);
  const end = source.indexOf('\n};', start);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const ids: string[] = [];
  // Top-level executor keys only: quoted ('settings.models') or bare
  // (connectors) identifiers immediately followed by an object literal.
  for (const match of block.matchAll(/^\s{2}(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)):\s*\{/gm)) {
    ids.push(match[1] || match[2]!);
  }
  return ids;
}

function rendererSurfaceActions(): Record<string, string[]> {
  const source = fs.readFileSync(RENDERER_CONVERSATION, 'utf8');
  const start = source.indexOf('const _APP_NAV_SURFACES = {');
  const end = source.indexOf('\n};', start);
  const block = source.slice(start, end);
  const entries = [...block.matchAll(
    /^\s{2}(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)):\s*\{/gm,
  )];
  return Object.fromEntries(entries.map((entry, index) => {
    const id = entry[1] || entry[2]!;
    const body = block.slice(entry.index ?? 0, entries[index + 1]?.index ?? block.length);
    const actionList = body.match(/actions:\s*\[([^\]]*)\]/)?.[1] ?? '';
    return [id, [...actionList.matchAll(/'([^']+)'/g)].map((match) => match[1])];
  }));
}

function rendererNavHarness(failingFeature = '') {
  const source = fs.readFileSync(RENDERER_CONVERSATION, 'utf8');
  const start = source.indexOf('const _APP_NAV_SURFACES = {');
  const end = source.indexOf('function _mountAppNavRequests', start);
  const calls: string[] = [];
  const context: any = {
    calls,
    setView: (view: string) => calls.push(`view:${view}`),
    loadRendererFeature: async (feature: string) => {
      calls.push(`load:${feature}`);
      if (feature === failingFeature) throw new Error(`feature unavailable: ${feature}`);
      if (feature === 'settings') {
        context.window.activateSettingsTab = (tab: string) => calls.push(`settings:${tab}`);
      }
    },
    openMarketplace: (kind: string) => calls.push(`marketplace:${kind}`),
    setTimeout: (fn: () => void) => fn(),
    document: {
      getElementById: (id: string) => ({ click: () => calls.push(`click:${id}`) }),
    },
    window: {
      openAgentModal: () => calls.push('agent:create'),
      openAgentDetail: async (id: string) => { calls.push(`agent:configure:${id}`); return id !== 'missing'; },
      openSkillModal: () => calls.push('skill:create'),
      openAutoTaskDialog: () => calls.push('auto:create'),
      openAutoTaskById: async (id: string) => { calls.push(`auto:configure:${id}`); return id !== 'missing'; },
      focusConnectorById: async (id: string) => { calls.push(`connector:configure:${id}`); return id !== 'missing'; },
      openProjectsSurface: async (request: Record<string, string>) => {
        calls.push(`project:${request.action}:${request.target_id || ''}`);
        return request.target_id !== 'missing';
      },
    },
  };
  vm.runInNewContext(
    `${source.slice(start, end)}\nglobalThis.__appNavSurfaces = _APP_NAV_SURFACES;`,
    context,
  );
  return {
    calls,
    surfaces: (context as unknown as {
      __appNavSurfaces: Record<string, { open: (request: Record<string, string>) => Promise<void> }>;
    }).__appNavSurfaces,
  };
}

function rendererMountHarness(failingFeature = '') {
  const source = fs.readFileSync(RENDERER_CONVERSATION, 'utf8');
  const start = source.indexOf('const _APP_NAV_SURFACES = {');
  const end = source.indexOf('function _mountMarketplaceInstallRequests', start);
  const calls: string[] = [];
  const toasts: Array<{ message: string; variant?: string }> = [];

  class FakeElement {
    className = '';
    dataset: Record<string, string> = {};
    children: FakeElement[] = [];
    textContent = '';
    type = '';
    disabled = false;
    private listeners = new Map<string, Array<() => void>>();

    appendChild(child: FakeElement) { this.children.push(child); return child; }

    addEventListener(type: string, listener: () => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    click() { for (const listener of this.listeners.get('click') ?? []) listener(); }

    querySelector(selector: string): FakeElement | null {
      const descendants = this.children.flatMap((child) => [child, ...child.descendants()]);
      if (selector === '.chat-app-nav-row') {
        return descendants.find((node) => node.className.split(/\s+/).includes('chat-app-nav-row')) ?? null;
      }
      const prefix = '[data-app-nav="';
      if (selector.startsWith(prefix) && selector.endsWith('"]')) {
        const key = selector.slice(prefix.length, -2);
        return descendants.find((node) => node.dataset.appNav === key) ?? null;
      }
      return null;
    }

    private descendants(): FakeElement[] {
      return this.children.flatMap((child) => [child, ...child.descendants()]);
    }
  }

  const host = new FakeElement();
  const context = {
    CSS: { escape: (value: string) => value },
    document: {
      createElement: () => new FakeElement(),
      getElementById: (id: string) => ({ click: () => calls.push(`click:${id}`) }),
    },
    window: {
      focusConnectorById: async (id: string) => { calls.push(`connector:configure:${id}`); return id !== 'missing'; },
      openAgentModal: () => calls.push('agent:create'),
      openAgentDetail: async (id: string) => { calls.push(`agent:configure:${id}`); return id !== 'missing'; },
      openSkillModal: () => calls.push('skill:create'),
      openAutoTaskDialog: () => calls.push('auto:create'),
      openAutoTaskById: async (id: string) => { calls.push(`auto:configure:${id}`); return id !== 'missing'; },
      openProjectsSurface: async (request: Record<string, string>) => {
        calls.push(`project:${request.action}:${request.target_id || ''}`);
        return request.target_id !== 'missing';
      },
    },
    setView: (view: string) => calls.push(`view:${view}`),
    loadRendererFeature: async (feature: string) => {
      calls.push(`load:${feature}`);
      if (feature === failingFeature) throw new Error(`feature unavailable: ${feature}`);
    },
    openMarketplace: (kind: string) => calls.push(`marketplace:${kind}`),
    setTimeout: (fn: () => void) => fn(),
    _quickStartText: (_key: string, fallback: string) => fallback,
    t: (key: string, values: { name?: string } = {}) => `${key}:${values.name ?? ''}`,
    uiToast: (message: string, opts: { variant?: string } = {}) => {
      toasts.push({ message, variant: opts.variant });
    },
    _convLog: { warn: () => {} },
  };
  vm.runInNewContext(
    `${source.slice(start, end)}\nglobalThis.__mountAppNavRequests = _mountAppNavRequests;`,
    context,
  );
  return {
    calls,
    toasts,
    host,
    mount: (context as unknown as {
      __mountAppNavRequests: (target: FakeElement, message: Record<string, unknown>) => void;
    }).__mountAppNavRequests,
  };
}

describe('group_chat app_nav registry', () => {
  it('declares unique surface ids with model-facing summaries', () => {
    const ids = APP_NAV_SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    for (const surface of APP_NAV_SURFACES) {
      expect(surface.id).toMatch(/^[a-z][a-z0-9_.]*$/);
      expect(surface.summary.length).toBeGreaterThan(10);
      expect(surface.actions.length).toBeGreaterThan(0);
      expect(surface.actions).toContain('open');
      expect(new Set(surface.actions).size).toBe(surface.actions.length);
    }
    expect(new Set(APP_NAV_ACTIONS)).toEqual(new Set(['open', 'create', 'add_custom', 'configure']));
    expect(findAppNavSurface('settings.models')?.id).toBe('settings.models');
    expect(findAppNavSurface('not-a-surface')).toBeNull();
    const schemaDescription = appNavSurfaceDescription();
    expect(schemaDescription.length).toBeLessThanOrEqual(SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS);
    for (const surface of APP_NAV_SURFACES) expect(schemaDescription).toContain(surface.id);
  });

  it('carries app_nav_requests through the renderer legacy conversion', () => {
    // Every non-streaming render path (history load, history refresh, the
    // append fallback when the live row is already finalized) rebuilds the
    // bubble from `_groupMsgToLegacy`. A staged card that the conversion
    // drops is invisible after the first repaint even though the persisted
    // message carries it — reported 2026-08-26 on the onboarding
    // "help me set up a model" flow.
    const source = fs.readFileSync(RENDERER_CONVERSATION, 'utf8');
    const start = source.indexOf('function _groupMsgToLegacy');
    expect(start, '_groupMsgToLegacy must exist in conversation.js').toBeGreaterThan(-1);
    const end = source.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain('app_nav_requests: gm.app_nav_requests');
  });

  it('labels the default open action as page navigation in every supported locale', () => {
    const expected = {
      en: 'Open page: {name}',
      zh: '打开页面：{name}',
      ja: 'ページを開く：{name}',
      pt: 'Abrir página: {name}',
    };
    for (const [locale, copy] of Object.entries(expected)) {
      const table = JSON.parse(fs.readFileSync(
        path.join(path.dirname(RENDERER_CONVERSATION), '..', 'locales', `${locale}.json`),
        'utf8',
      ));
      expect(table['chat.app_nav_open'], locale).toBe(copy);
    }
  });

  it('localizes navigation failure recovery in every supported locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const table = JSON.parse(fs.readFileSync(
        path.join(path.dirname(RENDERER_CONVERSATION), '..', 'locales', `${locale}.json`),
        'utf8',
      ));
      expect(table['chat.app_nav_failed'], locale).toBeTruthy();
      expect(table['chat.app_nav_failed'], locale).not.toBe('chat.app_nav_failed');
    }
  });

  it('matches the renderer executor map exactly (a staged card must always be openable)', () => {
    // The tool enum comes from this registry while the click handler lives in
    // the renderer; any drift ships a card that either cannot render or a
    // surface the model can never stage.
    expect(rendererSurfaceIds().sort()).toEqual(APP_NAV_SURFACES.map((s) => s.id).sort());
    expect(rendererSurfaceActions()).toEqual(Object.fromEntries(
      APP_NAV_SURFACES.map((surface) => [surface.id, [...surface.actions]]),
    ));
  });

  it('validates action and target combinations at the staging boundary', () => {
    expect(validateAppNavRequest({ surface_id: 'settings.models' })).toEqual({
      ok: true,
      request: { surface_id: 'settings.models', action: 'open' },
    });
    expect(validateAppNavRequest({ surface_id: 'connectors', action: 'add_custom' })).toEqual({
      ok: true,
      request: { surface_id: 'connectors', action: 'add_custom' },
    });
    expect(validateAppNavRequest({
      surface_id: 'agents', action: 'configure', target_id: 'agent-123',
    })).toEqual({
      ok: true,
      request: { surface_id: 'agents', action: 'configure', target_id: 'agent-123' },
    });
    expect(validateAppNavRequest({ surface_id: 'settings.models', action: 'create' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('not supported') });
    expect(validateAppNavRequest({ surface_id: 'agents', action: 'configure' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('target_id is required') });
    expect(validateAppNavRequest({
      surface_id: 'agents', action: 'open', target_id: 'agent-123',
    })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/target_id requires action configure.*retry with action configure/),
    });
    expect(validateAppNavRequest({
      surface_id: 'projects', action: 'open', target_id: 'project-123',
    })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/target_id requires action configure.*same target_id/),
    });
    expect(validateAppNavRequest({
      surface_id: 'agents', action: 'configure', target_id: 'bad\nidentifier',
    })).toMatchObject({ ok: false, error: expect.stringContaining('bounded printable') });
    expect(validateAppNavRequest({
      surface_id: 'agents', action: 'configure', target_id: 'x'.repeat(160),
    })).toMatchObject({ ok: true });
    expect(validateAppNavRequest({
      surface_id: 'agents', action: 'configure', target_id: 'x'.repeat(161),
    })).toMatchObject({ ok: false, error: expect.stringContaining('bounded printable') });
    expect(validateAppNavRequest({
      surface_id: 'agents', action: 'configure', target_id: 'bad\u007fidentifier',
    })).toMatchObject({ ok: false, error: expect.stringContaining('bounded printable') });
    expect(validateAppNavRequest({ surface_id: 'agents', action: 'delete' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('not supported') });
  });

  it('loads cold-start feature modules before invoking action-specific handlers', () => {
    const source = fs.readFileSync(RENDERER_CONVERSATION, 'utf8');
    expect(source).toContain("_appNavLoadFeature('marketplace'");
    expect(source).toContain('window.focusConnectorById');
    expect(source).toContain('window.openAgentModal');
    expect(source).toContain('window.openAgentDetail');
    expect(source).toContain('window.openAutoTaskDialog');
    expect(source).toContain('window.openAutoTaskById');
  });

  it('executes navigation actions through the owning renderer workflows after lazy loading', async () => {
    const { calls, surfaces } = rendererNavHarness();

    await surfaces['settings.models'].open({ action: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.splice(0)).toEqual([
      'view:settings', 'load:settings', 'settings:credentials', 'settings:credentials',
    ]);

    await surfaces.connectors.open({ action: 'add_custom' });
    expect(calls.splice(0)).toEqual([
      'view:connectors', 'load:connectors', 'click:connectors-add-custom-btn',
    ]);

    await surfaces.connectors.open({ action: 'configure', target_id: 'connector-1' });
    expect(calls.splice(0)).toEqual([
      'view:connectors', 'load:connectors', 'connector:configure:connector-1',
    ]);

    await surfaces.agents.open({ action: 'create' });
    expect(calls.splice(0)).toEqual(['view:agents', 'load:agents', 'agent:create']);

    await surfaces.auto.open({ action: 'configure', target_id: 'task-1' });
    expect(calls.splice(0)).toEqual(['view:auto', 'load:auto', 'auto:configure:task-1']);

    await surfaces.projects.open({ action: 'configure', target_id: 'project-1' });
    expect(calls.splice(0)).toEqual(['project:configure:project-1']);

    await surfaces.apps.open({ action: 'open' });
    expect(calls.splice(0)).toEqual(['view:apps']);

    await surfaces.marketplace.open({ action: 'open' });
    expect(calls.splice(0)).toEqual(['load:marketplace', 'marketplace:agent']);
  });

  it('executes every declared surface/action pair through its production owner', async () => {
    const cases: Array<{
      surface: string;
      request: Record<string, string>;
      expected: string[];
    }> = [
      { surface: 'settings.models', request: { action: 'open' }, expected: ['view:settings', 'load:settings', 'settings:credentials', 'settings:credentials'] },
      { surface: 'settings.general', request: { action: 'open' }, expected: ['view:settings', 'load:settings', 'settings:general', 'settings:general'] },
      { surface: 'settings.data', request: { action: 'open' }, expected: ['view:settings', 'load:settings', 'settings:data', 'settings:data'] },
      { surface: 'connectors', request: { action: 'open' }, expected: ['view:connectors', 'load:connectors'] },
      { surface: 'connectors', request: { action: 'add_custom' }, expected: ['view:connectors', 'load:connectors', 'click:connectors-add-custom-btn'] },
      { surface: 'connectors', request: { action: 'configure', target_id: 'connector-1' }, expected: ['view:connectors', 'load:connectors', 'connector:configure:connector-1'] },
      { surface: 'library', request: { action: 'open' }, expected: ['view:contexts'] },
      { surface: 'projects', request: { action: 'open' }, expected: ['project:open:'] },
      { surface: 'projects', request: { action: 'create' }, expected: ['project:create:'] },
      { surface: 'projects', request: { action: 'configure', target_id: 'project-1' }, expected: ['project:configure:project-1'] },
      { surface: 'agents', request: { action: 'open' }, expected: ['view:agents', 'load:agents'] },
      { surface: 'agents', request: { action: 'create' }, expected: ['view:agents', 'load:agents', 'agent:create'] },
      { surface: 'agents', request: { action: 'configure', target_id: 'agent-1' }, expected: ['view:agents', 'load:agents', 'agent:configure:agent-1'] },
      { surface: 'skills', request: { action: 'open' }, expected: ['view:skills', 'load:skills'] },
      { surface: 'skills', request: { action: 'create' }, expected: ['view:skills', 'load:skills', 'skill:create'] },
      { surface: 'auto', request: { action: 'open' }, expected: ['view:auto', 'load:auto'] },
      { surface: 'auto', request: { action: 'create' }, expected: ['view:auto', 'load:auto', 'auto:create'] },
      { surface: 'auto', request: { action: 'configure', target_id: 'task-1' }, expected: ['view:auto', 'load:auto', 'auto:configure:task-1'] },
      { surface: 'apps', request: { action: 'open' }, expected: ['view:apps'] },
      { surface: 'marketplace', request: { action: 'open' }, expected: ['load:marketplace', 'marketplace:agent'] },
    ];

    for (const testCase of cases) {
      const { calls, surfaces } = rendererNavHarness();
      await surfaces[testCase.surface].open(testCase.request);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls, `${testCase.surface}:${testCase.request.action}`)
        .toEqual(testCase.expected);
    }
  });

  it('does not execute an action-specific side effect when its feature module is unavailable', async () => {
    const { calls, surfaces } = rendererNavHarness('connectors');
    await expect(surfaces.connectors.open({ action: 'add_custom' })).rejects.toThrow('feature unavailable');
    expect(calls).toEqual(['view:connectors', 'load:connectors']);
  });

  it('rejects a stale configure target instead of presenting navigation as successful', async () => {
    const { calls, surfaces } = rendererNavHarness();
    await expect(surfaces.auto.open({ action: 'configure', target_id: 'missing' }))
      .rejects.toThrow('target unavailable');
    expect(calls).toEqual(['view:auto', 'load:auto', 'auto:configure:missing']);
  });

  it('shows localized feedback when a clicked navigation card cannot open', async () => {
    const { host, mount, toasts } = rendererMountHarness('connectors');
    mount(host, { app_nav_requests: [{ surface_id: 'connectors', action: 'add_custom' }] });
    host.querySelector('.chat-app-nav-row')?.children[0]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toasts).toEqual([{ message: 'chat.app_nav_failed:', variant: 'error' }]);
  });

  it('renders only validated, deduped cards and keeps legacy open requests clickable', async () => {
    const { calls, host, mount } = rendererMountHarness();
    const message = {
      app_nav_requests: [
        // Pre-action messages from 1.6.8 migration remain usable.
        { surface_id: 'settings.models' },
        { surface_id: 'settings.models' },
        { surface_id: 'connectors', action: 'add_custom' },
        { surface_id: 'connectors', action: 'add_custom' },
        { surface_id: 'settings.models', action: 'create' },
        { surface_id: 'settings.models', action: 'open', target_id: 'forged-target' },
        { surface_id: 'agents', action: 'configure' },
        { surface_id: 'agents', action: 'configure', target_id: 'x'.repeat(161) },
        { surface_id: 'agents', action: 'configure', target_id: 'bad\nidentifier' },
        { surface_id: 'not-a-surface', action: 'open' },
      ],
    };

    mount(host, message);
    // Re-mounting the same persisted message is the history-refresh path and
    // must not append another set of cards.
    mount(host, message);
    const row = host.querySelector('.chat-app-nav-row');
    expect(row?.children).toHaveLength(2);
    expect(row?.children.map((button) => button.textContent)).toEqual([
      'chat.app_nav_open:Models & credentials',
      'chat.app_nav_add_custom:Connectors',
    ]);
    row?.children[1]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Array.from(calls)).toEqual([
      'view:connectors', 'load:connectors', 'click:connectors-add-custom-btn',
    ]);
  });

  it('keeps navigation cards independent of private onboarding telemetry', () => {
    const source = fs.readFileSync(RENDERER_CONVERSATION, 'utf8');
    const start = source.indexOf('function _mountAppNavRequests');
    const end = source.indexOf('function _mountMarketplaceInstallRequests', start);
    const mountBlock = source.slice(start, end);
    expect(mountBlock).not.toContain('_convTrackClick');
    expect(mountBlock).not.toContain('_onboardingTelemetryContext');
  });

  it('keeps the page action compact, evenly spaced, regular-weight, and chevron-free', () => {
    const source = fs.readFileSync(RENDERER_CONVERSATION, 'utf8');
    const start = source.indexOf('function _mountAppNavRequests');
    const end = source.indexOf('function _mountMarketplaceInstallRequests', start);
    const mountBlock = source.slice(start, end);
    expect(mountBlock).toContain("uiIconHtml('panel-list'");
    expect(mountBlock).not.toContain('chevron-right');

    const css = fs.readFileSync(RENDERER_STYLE, 'utf8');
    const styleStart = css.indexOf('.chat-app-nav-row .chat-app-nav-btn {');
    const styleEnd = css.indexOf('.chat-marketplace-request {', styleStart);
    const styleBlock = css.slice(styleStart, styleEnd);
    expect(styleBlock).toContain('width: fit-content');
    expect(styleBlock).toContain('min-height: 40px');
    expect(styleBlock).toContain('gap: 8px');
    expect(styleBlock).toContain('padding: 9px 12px');
    expect(styleBlock).toContain('font-weight: 400');
    expect(styleBlock).toContain('width: 16px');
    expect(styleBlock).toContain('flex: 0 0 16px');
    expect(styleBlock.match(/background:\s*transparent/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('focuses the exact configured connector through the production helper', async () => {
    const source = fs.readFileSync(RENDERER_CONNECTORS, 'utf8');
    const fnSource = extractAssignedAsyncFunction(source, 'window.focusConnectorById =');
    const calls: string[] = [];
    const cards = ['connector-1', 'connector-2'].map((id) => ({
      dataset: { id },
      setAttribute: (name: string, value: string) => calls.push(`attr:${id}:${name}:${value}`),
      scrollIntoView: () => calls.push(`scroll:${id}`),
      focus: () => calls.push(`focus:${id}`),
    }));
    const context = {
      loadConnectors: async () => { calls.push('load'); },
      document: { querySelectorAll: () => cards },
    };
    const focusConnector = vm.runInNewContext(`(${fnSource})`, context) as (
      id: string,
    ) => Promise<boolean>;

    expect(await focusConnector(' connector-2 ')).toBe(true);
    expect(calls).toEqual([
      'load',
      'attr:connector-2:tabindex:-1',
      'scroll:connector-2',
      'focus:connector-2',
    ]);
    expect(await focusConnector('missing')).toBe(false);
    expect(calls.at(-1)).toBe('load');
  });

  it('opens Projects through the owning sidebar/create/detail workflows', async () => {
    const source = fs.readFileSync(RENDERER_PROJECTS, 'utf8');
    const fnSource = extractAssignedAsyncFunction(source, 'window.openProjectsSurface =');
    const calls: string[] = [];
    let expanded = false;
    const toggle = {
      getAttribute: () => (expanded ? 'true' : 'false'),
      click: () => { expanded = true; calls.push('expand'); },
      scrollIntoView: () => calls.push('scroll'),
      focus: () => calls.push('focus'),
    };
    const context: any = {
      _projectsInlineCreate: false,
      _startProjectInlineCreate: () => {
        context._projectsInlineCreate = true;
        calls.push('create');
      },
      loadProjects: async () => [
        { project_id: 'project-1' },
        { project_id: 'project-2' },
      ],
      setView: (view: string, id: string) => calls.push(`${view}:${id}`),
      document: { getElementById: () => toggle },
    };
    const openProjects = vm.runInNewContext(`(${fnSource})`, context) as (
      request: Record<string, string>,
    ) => Promise<boolean>;

    expect(await openProjects({ action: 'open' })).toBe(true);
    expect(calls.splice(0)).toEqual(['expand', 'scroll', 'focus']);
    expect(await openProjects({ action: 'create' })).toBe(true);
    expect(calls.splice(0)).toEqual(['create']);
    expect(await openProjects({ action: 'configure', target_id: 'project-2' })).toBe(true);
    expect(calls.splice(0)).toEqual(['project:project-2']);
    expect(await openProjects({ action: 'configure', target_id: 'missing' })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('opens the exact automation task through the production helper', async () => {
    const source = fs.readFileSync(RENDERER_AUTO, 'utf8');
    const fnSource = extractAssignedAsyncFunction(source, 'window.openAutoTaskById =');
    const calls: string[] = [];
    const tasks = [{ id: 'task-1' }, { id: 'task-2' }];
    const opened: Array<{ task: { id: string } }> = [];
    const context = {
      _autoTasks: tasks,
      loadAutoTasks: async () => { calls.push('load'); },
      openAutoTaskDialog: (input: { task: { id: string } }) => { opened.push(input); },
    };
    const openAutoTask = vm.runInNewContext(`(${fnSource})`, context) as (
      id: string,
    ) => Promise<boolean>;

    expect(await openAutoTask(' task-2 ')).toBe(true);
    expect(calls).toEqual(['load']);
    expect(opened).toEqual([{ task: tasks[1] }]);
    expect(await openAutoTask('missing')).toBe(false);
    expect(opened).toHaveLength(1);
  });
});
