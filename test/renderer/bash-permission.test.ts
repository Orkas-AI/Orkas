import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// jsdom/happy-dom aren't installed. The permission dialog is a template string
// driven through querySelector / click / keydown, so this fake DOM parses that
// template into elements with exactly the API bash_permission.js uses and fails
// closed on any selector it does not know. The simulated user then presses
// buttons that were actually rendered: a choice the real markup does not offer
// cannot be "returned".

const VOID_TAGS = new Set(['br', 'input']);

function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

class FakeElement {
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  dataset: Record<string, string> = {};
  children: Array<FakeElement | string> = [];
  parent: FakeElement | null = null;
  hidden = false;
  style: Record<string, string> = {};
  offsetHeight = 0;
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(readonly tag: string, private readonly doc: FakeDocument) {}

  get className(): string { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }

  set innerHTML(html: string) {
    this.children = [];
    let current: FakeElement = this;
    let last = 0;
    for (const match of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
      const text = html.slice(last, match.index);
      if (text) current.children.push(unescapeHtml(text));
      last = match.index + match[0].length;
      const [, closing, tag, rawAttrs, selfClosing] = match;
      if (closing) {
        if (current === this || current.tag !== tag) throw new Error(`unbalanced </${tag}> in dialog markup`);
        current = current.parent as FakeElement;
        continue;
      }
      const element = new FakeElement(tag, this.doc);
      for (const attr of rawAttrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) element.setAttribute(attr[1], attr[2] ?? '');
      element.parent = current;
      current.children.push(element);
      if (!selfClosing && !VOID_TAGS.has(tag)) current = element;
    }
    if (current !== this) throw new Error(`unclosed <${current.tag}> in dialog markup`);
  }

  get textContent(): string {
    return this.children
      .map((child) => (typeof child === 'string' ? child : child.tag === 'br' ? '\n' : child.textContent))
      .join('');
  }
  set textContent(value: string) { this.children = [String(value)]; }

  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
    if (name === 'class') this.className = value;
    else if (name === 'hidden') this.hidden = true;
    else if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
    }
  }
  getAttribute(name: string): string | null { return name in this.attrs ? this.attrs[name] : null; }

  classList = {
    contains: (name: string) => this.classes.has(name),
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    toggle: (name: string, force?: boolean) => {
      const on = force === undefined ? !this.classes.has(name) : force;
      if (on) this.classes.add(name); else this.classes.delete(name);
      return on;
    },
  };

  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      yield child;
      yield* child.descendants();
    }
  }
  matches(selector: string): boolean {
    const byClass = /^\.([\w-]+)$/.exec(selector);
    if (byClass) return this.classes.has(byClass[1]);
    const byAttr = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
    if (byAttr) return this.attrs[byAttr[1]] === byAttr[2];
    throw new Error(`fake DOM does not support selector ${selector}`);
  }
  querySelectorAll(selector: string): FakeElement[] { return [...this.descendants()].filter((el) => el.matches(selector)); }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node: FakeElement): boolean { return node === this || [...this.descendants()].includes(node); }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }
  click() {
    const event = { target: this, preventDefault() {}, stopPropagation() {} };
    // Capture-phase document listeners run before the target's own.
    this.doc.dispatch('click', event);
    for (const listener of [...(this.listeners.get('click') ?? [])]) listener(event);
  }
  focus() {}
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
}

class FakeDocument {
  readonly body: FakeElement;
  visibilityState?: string;
  hasFocus?: () => boolean;
  private listeners = new Map<string, Array<(event: any) => void>>();
  private brokenDialogs: number;

  constructor(onPresented: (overlay: FakeElement) => void, options: HarnessOptions) {
    this.body = new FakeElement('body', this);
    this.body.appendChild = (child: FakeElement) => {
      FakeElement.prototype.appendChild.call(this.body, child);
      onPresented(child);
      return child;
    };
    this.brokenDialogs = options.brokenDialogs ?? 0;
    if (options.visibility) {
      const { state, focused } = options.visibility;
      this.visibilityState = state;
      this.hasFocus = () => focused === true;
    }
  }
  createElement(tag: string): FakeElement {
    if (this.brokenDialogs > 0) {
      this.brokenDialogs -= 1;
      throw new Error('/private/dialog-failure');
    }
    return new FakeElement(tag, this);
  }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }
  dispatch(type: string, event: any) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

// What a test can observe about a presented dialog, read back from the
// rendered markup at the moment it is attached to the document.
interface DialogView {
  title: string;
  message: string;
  currentMode: string;
  modeLabel: string;
  modes: Array<{ mode: string; label: string; desc: string }>;
  modeHint: string;
  showModeControl: boolean;
  allowRun: boolean;
  choices: string[];
}

function dialogView(overlay: FakeElement): DialogView {
  const text = (selector: string) => overlay.querySelector(selector)?.textContent ?? '';
  const options = overlay.querySelectorAll('.bash-permission-mode-option');
  const choices = overlay.querySelectorAll('[data-act="choice"]').map((button) => button.dataset.id);
  return {
    title: text('.ui-dialog-title'),
    message: text('.bash-permission-message'),
    currentMode: options.find((option) => option.attrs['aria-selected'] === 'true')?.dataset.mode ?? '',
    modeLabel: text('.bash-permission-mode-trigger-label'),
    modes: options.map((option) => ({
      mode: option.dataset.mode,
      label: option.querySelector('.bash-permission-mode-label')?.textContent ?? '',
      desc: option.querySelector('.bash-permission-mode-desc')?.textContent ?? '',
    })),
    modeHint: text('.bash-permission-mode-hint'),
    showModeControl: overlay.querySelector('.bash-permission-mode-control') !== null,
    allowRun: choices.includes('allow_run'),
    choices,
  };
}

type Choice = 'allow_once' | 'allow_run' | 'deny';
// What the simulated user does once the dialog is on screen: pick a permission
// level from the real menu when it differs from the current one, then press a
// rendered button. 'pending' leaves the dialog open for cancellation cases.
type UserAction = 'pending' | Choice | { choice: Choice; mode?: string };

interface HarnessOptions {
  visibility?: { state: 'visible' | 'hidden'; focused?: boolean };
  // Dialogs whose `document.createElement` throws before elements work again
  // (the broken-dialog negative control).
  brokenDialogs?: number;
}

function actOnDialog(overlay: FakeElement, user: UserAction) {
  if (user === 'pending') return;
  const action = typeof user === 'string' ? { choice: user } : user;
  if (action.mode && dialogView(overlay).currentMode !== action.mode) {
    const trigger = overlay.querySelector('.bash-permission-mode-trigger');
    const menu = overlay.querySelector('.bash-permission-mode-menu');
    if (!trigger || !menu) throw new Error('permission level control is not rendered');
    trigger.click();
    if (menu.hidden) throw new Error('permission level menu did not open');
    const option = overlay.querySelectorAll('.bash-permission-mode-option').find((item) => item.dataset.mode === action.mode);
    if (!option) throw new Error(`permission level ${action.mode} is not offered`);
    option.click();
    if (!menu.hidden) throw new Error('permission level menu did not close');
  }
  const button = action.choice === 'deny'
    ? overlay.querySelector('[data-act="cancel"]')
    : overlay.querySelector(`[data-id="${action.choice}"]`);
  if (!button) throw new Error(`choice ${action.choice} is not offered`);
  button.click();
}

function loadHarness(
  user: UserAction,
  invokeImpl?: (channel: string, payload: any) => Promise<any>,
  options: HarnessOptions = {},
) {
  let pushHandler: ((info: any) => void) | null = null;
  let cancelHandler: ((info: any) => void) | null = null;
  let localAgentPushHandler: ((info: any) => void) | null = null;
  let localAgentCancelHandler: ((info: any) => void) | null = null;
  const pushHandlers = new Map<string, (info: any) => void>();
  const dialogs: DialogView[] = [];
  const invokeCalls: Array<{ channel: string; payload: any }> = [];
  const monitorEvent = vi.fn();
  const warn = vi.fn();
  const document = new FakeDocument((overlay) => {
    dialogs.push(dialogView(overlay));
    // Listeners are wired synchronously after the overlay is attached; the
    // user acts on the next microtask, once the dialog is fully interactive.
    queueMicrotask(() => actOnDialog(overlay, user));
  }, options);

  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    performance,
    Promise,
    String,
    Array,
    document,
    createLogger: () => ({ warn, info() {}, error() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'bash.permission.title': 'Run this command?',
        'bash.permission.message': '{agent} wants {reasons}:',
        'bash.permission.action_title': 'Allow this sensitive action?',
        'bash.permission.action_message': '{agent} wants {operation}, which {reasons}:',
        'bash.permission.action_fallback': 'local action',
        'bash.permission.mode_title': 'Permission level',
        'bash.permission.mode_hint': 'You can change this in Settings - General - Local operation permissions.',
        'bash.permission.allow_once': 'Allow once',
        'bash.permission.allow_run': 'Allow for this task',
        'bash.permission.deny': "Don't run",
        'bash.permission.agent_fallback': 'The assistant',
        'chat.from_commander': 'Commander',
        'bash.permission.reason.network_egress': 'network',
        'bash.permission.reason.destructive': 'deletes files',
        'bash.permission.irreversible.recursive_delete': 'delete a whole directory',
        'bash.permission.irreversible.untargeted_process_kill': 'end every matching process',
        'bash.permission.irreversible_note': 'This step cannot be undone: {actions}.',
        'bash.permission.irreversible_auto_note': 'Your permission level is {mode}, so other sensitive actions no longer ask. This one still does because it cannot be undone: {actions}.',
        'bash.permission.reason.system_package_change': 'changes system packages',
        'bash.permission.reason.external_mutation': 'changes an external system',
        'bash.permission.external_operations': 'Detected:\n{operations}',
        'bash.permission.external_kind.service_change': 'Service change',
        'bash.permission.reason_sep': ', ',
        'settings.localexec.mode.workspace_approval': 'Cautious',
        'settings.localexec.mode.workspace_approval_desc': 'Workspace files only, confirm sensitive actions',
        'settings.localexec.mode.all_files_approval': 'Standard',
        'settings.localexec.mode.all_files_approval_desc': 'All files, confirm sensitive actions',
        'settings.localexec.mode.all_files_auto': 'Trusted',
        'settings.localexec.mode.all_files_auto_desc': 'All files, no sensitive confirmations',
        'agents.cli_permission_prompt_title': 'Request execution permission',
        'agents.cli_permission_task': 'Task: {title}',
        'agents.cli_permission_requested': 'Permission: {permission}',
        'agents.cli_permission_action_fallback': 'an external CLI tool',
        'agents.cli_permission': 'Permission level',
        'agents.cli_permission_inherit': 'Use CLI default',
        'agents.cli_permission_inherit_desc': 'Follow the {cli} CLI settings',
        'agents.cli_permission_ask': 'Ask for permission',
        'agents.cli_permission_ask_desc': 'Confirm in Orkas',
        'agents.cli_permission_full_access': 'Full access',
        'agents.cli_permission_full_access_desc': 'Automatically approve requests',
        'agents.cli_permission_mode_hint': 'Change this in AI Team > {agent} > Runtime settings > Permission level.',
      };
      let text = dict[key] || key;
      for (const [k, v] of Object.entries(vars || {})) {
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
      return text;
    },
    Monitor: { event: monitorEvent },
    window: {
      addEventListener() {},
      Monitor: { event: monitorEvent },
      orkas: {
        invoke: vi.fn(async (channel: string, payload: any) => {
          invokeCalls.push({ channel, payload });
          if (invokeImpl) return invokeImpl(channel, payload);
          if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
          if (channel === 'permissions.setLocalExecMode') return { ok: true, mode: payload.mode };
          return { handled: true };
        }),
        onPushEvent: vi.fn((name: string, cb: (info: any) => void) => {
          pushHandlers.set(name, cb);
          if (name === 'bash:permission') pushHandler = cb;
          if (name === 'bash:permission_cancelled') cancelHandler = cb;
          if (name === 'local-agent:permission') localAgentPushHandler = cb;
          if (name === 'local-agent:permission_cancelled') localAgentCancelHandler = cb;
        }),
      },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  for (const module of ['dropdown-placement.js', 'connectors.js', 'bash_permission.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', module), 'utf8'), context, { filename: module });
  }
  if (!pushHandler) throw new Error('bash:permission handler was not registered');
  if (!cancelHandler) throw new Error('bash:permission_cancelled handler was not registered');

  if (!localAgentPushHandler) throw new Error('local-agent:permission handler was not registered');
  if (!localAgentCancelHandler) throw new Error('local-agent:permission_cancelled handler was not registered');

  return {
    context,
    document,
    pushHandler,
    cancelHandler,
    localAgentPushHandler,
    localAgentCancelHandler,
    emitPush: (name: string, info: any) => pushHandlers.get(name)?.(info),
    keydown: (init: Record<string, unknown>) => document.dispatch('keydown', { preventDefault() {}, ...init }),
    openDialogs: () => document.body.querySelectorAll('[role="dialog"]').length,
    dialogs,
    invokeCalls,
    monitorEvent,
    warn,
  };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe('connector actions share local operation permissions', () => {
  const action = {
    request_id: 'connector-request', cid: 'task-1', connector_id: 'feishu',
    display_name: 'Feishu', account_label: 'Work account', tool_name: 'execute_high_impact',
    risk: 'H', sensitive_operation: 'external_action',
    arguments_preview: '{"action":"im.+messages-send","text":"private-message"}',
  };

  it.each(['built-in', 'codex', 'claude'])('shows the local mode menu for %s connector calls', async (caller) => {
    const h = loadHarness('allow_once');
    h.emitPush('connectors:action-confirm', {
      ...action,
      // Native CLI access must never select the connector's permission menu.
      ...(caller === 'built-in' ? {} : { cli: caller, permission_policy: 'full_access' }),
    });
    await flush();

    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs[0]).toMatchObject({
      title: 'Allow this sensitive action?', currentMode: 'all_files_approval', modeLabel: 'Standard',
      showModeControl: true, allowRun: false,
      modeHint: 'You can change this in Settings - General - Local operation permissions.',
    });
    expect(h.dialogs[0].modes.map((item: any) => item.mode)).toEqual([
      'workspace_approval', 'all_files_approval', 'all_files_auto',
    ]);
    for (const detail of ['Feishu', 'Work account', 'execute_high_impact', 'im.+messages-send', 'private-message']) {
      expect(h.dialogs[0].message).toContain(detail);
    }
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'connectors.action_confirm_response', payload: { request_id: action.request_id, approved: true } },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('connector_action_confirmation_result', expect.objectContaining({
      result: 'success', decision: 'approved',
    }));
    expect(JSON.stringify(h.monitorEvent.mock.calls)).not.toMatch(/private-message|Work account|im\.\+messages-send/);
  });

  it('coarsens a custom MCP connector to `custom` and omits its tool name in confirmation telemetry', async () => {
    // Custom ids are derived from the user's display name and the tool name is
    // the server's own free text; neither belongs in analytics. Catalog
    // connectors keep both (negative control).
    const h = loadHarness('allow_once');
    h.emitPush('connectors:action-confirm', {
      ...action, request_id: 'custom-request', connector_id: 'custom-my-private-server', tool_name: 'run_private_query',
    });
    await flush();
    const custom = h.monitorEvent.mock.calls.find((call: any[]) => call[0] === 'connector_action_confirmation_result');
    expect(custom?.[1]).toMatchObject({ connector_id: 'custom', decision: 'approved' });
    expect(custom?.[1]).not.toHaveProperty('tool_name');
    expect(JSON.stringify(h.monitorEvent.mock.calls)).not.toMatch(/my-private-server|run_private_query/);

    h.monitorEvent.mockClear();
    h.emitPush('connectors:action-confirm', { ...action, request_id: 'catalog-request' });
    await flush();
    expect(h.monitorEvent).toHaveBeenCalledWith('connector_action_confirmation_result', expect.objectContaining({
      connector_id: 'feishu', tool_name: 'execute_high_impact',
    }));
  });

  it('persists Trusted before approval and does not prompt again for an already queued connector', async () => {
    let mode = 'all_files_approval';
    const h = loadHarness({ choice: 'allow_once', mode: 'all_files_auto' }, async (channel, payload) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode };
      if (channel === 'permissions.setLocalExecMode') { mode = payload.mode; return { ok: true, mode }; }
      return { handled: true };
    });
    h.emitPush('connectors:action-confirm', action);
    h.emitPush('connectors:action-confirm', { ...action, request_id: 'queued-connector' });
    await flush();

    expect(mode).toBe('all_files_auto');
    expect(h.dialogs).toHaveLength(1);
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'permissions.setLocalExecMode', payload: { mode: 'all_files_auto' } },
      { channel: 'connectors.action_confirm_response', payload: { request_id: action.request_id, approved: true } },
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'connectors.action_confirm_response', payload: { request_id: 'queued-connector', approved: true } },
    ]);
  });

  it.each(['deny', 'save-failed'])('does not approve or widen trust after %s', async (scenario) => {
    const h = loadHarness({ choice: scenario === 'deny' ? 'deny' : 'allow_once', mode: 'all_files_auto' }, async (channel) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
      if (channel === 'permissions.setLocalExecMode') return { ok: false };
      return { handled: true };
    });
    h.emitPush('connectors:action-confirm', action);
    await flush();
    expect(h.invokeCalls.at(-1)).toEqual({
      channel: 'connectors.action_confirm_response', payload: { request_id: action.request_id, approved: false },
    });
    expect(h.invokeCalls.filter((call) => call.channel === 'permissions.setLocalExecMode')).toHaveLength(scenario === 'deny' ? 0 : 1);
  });

  it('serializes connector, local operation and native CLI prompts, and cancels active and queued connector requests', async () => {
    const h = loadHarness('pending');
    h.pushHandler({ request_id: 'local-first', reasons: ['external_mutation'] });
    h.emitPush('connectors:action-confirm', action);
    h.emitPush('connectors:action-confirm', { ...action, request_id: 'cancel-in-queue' });
    h.localAgentPushHandler({ request_id: 'cli-last', cli: 'codex', tool: 'command' });
    await flush();
    expect(h.dialogs).toHaveLength(1);
    h.emitPush('connectors:action-confirm-cancelled', { request_ids: ['cancel-in-queue'] });
    h.cancelHandler({ request_ids: ['local-first'] });
    await flush();
    expect(h.dialogs).toHaveLength(2);
    expect(h.dialogs[1].message).toContain('private-message');
    h.emitPush('connectors:action-confirm-cancelled', { request_ids: [action.request_id] });
    await flush();
    expect(h.dialogs).toHaveLength(3);
    expect(h.dialogs[2].title).toBe('Request execution permission');
    h.localAgentCancelHandler({ request_ids: ['cli-last'] });
    await flush();
    expect(h.invokeCalls.every((call) => call.channel === 'permissions.getLocalExec')).toBe(true);
  });

  it.each(['lookup', 'save'])('does not send stale approval when cancelled during mode %s', async (phase) => {
    let resume!: (value: unknown) => void;
    const waiting = new Promise((resolve) => { resume = resolve; });
    const h = loadHarness({ choice: 'allow_once', mode: 'all_files_auto' }, async (channel) => {
      if (channel === (phase === 'lookup' ? 'permissions.getLocalExec' : 'permissions.setLocalExecMode')) return waiting;
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
      return { handled: true };
    });
    h.emitPush('connectors:action-confirm', action);
    await flush();
    h.emitPush('connectors:action-confirm-cancelled', { request_ids: [action.request_id] });
    resume({ ok: true, mode: 'all_files_auto' });
    await flush();
    expect(h.dialogs).toHaveLength(phase === 'lookup' ? 0 : 1);
    expect(h.invokeCalls.some((call) => call.channel === 'connectors.action_confirm_response')).toBe(false);
  });

  it.each(['stale', 'rejected', 'unavailable'])('reports a %s approval response without success or private errors', async (failure) => {
    const h = loadHarness('allow_once', async (channel) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
      if (failure === 'unavailable') throw new Error('/private/approval-response');
      return failure === 'stale' ? { handled: false } : { ok: false, error: '/private/approval-response' };
    });
    h.emitPush('connectors:action-confirm', action);
    await flush();
    expect(h.monitorEvent).toHaveBeenCalledWith('connector_action_confirmation_result', expect.objectContaining({
      result: failure === 'stale' ? 'cancelled' : 'failure',
    }));
    expect(JSON.stringify([h.monitorEvent.mock.calls, h.warn.mock.calls])).not.toContain('/private/approval-response');
  });

  it('denies a broken dialog and still presents the next queued action', async () => {
    // The real `document` path fails closed: when the dialog cannot even be
    // created, the request is denied and the queue keeps moving.
    const h = loadHarness('allow_once', undefined, { brokenDialogs: 1 });
    h.emitPush('connectors:action-confirm', action);
    h.emitPush('connectors:action-confirm', { ...action, request_id: 'after-ui-recovery' });
    await flush();
    expect(h.invokeCalls.filter((call) => call.channel === 'connectors.action_confirm_response')).toEqual([
      { channel: 'connectors.action_confirm_response', payload: { request_id: action.request_id, approved: false } },
      { channel: 'connectors.action_confirm_response', payload: { request_id: 'after-ui-recovery', approved: true } },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('connector_action_confirmation_result', expect.objectContaining({
      result: 'failure', decision: 'denied',
    }));
    expect(h.dialogs).toHaveLength(1);
    expect(JSON.stringify([h.monitorEvent.mock.calls, h.warn.mock.calls])).not.toContain('/private/dialog-failure');
  });
});

describe('renderer bash permission prompt', () => {
  it('reuses the shared chevron icon in the permission level trigger', () => {
    const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/bash_permission.js'), 'utf8');

    expect(code).toContain("window.uiIconHtml('chevron-down', 'bash-permission-mode-trigger-caret')");
    expect(code).toContain('${caretHtml}');
  });

  it.each([
    ['allow_once', 'allow_once'],
    ['allow_run', 'allow_run'],
    ['deny', 'deny'],
  ] as const)('maps external CLI choice %s to decision %s', async (choice, expectedDecision) => {
    const h = loadHarness({ choice });

    h.localAgentPushHandler({
      request_id: 'cli-permission-1',
      cid: 'release-checklist-cid',
      conversation_title: 'Release checklist',
      agent_id: 'reviewer',
      agent_name: 'Reviewer',
      cli: 'codex',
      tool: 'command',
      description: 'Run the focused test suite',
      command: 'npm test',
      subject: '/selected/project',
      can_allow_run: true,
      permission_policy: 'ask',
      permission_policies: ['inherit', 'ask', 'full_access'],
    });
    await flush();

    expect(h.dialogs[0]).toMatchObject({
      title: 'Request execution permission',
      currentMode: 'ask',
      allowRun: true,
      showModeControl: true,
      modeHint: 'Change this in AI Team > Reviewer > Runtime settings > Permission level.',
      modes: [
        { mode: 'inherit', label: 'Use CLI default', desc: 'Follow the codex CLI settings' },
        { mode: 'ask', label: 'Ask for permission', desc: 'Confirm in Orkas' },
        { mode: 'full_access', label: 'Full access', desc: 'Automatically approve requests' },
      ],
    });
    expect(h.dialogs[0].message).toBe([
      'Task: Release checklist',
      'Permission: command · Run the focused test suite · npm test · /selected/project',
    ].join('\n'));
    expect(h.invokeCalls).toEqual([{
      channel: 'localAgents.permissionResponse',
      payload: {
        request_id: 'cli-permission-1',
        decision: expectedDecision,
        permission_policy: 'ask',
      },
    }]);
  });

  it('renders connected-service actions in the unified external CLI permission dialog', async () => {
    const h = loadHarness({ choice: 'allow_run', mode: 'ask' }, async (channel) => {
      if (channel === 'localAgents.permissionResponse') {
        return {
          handled: true,
          decision: 'allow_run',
          policy_saved: true,
          permission_policy: 'ask',
        };
      }
      return { handled: true };
    });

    h.localAgentPushHandler({
      request_id: 'connector-permission-1',
      cid: 'launch-email-cid',
      conversation_title: 'Send launch update',
      agent_name: 'Orkas Codex',
      cli: 'codex',
      tool: 'GMAIL_SEND_EMAIL',
      description: 'Gmail',
      can_allow_run: true,
      permission_kind: 'connector',
      permission_policy: 'ask',
      permission_policies: ['inherit', 'ask', 'full_access'],
    });
    await flush();

    expect(h.dialogs[0]).toMatchObject({
      title: 'Request execution permission',
      currentMode: 'ask',
      allowRun: true,
      showModeControl: true,
    });
    expect(h.dialogs[0].message).toBe([
      'Task: Send launch update',
      'Permission: GMAIL_SEND_EMAIL · Gmail',
    ].join('\n'));
    expect(h.invokeCalls).toEqual([{
      channel: 'localAgents.permissionResponse',
      payload: {
        request_id: 'connector-permission-1',
        decision: 'allow_run',
        permission_policy: 'ask',
      },
    }]);
    expect(h.monitorEvent).toHaveBeenCalledWith('connector_bridge_permission_result', {
      result: 'success',
      decision: 'allow_run',
      effective_decision: 'allow_run',
      duration_ms: expect.any(Number),
    });
  });

  it('returns a changed CLI full-access level through the native approval response', async () => {
    const h = loadHarness({ choice: 'allow_once', mode: 'full_access' });

    h.localAgentPushHandler({
      request_id: 'cli-change-level',
      agent_name: 'Reviewer',
      cli: 'codex',
      tool: 'command',
      can_allow_run: true,
      permission_policy: 'ask',
      permission_policies: ['inherit', 'ask', 'full_access'],
    });
    await flush();

    expect(h.invokeCalls).toEqual([{
      channel: 'localAgents.permissionResponse',
      payload: {
        request_id: 'cli-change-level',
        decision: 'allow_once',
        permission_policy: 'full_access',
      },
    }]);
  });

  it('returns CLI-native inheritance while keeping the selected one-time decision', async () => {
    const h = loadHarness({ choice: 'allow_once', mode: 'inherit' });

    h.localAgentPushHandler({
      request_id: 'cli-cautious-level',
      agent_name: 'Reviewer',
      cli: 'claude',
      tool: 'Bash',
      can_allow_run: true,
      permission_policy: 'ask',
      permission_policies: ['inherit', 'ask', 'full_access'],
    });
    await flush();

    expect(h.invokeCalls).toEqual([{
      channel: 'localAgents.permissionResponse',
      payload: {
        request_id: 'cli-cautious-level',
        decision: 'allow_once',
        permission_policy: 'inherit',
      },
    }]);
  });

  it.each(['claude', 'hermes'] as const)(
    'shows the Orkas confirmation levels advertised for %s',
    async (cli) => {
      const h = loadHarness({ choice: 'allow_once', mode: 'ask' });

      h.localAgentPushHandler({
        request_id: `cli-${cli}-levels`,
        agent_name: 'Reviewer',
        cli,
        tool: 'execute',
        can_allow_run: true,
        permission_policy: 'ask',
        permission_policies: ['inherit', 'ask', 'full_access'],
      });
      await flush();

      expect(h.dialogs[0]).toMatchObject({
        currentMode: 'ask',
        modes: [
          { mode: 'inherit', label: 'Use CLI default', desc: `Follow the ${cli} CLI settings` },
          { mode: 'ask', label: 'Ask for permission', desc: 'Confirm in Orkas' },
          { mode: 'full_access', label: 'Full access', desc: 'Automatically approve requests' },
        ],
      });
      expect(h.invokeCalls).toEqual([{
        channel: 'localAgents.permissionResponse',
        payload: {
          request_id: `cli-${cli}-levels`,
          decision: 'allow_once',
          permission_policy: 'ask',
        },
      }]);
    },
  );

  it('falls back to CLI-native defaults when permission metadata is malformed', async () => {
    const h = loadHarness('allow_once');

    h.localAgentPushHandler({
      request_id: 'cli-invalid-levels',
      agent_name: 'Reviewer',
      cli: 'codex',
      tool: 'command',
      can_allow_run: true,
      permission_policy: 'unsupported-policy',
      permission_policies: ['unsupported-policy', null],
    });
    await flush();

    expect(h.dialogs[0]).toMatchObject({
      currentMode: 'inherit',
      modes: [
        { mode: 'inherit', label: 'Use CLI default', desc: 'Follow the codex CLI settings' },
      ],
    });
    expect(h.invokeCalls).toEqual([{
      channel: 'localAgents.permissionResponse',
      payload: {
        request_id: 'cli-invalid-levels',
        decision: 'allow_once',
        permission_policy: 'inherit',
      },
    }]);
  });

  it('closes a cancelled external CLI prompt without sending a stale response', async () => {
    const h = loadHarness('pending');

    h.localAgentPushHandler({
      request_id: 'cli-cancelled',
      agent_name: 'Reviewer',
      cli: 'hermes',
      tool: 'execute',
      can_allow_run: true,
    });
    await flush();
    h.localAgentCancelHandler({ request_ids: ['cli-cancelled'] });
    await flush();

    expect(h.dialogs).toHaveLength(1);
    expect(h.invokeCalls).toEqual([]);
  });

  it('contains external CLI response failures without exposing private error text', async () => {
    const h = loadHarness('deny', async (channel) => {
      if (channel === 'localAgents.permissionResponse') {
        throw new Error('/private/workspace/request failed');
      }
      return { handled: true };
    });

    h.localAgentPushHandler({
      request_id: 'cli-response-failed',
      agent_name: 'Reviewer',
      cli: 'codex',
      tool: 'command',
      permission_kind: 'connector',
    });
    await flush();

    expect(h.warn).toHaveBeenCalledWith(
      'external CLI permission response failed',
      { error_type: 'Error' },
    );
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('/private/workspace');
    expect(h.monitorEvent).toHaveBeenCalledWith('connector_bridge_permission_result', expect.objectContaining({
      result: 'failure',
      decision: 'deny',
      effective_decision: 'deny',
      error_code: 'response_failed',
      error_type: 'ipc',
    }));
  });

  it('offers task-level approval when main marks the risk category eligible', async () => {
    const h = loadHarness({ choice: 'allow_once', mode: 'all_files_auto' });

    h.pushHandler({
      request_id: 'req-1',
      agent_id: 'commander',
      agent_name: 'Commander',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
      can_allow_run: true,
    });
    await flush();

    expect(h.dialogs[0]).toMatchObject({
      currentMode: 'all_files_approval',
      allowRun: true,
      showModeControl: true,
      modes: [
        {
          mode: 'workspace_approval',
          label: 'Cautious',
          desc: 'Workspace files only, confirm sensitive actions',
        },
        {
          mode: 'all_files_approval',
          label: 'Standard',
          desc: 'All files, confirm sensitive actions',
        },
        {
          mode: 'all_files_auto',
          label: 'Trusted',
          desc: 'All files, no sensitive confirmations',
        },
      ],
    });
    expect(h.dialogs[0].message).toContain('Commander wants network:');
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'permissions.setLocalExecMode', payload: { mode: 'all_files_auto' } },
      { channel: 'bash.permission_response', payload: { request_id: 'req-1', decision: 'allow_once' } },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'success',
      decision: 'allow_once',
      effective_decision: 'allow_once',
      mode: 'all_files_auto',
      mode_changed: true,
      categories: 'network_egress',
      duration_ms: expect.any(Number),
    }));
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_requested', {
      categories: 'network_egress',
      visibility_state: 'unknown',
    });
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_presented', expect.objectContaining({
      categories: 'network_egress',
      mode: 'all_files_approval',
      visibility_state: 'unknown',
      queue_wait_ms: expect.any(Number),
    }));
    expect(h.monitorEvent.mock.calls
      .map(([name]) => name)
      .filter((name) => name.startsWith('bash_risk_prompt_'))).toEqual([
      'bash_risk_prompt_requested',
      'bash_risk_prompt_presented',
      'bash_risk_prompt_result',
    ]);
  });

  it.each([
    ['a focused window', { state: 'visible', focused: true } as const, 'visible_focused'],
    ['an unfocused window', { state: 'visible', focused: false } as const, 'visible_unfocused'],
    ['a hidden window', { state: 'hidden', focused: true } as const, 'hidden'],
  ])('records bounded visibility when presenting in %s', async (_label, visibility, expectedState) => {
    const h = loadHarness('deny', undefined, { visibility });

    h.pushHandler({ request_id: `req-${expectedState}`, reasons: ['destructive'] });
    await flush();

    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_requested', expect.objectContaining({
      visibility_state: expectedState,
    }));
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_presented', expect.objectContaining({
      visibility_state: expectedState,
    }));
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_result')).toHaveLength(1);
  });

  // A user who deliberately turned prompts off and then sees one has to be
  // told why, or the dialog reads as the setting having failed.
  it('explains why an irreversible step still asks under automatic execution', async () => {
    const h = loadHarness('deny', async (channel: string) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_auto' };
      return { handled: true };
    });

    h.pushHandler({
      request_id: 'req-irrev',
      agent_id: 'commander',
      agent_name: 'Commander',
      command: 'rm -rf /tmp/profile',
      reasons: ['destructive'],
      irreversible: ['recursive_delete'],
      can_allow_run: true,
    });
    await flush();

    expect(h.dialogs[0].currentMode).toBe('all_files_auto');
    // Names the level using the same key Settings shows, so the sentence points
    // at the switch the user actually flipped.
    expect(h.dialogs[0].message).toContain('Your permission level is Trusted');
    expect(h.dialogs[0].message).toContain('delete a whole directory');
  });

  it('states the irreversibility without the automatic-execution wording in other modes', async () => {
    const h = loadHarness('deny');

    h.pushHandler({
      request_id: 'req-irrev-approval',
      agent_id: 'commander',
      agent_name: 'Commander',
      command: 'taskkill /F /IM chrome.exe /T',
      reasons: ['destructive'],
      irreversible: ['untargeted_process_kill'],
      can_allow_run: true,
    });
    await flush();

    expect(h.dialogs[0].currentMode).toBe('all_files_approval');
    expect(h.dialogs[0].message).toContain('This step cannot be undone');
    expect(h.dialogs[0].message).not.toContain('Your permission level is');
    expect(h.dialogs[0].message).toContain('end every matching process');
  });

  it('adds no irreversibility note to an ordinary sensitive prompt', async () => {
    const h = loadHarness('deny');

    h.pushHandler({
      request_id: 'req-plain',
      agent_id: 'commander',
      agent_name: 'Commander',
      command: 'rm -f build.log',
      reasons: ['destructive'],
      can_allow_run: true,
    });
    await flush();

    expect(h.dialogs[0].message).not.toContain('cannot be undone');
  });

  it('keeps private prompt fields and unknown categories out of telemetry', async () => {
    const privatePath = '/private/workspace/customer-secret.txt';
    const h = loadHarness('deny');

    h.pushHandler({
      request_id: 'req-private-identifier',
      agent_id: 'private-agent-identifier',
      agent_name: 'Private Agent Name',
      command: `rm ${privatePath}`,
      operation: 'delete_file',
      subject: privatePath,
      reasons: ['destructive', 'unbounded-private-category', 'destructive'],
      cid: 'private-conversation-identifier',
    });
    await flush();

    const serialized = JSON.stringify(h.monitorEvent.mock.calls);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain('private-agent-identifier');
    expect(serialized).not.toContain('Private Agent Name');
    expect(serialized).not.toContain('private-conversation-identifier');
    expect(serialized).not.toContain('req-private-identifier');
    expect(serialized).not.toContain('unbounded-private-category');
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_requested', {
      categories: 'destructive',
      visibility_state: 'unknown',
    });
  });

  it.each([
    'network_egress',
    'destructive',
    'sensitive_path',
    'system_package_change',
  ] as const)('returns task-level approval for eligible %s prompts', async (reason) => {
    const h = loadHarness({ choice: 'allow_run', mode: 'all_files_approval' });

    h.pushHandler({
      request_id: `req-${reason}`,
      agent_name: 'Agent',
      command: 'sensitive command',
      reasons: [reason],
      can_allow_run: true,
    });
    await flush();

    expect(h.dialogs[0]).toMatchObject({ allowRun: true, showModeControl: true });
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'bash.permission_response', payload: { request_id: `req-${reason}`, decision: 'allow_run' } },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'success',
      decision: 'allow_run',
      effective_decision: 'allow_run',
      mode: 'all_files_approval',
      mode_changed: false,
    }));
  });

  // The rendered dialog is the approval boundary: a strict category gets no
  // task-level button to press, so one command is the only grant a user can
  // give, and no category ever gets a durable "always allow" button (durable
  // trust only changes through the permission level menu).
  it.each(['priv_esc', 'external_mutation'] as const)(
    'offers only one-time approval for strict %s prompts',
    async (reason) => {
      const h = loadHarness('allow_once');

      h.pushHandler({
        request_id: `req-${reason}`,
        agent_name: 'Agent',
        command: 'sensitive command',
        reasons: [reason],
        can_allow_run: false,
      });
      await flush();

      expect(h.dialogs[0]).toMatchObject({ allowRun: false, showModeControl: true, choices: ['allow_once'] });
      expect(h.invokeCalls).toContainEqual({
        channel: 'bash.permission_response',
        payload: { request_id: `req-${reason}`, decision: 'allow_once' },
      });
    },
  );

  it('offers task-level but never durable approval for system package changes', async () => {
    const h = loadHarness('allow_run');

    h.pushHandler({
      request_id: 'req-system-package',
      agent_name: 'Agent',
      command: 'winget install PostgreSQL.PostgreSQL',
      reasons: ['system_package_change'],
      can_allow_run: true,
    });
    await flush();

    expect(h.dialogs[0]).toMatchObject({ showModeControl: true, choices: ['allow_once', 'allow_run'] });
    expect(h.dialogs[0].message).toContain('changes system packages');
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'bash.permission_response', payload: { request_id: 'req-system-package', decision: 'allow_run' } },
    ]);
  });

  it('offers only one-time approval for external mutations', async () => {
    const h = loadHarness('allow_once');

    h.pushHandler({
      request_id: 'req-external-mutation',
      agent_name: 'Agent',
      command: 'ssh deploy@app "systemctl restart api"',
      reasons: ['network_egress', 'external_mutation'],
      external_mutations: [{ kind: 'service_change', action: 'restart', target: 'api' }],
    });
    await flush();

    expect(h.dialogs[0]).toMatchObject({ allowRun: false, showModeControl: true, choices: ['allow_once'] });
    expect(h.dialogs[0].message).toContain('changes an external system');
    expect(h.dialogs[0].message).toContain('Detected:\nService change · restart · api');
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'bash.permission_response', payload: { request_id: 'req-external-mutation', decision: 'allow_once' } },
    ]);
  });

  it('does not persist a changed level when the user denies the request', async () => {
    const h = loadHarness({ choice: 'deny', mode: 'all_files_auto' });

    h.pushHandler({
      request_id: 'req-deny',
      agent_name: 'Agent',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'bash.permission_response', payload: { request_id: 'req-deny', decision: 'deny' } },
    ]);
  });

  it('denies the sensitive operation when its selected mode cannot be persisted', async () => {
    const h = loadHarness({ choice: 'allow_once', mode: 'all_files_auto' }, async (channel) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
      if (channel === 'permissions.setLocalExecMode') return { ok: false };
      return { handled: true };
    });

    h.pushHandler({
      request_id: 'req-mode-failed',
      agent_name: 'Agent',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'permissions.setLocalExecMode', payload: { mode: 'all_files_auto' } },
      { channel: 'bash.permission_response', payload: { request_id: 'req-mode-failed', decision: 'deny' } },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'success',
      decision: 'allow_once',
      effective_decision: 'deny',
      mode: 'all_files_approval',
      mode_changed: false,
    }));
  });

  it('marks a verdict cancelled when main reports that the request is stale', async () => {
    const h = loadHarness('allow_once', async (channel) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
      if (channel === 'bash.permission_response') return { ok: true, handled: false };
      return { ok: true };
    });

    h.pushHandler({
      request_id: 'req-stale',
      agent_name: 'Agent',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'cancelled',
      decision: 'allow_once',
      effective_decision: 'allow_once',
      error_type: 'state',
      error_code: 'stale_request',
    }));
  });

  it('keeps a resolved IPC rejection in the terminal failure denominator', async () => {
    const h = loadHarness('deny', async (channel) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
      if (channel === 'bash.permission_response') return { ok: false, error: '/private/request' };
      return { ok: true };
    });

    h.pushHandler({
      request_id: 'req-rejected',
      agent_name: 'Agent',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'failure',
      decision: 'deny',
      error_type: 'ipc',
      error_code: 'response_failed',
    }));
    expect(JSON.stringify(h.monitorEvent.mock.calls)).not.toContain('/private/request');
  });

  it('closes a cancelled prompt without sending a stale renderer response', async () => {
    const h = loadHarness('pending');

    h.pushHandler({
      request_id: 'req-cancelled',
      agent_name: 'Agent',
      command: 'rm protected.txt',
      reasons: ['network_egress'],
    });
    await flush();
    h.cancelHandler({ request_ids: ['req-cancelled'], cid: 'c1' });
    await flush();

    expect(h.dialogs).toHaveLength(1);
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_requested', expect.any(Object));
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_presented', expect.any(Object));
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'cancelled',
      decision: 'none',
      effective_decision: 'deny',
      error_type: 'state',
      error_code: 'request_cancelled',
    }));
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_result')).toHaveLength(1);
  });

  it('records cancellation during mode lookup without claiming presentation', async () => {
    let resolveMode!: (value: { ok: boolean; mode: string }) => void;
    const modeLookup = new Promise<{ ok: boolean; mode: string }>((resolve) => { resolveMode = resolve; });
    const h = loadHarness('deny', async (channel) => {
      if (channel === 'permissions.getLocalExec') return modeLookup;
      return { handled: true };
    });

    h.pushHandler({ request_id: 'req-before-presented', reasons: ['destructive'] });
    await flush();
    h.cancelHandler({ request_ids: ['req-before-presented'] });
    resolveMode({ ok: true, mode: 'all_files_approval' });
    await flush();

    expect(h.dialogs).toHaveLength(0);
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
    ]);
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_requested')).toHaveLength(1);
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_presented')).toHaveLength(0);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'cancelled',
      error_code: 'request_cancelled',
    }));
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_result')).toHaveLength(1);
  });

  it('records a queued cancellation without claiming that its dialog was presented', async () => {
    const h = loadHarness('pending');

    h.pushHandler({ request_id: 'req-open', reasons: ['destructive'] });
    h.pushHandler({ request_id: 'req-queued', reasons: ['network_egress'] });
    await flush();
    h.cancelHandler({ request_ids: ['req-queued'] });
    await flush();

    const presented = h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_presented');
    expect(presented).toHaveLength(1);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'cancelled',
      categories: 'network_egress',
      error_code: 'request_cancelled',
    }));
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_result')).toHaveLength(1);
  });

  it('declines on Escape but leaves an IME composition alone', async () => {
    const h = loadHarness('pending');

    h.pushHandler({
      request_id: 'req-escape',
      agent_name: 'Agent',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();
    expect(h.openDialogs()).toBe(1);

    // Escape during IME composition belongs to the IME, not to the dialog.
    for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
      h.keydown({ key: 'Escape', ...composing });
      await flush();
      expect(h.openDialogs()).toBe(1);
      expect(h.invokeCalls.some((call) => call.channel === 'bash.permission_response')).toBe(false);
    }

    h.keydown({ key: 'Escape' });
    await flush();
    expect(h.openDialogs()).toBe(0);
    expect(h.invokeCalls.at(-1)).toEqual({
      channel: 'bash.permission_response', payload: { request_id: 'req-escape', decision: 'deny' },
    });
  });
});
