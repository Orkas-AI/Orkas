import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type Listener = (event?: any) => void;

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  add(...names: string[]): void {
    const values = new Set(this.element.className.split(/\s+/).filter(Boolean));
    names.forEach((name) => values.add(name));
    this.element.className = [...values].join(' ');
  }

  remove(...names: string[]): void {
    const rejected = new Set(names);
    this.element.className = this.element.className
      .split(/\s+/)
      .filter((name) => name && !rejected.has(name))
      .join(' ');
  }

  contains(name: string): boolean {
    return this.element.className.split(/\s+/).includes(name);
  }
}

class FakeElement {
  className = '';
  id = '';
  value = '';
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly classList = new FakeClassList(this);
  parent: FakeElement | null = null;
  selected = false;
  removed = false;
  private html = '';

  constructor(
    readonly tagName: string,
    private readonly ownerDocument: FakeDocument,
  ) {}

  set innerHTML(value: string) {
    this.html = value;
    this.children.length = 0;
    for (const match of value.matchAll(
      /<button class="([^"]*)" data-act="([^"]+)"(?: data-id="([^"]*)")?[^>]*>/g,
    )) {
      const button = new FakeElement('button', this.ownerDocument);
      button.className = match[1];
      button.dataset.act = match[2];
      if (match[3] !== undefined) button.dataset.id = match[3];
      this.appendChild(button);
    }
    if (value.includes('class="ui-dialog-input"')) {
      const input = new FakeElement('input', this.ownerDocument);
      input.className = 'ui-dialog-input';
      this.appendChild(input);
    }
  }

  get innerHTML(): string {
    return this.html;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  contains(target: FakeElement): boolean {
    return target === this || this.descendants().includes(target);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    child.removed = false;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    this.parent = null;
    this.removed = true;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click(): void {
    for (const listener of this.listeners.get('click') || []) listener({ target: this });
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  select(): void {
    this.selected = true;
  }

  closest(selector: string): FakeElement | null {
    if (
      ['button', 'input', 'textarea', 'select', 'a'].includes(this.tagName)
      && /button|input|textarea|select|a/.test(selector)
    ) return this;
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === '.ui-dialog-input') {
      return this.descendants().find((element) => element.classList.contains('ui-dialog-input')) || null;
    }
    const action = selector.match(/^\[data-act="([^"]+)"\]$/)?.[1];
    if (action) return this.descendants().find((element) => element.dataset.act === action) || null;
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '[data-act="choice"]') {
      return this.descendants().filter((element) => element.dataset.act === 'choice');
    }
    return [];
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

class FakeDocument {
  readonly body = new FakeElement('body', this);
  readonly listeners = new Map<string, Listener[]>();
  activeElement: FakeElement | null = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  contains(target: FakeElement): boolean {
    return target === this.body || this.body.descendants().includes(target);
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '.ui-dialog-overlay.open') {
      return this.body.descendants().filter((element) => (
        element.classList.contains('ui-dialog-overlay')
        && element.classList.contains('open')
      ));
    }
    return [];
  }

  dispatchKey(event: Record<string, unknown>): void {
    const enriched: any = {
      isComposing: false,
      keyCode: 0,
      preventDefault() {},
      ...event,
    };
    for (const listener of [...(this.listeners.get('keydown') || [])]) listener(enriched);
  }
}

function loadDialogs() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/dialogs.js'),
    'utf8',
  );
  const document = new FakeDocument();
  const timers: Array<() => void> = [];
  const nameLimitBindings: FakeElement[] = [];
  const context: any = {
    console,
    document,
    window: {
      bindNameLimitControl: (input: FakeElement) => nameLimitBindings.push(input),
    },
    t: (key: string) => ({
      'common.cancel': 'Cancel',
      'common.confirm': 'Confirm',
    } as Record<string, string>)[key] || key,
    escapeHtml: (value: unknown) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;'),
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout: (callback: () => void, delay = 0) => {
      if (delay === 0) callback();
      else timers.push(callback);
      return timers.length;
    },
    _document: document,
    _timers: timers,
    _nameLimitBindings: nameLimitBindings,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'dialogs.js' });
  return context;
}

function overlays(ctx: any): FakeElement[] {
  return ctx._document.querySelectorAll('.ui-dialog-overlay.open');
}

describe('shared renderer dialogs', () => {
  it('keeps cancel keyboard intent, exposes an accessible name, escapes text, and restores focus', async () => {
    const ctx = loadDialogs();
    const background = ctx._document.createElement('button');
    ctx._document.body.appendChild(background);
    background.focus();

    const result = ctx.uiConfirm({
      message: '<img src=x onerror=steal()>\\nDelete the item?',
      okLabel: 'Delete',
      cancelLabel: 'Keep',
    });
    const overlay = overlays(ctx)[0];
    const ok = overlay.querySelector('[data-act="ok"]')!;
    const cancel = overlay.querySelector('[data-act="cancel"]')!;

    expect(overlay.innerHTML).not.toContain('<img src=x');
    expect(overlay.innerHTML).toContain('&lt;img src=x onerror=steal()&gt;');
    const messageId = overlay.innerHTML.match(/id="(ui-dialog-\d+-message)"/)?.[1];
    expect(messageId).toBeTruthy();
    expect(overlay.innerHTML).toContain(`aria-labelledby="${messageId}"`);
    expect(ctx._document.activeElement).toBe(ok);

    cancel.focus();
    ctx._document.dispatchKey({ key: 'Enter', keyCode: 13, target: cancel });
    if (ctx._document.contains(overlay)) cancel.click();

    await expect(result).resolves.toBe(false);
    expect(ctx._document.activeElement).toBe(background);
  });

  it('announces alerts as named alert dialogs and settles from the only action', async () => {
    const ctx = loadDialogs();
    const result = ctx.uiAlert('Could not save the file');
    const overlay = overlays(ctx)[0];

    expect(overlay.innerHTML).toContain('role="alertdialog"');
    expect(overlay.innerHTML).toMatch(
      /aria-labelledby="(ui-dialog-\d+-message)"[\s\S]*id="\1">Could not save the file/,
    );
    expect(overlay.querySelector('[data-act="cancel"]')).toBeNull();
    overlay.querySelector('[data-act="ok"]')!.click();

    await expect(result).resolves.toBeUndefined();
  });

  it('allows only the topmost concurrent dialog to consume Escape', async () => {
    const ctx = loadDialogs();
    let firstResult: boolean | undefined;
    let secondResult: boolean | undefined;
    const first = ctx.uiConfirm('First decision').then((value: boolean) => { firstResult = value; });
    const second = ctx.uiConfirm('Second decision').then((value: boolean) => { secondResult = value; });

    expect(overlays(ctx)).toHaveLength(2);
    ctx._document.dispatchKey({ key: 'Escape', keyCode: 27, target: ctx._document.activeElement });
    await Promise.resolve();

    expect(secondResult).toBe(false);
    expect(firstResult).toBeUndefined();
    expect(overlays(ctx)).toHaveLength(1);

    ctx._document.dispatchKey({ key: 'Escape', keyCode: 27, target: ctx._document.activeElement });
    await Promise.all([first, second]);
    expect(firstResult).toBe(false);
    expect(overlays(ctx)).toHaveLength(0);
  });

  it('removes externally cancelled confirm and choice dialogs without user input', async () => {
    const ctx = loadDialogs();
    const confirmController = new AbortController();
    const confirm = ctx.uiConfirm({
      message: 'Stale confirmation',
      signal: confirmController.signal,
    });
    expect(overlays(ctx)).toHaveLength(1);

    confirmController.abort();
    await expect(confirm).resolves.toBe(false);
    expect(overlays(ctx)).toHaveLength(0);

    const choiceController = new AbortController();
    const choice = ctx.uiChoice({
      message: 'Stale choice',
      choices: [{ id: 'allow', label: 'Allow' }],
      signal: choiceController.signal,
    });
    expect(overlays(ctx)).toHaveLength(1);

    choiceController.abort();
    await expect(choice).resolves.toBeNull();
    expect(overlays(ctx)).toHaveLength(0);
  });

  it('keeps IME composition inside an accessible prompt and returns the final input value', async () => {
    const ctx = loadDialogs();
    let settled = false;
    const result = ctx.uiPrompt('Rename this item', 'draft', { nameLimit: true })
      .then((value: string | null) => {
        settled = true;
        return value;
      });
    const overlay = overlays(ctx)[0];
    const input = overlay.querySelector('.ui-dialog-input')!;

    expect(overlay.innerHTML).toMatch(/aria-labelledby="ui-dialog-\d+-message"/);
    expect(overlay.innerHTML).toMatch(/class="ui-dialog-input"[^>]+aria-labelledby="ui-dialog-\d+-message"/);
    expect(input.value).toBe('draft');
    expect(input.selected).toBe(true);
    expect(ctx._nameLimitBindings).toEqual([input]);

    input.value = '最终名称';
    ctx._document.dispatchKey({
      key: 'Enter',
      keyCode: 229,
      isComposing: true,
      target: input,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    ctx._document.dispatchKey({ key: 'Enter', keyCode: 13, target: input });
    await expect(result).resolves.toBe('最终名称');
  });

  it('requires an explicit danger or choice button and returns its stable value', async () => {
    const ctx = loadDialogs();
    const dangerResult = ctx.uiConfirmDanger({
      title: 'Delete permanently?',
      message: 'This cannot be undone.',
      dangerLabel: 'Delete',
    });
    let overlay = overlays(ctx)[0];
    const danger = overlay.querySelector('[data-act="ok"]')!;
    expect(ctx._document.activeElement).toBe(overlay.querySelector('[data-act="cancel"]'));
    ctx._document.dispatchKey({ key: 'Enter', keyCode: 13, target: overlay });
    expect(ctx._document.contains(overlay)).toBe(true);
    danger.click();
    await expect(dangerResult).resolves.toBe(true);

    const choiceResult = ctx.uiChoice({
      title: 'Keep data?',
      message: 'Choose one path.',
      choices: [
        { id: 'local', label: 'Keep locally' },
        { id: 'purge', label: 'Delete <everywhere>', style: 'danger' },
      ],
    });
    overlay = overlays(ctx)[0];
    expect(overlay.innerHTML).toContain('Delete &lt;everywhere&gt;');
    const choices = overlay.querySelectorAll('[data-act="choice"]');
    choices.find((choice) => choice.dataset.id === 'purge')!.click();
    await expect(choiceResult).resolves.toBe('purge');
  });

  it('renders bounded, dismissible, non-HTML toasts and ignores empty messages', () => {
    const ctx = loadDialogs();

    expect(ctx.uiToast('   ')).toBeNull();
    const control = ctx.uiToast('<script>steal()</script>', {
      variant: 'not-a-variant',
      timeoutMs: 99_999,
    });
    const host = ctx._document.body.children.find(
      (element: FakeElement) => element.classList.contains('ui-toast-host'),
    )!;
    const toast = host.children[0];

    expect(control.id).toBe(toast.id);
    expect(toast.className).toContain('is-info');
    expect(toast.attributes.get('role')).toBe('status');
    expect(toast.innerHTML).toContain('&lt;script&gt;steal()&lt;/script&gt;');
    expect(toast.innerHTML).not.toContain('<script>steal()</script>');

    control.close();
    control.close();
    expect(toast.classList.contains('is-leaving')).toBe(true);
    for (const timer of ctx._timers.splice(0)) timer();
    expect(ctx._document.contains(toast)).toBe(false);
  });
});
