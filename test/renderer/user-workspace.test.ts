import { describe, it, expect, beforeEach } from 'vitest';

type Dataset = Record<string, string>;

class FakeElement {
  tagName: string;
  className = '';
  dataset: Dataset = {};
  parentNode: FakeElement | null = null;
  childNodes: FakeElement[] = [];
  type = '';
  title = '';
  innerHTML = '';

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  get nextSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index >= 0 ? (this.parentNode.childNodes[index + 1] || null) : null;
  }

  get classList() {
    return {
      contains: (cls: string) => this.className.split(/\s+/).filter(Boolean).includes(cls),
      add: (cls: string) => {
        if (!this.classList.contains(cls)) this.className = `${this.className} ${cls}`.trim();
      },
      remove: (cls: string) => {
        this.className = this.className.split(/\s+/).filter((part) => part && part !== cls).join(' ');
      },
    };
  }

  appendChild(child: FakeElement) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: FakeElement, ref: FakeElement | null) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    if (index >= 0) this.childNodes.splice(index, 0, child);
    else this.childNodes.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }

  addEventListener() {}

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.childNodes) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  matches(selector: string): boolean {
    const match = selector.match(/^\.([a-z0-9_-]+)(?:\[data-ws-target="([^"]+)"\])?$/i);
    if (!match) return false;
    const [, className, wsTarget] = match;
    if (!this.classList.contains(className)) return false;
    return !wsTarget || this.dataset.wsTarget === wsTarget;
  }
}

function makeBar() {
  const bar = new FakeElement('div');
  bar.className = 'chat-bottom-bar';
  const recipient = new FakeElement('button');
  recipient.className = 'chat-recipient-chip';
  const skill = new FakeElement('div');
  skill.className = 'chat-skill-chip';
  const send = new FakeElement('button');
  send.className = 'chat-send-btn';
  bar.appendChild(recipient);
  bar.appendChild(skill);
  bar.appendChild(send);
  return { bar, recipient, skill, send };
}

function loadUserWorkspace() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = {
    createElement: (tagName: string) => new FakeElement(tagName),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    uiIconHtml: () => '<span class="workspace-chip-chevron"></span>',
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).t = (key: string) => ({
    'workspace.chip_title': 'Pick workspace',
    'workspace.chip_label': 'Workspace: ',
  } as Record<string, string>)[key] || key;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).escapeHtml = (value: unknown) => String(value ?? '');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/renderer/modules/user-workspace.js') as {
    _mountWorkspaceChipInBar: (bar: FakeElement, target: string) => FakeElement | null;
  };
}

describe('user workspace chip mount', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../../src/renderer/modules/user-workspace.js')];
  });

  it('is idempotent for the same composer target', () => {
    const { _mountWorkspaceChipInBar } = loadUserWorkspace();
    const { bar, recipient, skill } = makeBar();

    const first = _mountWorkspaceChipInBar(bar, 'new-chat');
    const second = _mountWorkspaceChipInBar(bar, 'new-chat');

    expect(second).toBe(first);
    expect(bar.querySelectorAll('.workspace-chip[data-ws-target="new-chat"]')).toHaveLength(1);
    expect(bar.childNodes).toEqual([recipient, first, skill, bar.querySelector('.chat-send-btn')]);
  });

  it('removes duplicate chips left by a repeated boot', () => {
    const { _mountWorkspaceChipInBar } = loadUserWorkspace();
    const { bar } = makeBar();

    const first = _mountWorkspaceChipInBar(bar, 'conversation');
    const duplicate = new FakeElement('button');
    duplicate.className = 'workspace-chip';
    duplicate.dataset.wsTarget = 'conversation';
    bar.appendChild(duplicate);

    const mounted = _mountWorkspaceChipInBar(bar, 'conversation');

    expect(mounted).toBe(first);
    expect(duplicate.parentNode).toBeNull();
    expect(bar.querySelectorAll('.workspace-chip[data-ws-target="conversation"]')).toHaveLength(1);
  });
});
