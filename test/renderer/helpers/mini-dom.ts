// Minimal DOM double for classic renderer modules run in `node:vm`. jsdom and
// happy-dom are not project dependencies, so journey tests that need real
// template markup, selector lookup and event bubbling across several shipped
// modules (dialogs.js, saved-apps.js, app-publishing.js) share this one double
// instead of each re-implementing a partial element class. It supports the
// subset those modules use: element/text nodes, innerHTML parsing of
// well-formed templates, compound/descendant selectors with `:not()` and
// `:disabled`, capture/bubble dispatch with `on<type>` handlers, and focus.
// Layout, CSS and real focus events are out of scope.

type Listener = { fn: (event: any) => void; capture: boolean };
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const decode = (text: string) => text.replace(/&(#?\w+);/g, (m, name) => ENTITIES[name] ?? m);
const encode = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);

export class MiniEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: any = null;
  currentTarget: any = null;
  isComposing = false;
  keyCode = 0;
  shiftKey = false;
  key?: string;
  constructor(readonly type: string, init: Record<string, any> = {}) { Object.assign(this, init); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

abstract class MiniNode {
  parentNode: MiniElement | null = null;
  readonly listeners = new Map<string, Listener[]>();
  constructor(readonly ownerDocument: MiniDocument) {}
  abstract get textContent(): string;
  get isConnected(): boolean {
    let node: MiniNode | null = this;
    while (node) { if (node === this.ownerDocument.documentElement) return true; node = node.parentNode; }
    return false;
  }
  get parentElement(): MiniElement | null { return this.parentNode; }
  remove(): void {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  addEventListener(type: string, fn: (event: any) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.set(type, [...(this.listeners.get(type) || []), { fn, capture }]);
  }
  removeEventListener(type: string, fn: (event: any) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.fn !== fn || item.capture !== capture));
  }
  dispatchEvent(event: MiniEvent): boolean {
    event.target = this;
    const path: any[] = [];
    for (let node: any = this; node; node = node.parentNode) path.push(node);
    if (this.isConnected) path.push(this.ownerDocument);
    const fire = (node: any, phase: 'capture' | 'target' | 'bubble') => {
      event.currentTarget = node;
      for (const item of [...(node.listeners.get(event.type) || [])]) {
        if (phase === 'capture' && !item.capture) continue;
        if (phase === 'bubble' && item.capture) continue;
        item.fn.call(node, event);
      }
      if (phase !== 'capture' && typeof node['on' + event.type] === 'function') node['on' + event.type](event);
    };
    for (const node of [...path].reverse().slice(0, -1)) { fire(node, 'capture'); if (event.propagationStopped) return !event.defaultPrevented; }
    fire(this, 'target');
    for (const node of path.slice(1)) { if (event.propagationStopped) break; fire(node, 'bubble'); }
    return !event.defaultPrevented;
  }
}

export class MiniText extends MiniNode {
  constructor(doc: MiniDocument, public data: string) { super(doc); }
  get textContent(): string { return this.data; }
  set textContent(value: string) { this.data = String(value); }
}

class MiniClassList {
  constructor(private readonly element: MiniElement) {}
  private get values(): string[] { return (this.element.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  private set values(next: string[]) { this.element.setAttribute('class', [...new Set(next)].join(' ')); }
  add(...names: string[]) { this.values = [...this.values, ...names]; }
  remove(...names: string[]) { this.values = this.values.filter(name => !names.includes(name)); }
  contains(name: string) { return this.values.includes(name); }
  toggle(name: string, force?: boolean) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

export class MiniElement extends MiniNode {
  readonly childNodes: MiniNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly classList = new MiniClassList(this);
  readonly style: Record<string, string> = {};
  readonly localName: string;
  value = '';
  checked = false;
  scrollTop = 0;
  [handler: `on${string}`]: any;
  readonly dataset: Record<string, string>;
  constructor(doc: MiniDocument, tag: string) {
    super(doc);
    this.localName = tag.toLowerCase();
    const attr = (key: string) => 'data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, key: string) => this.attributes.get(attr(key)),
      set: (_t, key: string, value) => { this.setAttribute(attr(key), String(value)); return true; },
      has: (_t, key: string) => this.attributes.has(attr(key)),
    });
  }
  get tagName(): string { return this.localName.toUpperCase(); }
  get id(): string { return this.getAttribute('id') || ''; }
  set id(value: string) { this.setAttribute('id', value); }
  get className(): string { return this.getAttribute('class') || ''; }
  set className(value: string) { this.setAttribute('class', value); }
  get type(): string { return this.getAttribute('type') || ''; }
  set type(value: string) { this.setAttribute('type', value); }
  get disabled(): boolean { return this.attributes.has('disabled'); }
  set disabled(value: boolean) { this.toggleAttribute('disabled', !!value); }
  get hidden(): boolean { return this.attributes.has('hidden'); }
  set hidden(value: boolean) { this.toggleAttribute('hidden', !!value); }
  get tabIndex(): number {
    const raw = this.getAttribute('tabindex');
    if (raw != null) return Number(raw);
    return ['button', 'input', 'textarea', 'select', 'a'].includes(this.localName) ? 0 : -1;
  }
  set tabIndex(value: number) { this.setAttribute('tabindex', String(value)); }
  get title(): string { return this.getAttribute('title') || ''; }
  set title(value: string) { this.setAttribute('title', value); }
  get children(): MiniElement[] { return this.childNodes.filter((node): node is MiniElement => node instanceof MiniElement); }
  get childElementCount(): number { return this.children.length; }
  get offsetParent(): MiniElement | null {
    if (!this.isConnected) return null;
    for (let node: MiniElement | null = this; node; node = node.parentNode) if (node.hidden || node.style.display === 'none') return null;
    return this.parentNode;
  }
  get textContent(): string { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value: string) {
    for (const node of [...this.childNodes]) node.remove();
    if (value != null && String(value) !== '') this.appendChild(new MiniText(this.ownerDocument, String(value)));
  }
  get innerHTML(): string { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html: string) {
    for (const node of [...this.childNodes]) node.remove();
    parseInto(this, String(html));
  }
  getAttribute(name: string): string | null { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  toggleAttribute(name: string, force: boolean): void { if (force) this.attributes.set(name, ''); else this.attributes.delete(name); }
  appendChild<T extends MiniNode>(node: T): T {
    node.remove();
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  cloneNode(deep = false): MiniElement {
    const copy = new MiniElement(this.ownerDocument, this.localName);
    for (const [name, value] of this.attributes) copy.setAttribute(name, value);
    Object.assign(copy.style, this.style);
    if (deep) for (const child of this.childNodes) copy.appendChild(child instanceof MiniElement
      ? child.cloneNode(true) : new MiniText(this.ownerDocument, child.textContent));
    return copy;
  }
  replaceChild<T extends MiniNode>(next: MiniNode, previous: T): T {
    if (previous.parentNode !== this) throw new Error('Child not found');
    next.remove();
    const index = this.childNodes.indexOf(previous);
    this.childNodes[index] = next; next.parentNode = this; previous.parentNode = null;
    return previous;
  }
  append(...nodes: Array<MiniNode | string>): void {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new MiniText(this.ownerDocument, node) : node);
  }
  replaceChildren(...nodes: Array<MiniNode | string>): void {
    for (const node of [...this.childNodes]) node.remove();
    this.append(...nodes);
  }
  contains(node: MiniNode | null): boolean {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  descendants(): MiniElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector: string): boolean { return splitList(selector).some(item => matchComplex(this, item)); }
  closest(selector: string): MiniElement | null {
    for (let node: MiniElement | null = this; node; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): MiniElement[] { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector: string): MiniElement | null { return this.querySelectorAll(selector)[0] || null; }
  focus(): void { if (this.isConnected) this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click(): void { if (!this.disabled) this.dispatchEvent(new MiniEvent('click', { bubbles: true })); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

export class MiniDocument {
  readonly listeners = new Map<string, Listener[]>();
  readonly documentElement: MiniElement;
  readonly body: MiniElement;
  activeElement: MiniElement | null;
  constructor() {
    this.documentElement = new MiniElement(this, 'html');
    this.body = this.documentElement.appendChild(new MiniElement(this, 'body'));
    this.activeElement = this.body;
  }
  get parentNode() { return null; }
  createElement(tag: string): MiniElement { return new MiniElement(this, tag); }
  createElementNS(_ns: string, tag: string): MiniElement { return new MiniElement(this, tag); }
  createTextNode(text: string): MiniText { return new MiniText(this, text); }
  getElementById(id: string): MiniElement | null { return this.documentElement.descendants().find(node => node.id === id) || null; }
  querySelectorAll(selector: string): MiniElement[] { return this.documentElement.querySelectorAll(selector); }
  querySelector(selector: string): MiniElement | null { return this.documentElement.querySelector(selector); }
  contains(node: MiniNode | null): boolean { return this.documentElement.contains(node); }
  addEventListener = MiniElement.prototype.addEventListener;
  removeEventListener = MiniElement.prototype.removeEventListener;
  /** Dispatch a keydown from the focused element, as a real key press would. */
  press(key: string, init: Record<string, any> = {}): MiniEvent {
    const event = new MiniEvent('keydown', { key, ...init });
    (init.target || this.activeElement || this.body).dispatchEvent(event);
    return event;
  }
}

/** Visible text with `<br>` as a line break, the way a user reads a dialog message. */
export function visibleText(node: MiniNode): string {
  if (node instanceof MiniText) return node.data;
  const element = node as MiniElement;
  if (element.localName === 'br') return '\n';
  return element.childNodes.map(visibleText).join('');
}

function serialize(node: MiniNode): string {
  if (node instanceof MiniText) return encode(node.data);
  const element = node as MiniElement;
  const attrs = [...element.attributes].map(([key, value]) => value === '' ? ` ${key}` : ` ${key}="${encode(value)}"`).join('');
  if (VOID_TAGS.has(element.localName)) return `<${element.localName}${attrs} />`;
  return `<${element.localName}${attrs}>${element.innerHTML}</${element.localName}>`;
}

function parseInto(root: MiniElement, html: string): void {
  const doc = root.ownerDocument;
  const stack: MiniElement[] = [root];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html))) {
    const top = stack[stack.length - 1];
    if (match[5] != null) {
      if (match[5].trim() || top.localName === 'textarea') top.appendChild(new MiniText(doc, decode(match[5])));
    } else if (match[1]) {
      const tag = match[1].toLowerCase();
      const index = stack.map(item => item.localName).lastIndexOf(tag);
      if (index > 0) stack.length = index;
    } else if (match[2]) {
      const element = new MiniElement(doc, match[2]);
      for (const attr of (match[3] || '').matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        element.setAttribute(attr[1].toLowerCase(), decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      }
      if (element.hasAttribute('value')) element.value = element.getAttribute('value')!;
      top.appendChild(element);
      if (!VOID_TAGS.has(element.localName) && !match[4]) stack.push(element);
    }
  }
  for (const textarea of [root, ...root.descendants()].filter(node => node.localName === 'textarea')) textarea.value = textarea.textContent;
}

function splitTop(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0, quote = '', current = '';
  for (const char of text) {
    if (quote) { if (char === quote) quote = ''; current += char; continue; }
    if (char === '"' || char === "'") quote = char;
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (depth === 0 && separator.test(char)) { if (current.trim()) parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
const splitList = (selector: string) => splitTop(selector, /,/);

function matchComplex(element: MiniElement, selector: string): boolean {
  const parts = splitTop(selector, /\s/);
  if (!matchCompound(element, parts[parts.length - 1])) return false;
  let node = element.parentNode;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (node && !matchCompound(node, parts[index])) node = node.parentNode;
    if (!node) return false;
    node = node.parentNode;
  }
  return true;
}

function matchCompound(element: MiniElement, compound: string): boolean {
  const pattern = /^(?:([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:not\(((?:[^()]|\([^()]*\))*)\)|:(disabled))/;
  let rest = compound;
  while (rest) {
    const match = pattern.exec(rest);
    if (!match) throw new Error(`mini-dom: unsupported selector "${compound}"`);
    rest = rest.slice(match[0].length);
    if (match[1] && match[1] !== '*' && element.localName !== match[1].toLowerCase()) return false;
    if (match[2] && element.id !== match[2]) return false;
    if (match[3] && !element.classList.contains(match[3])) return false;
    if (match[4]) {
      const expected = match[5] ?? match[6] ?? match[7];
      if (!element.hasAttribute(match[4])) return false;
      if (expected !== undefined && element.getAttribute(match[4]) !== expected) return false;
    }
    if (match[8] !== undefined && element.matches(match[8])) return false;
    if (match[9] && !element.disabled) return false;
  }
  return true;
}
