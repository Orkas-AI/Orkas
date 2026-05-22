import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type FakeButton = {
  dataset: Record<string, string>;
  style: Record<string, string>;
  disabled: boolean;
  textContent: string;
  innerHTML: string;
  classList: {
    add: (cls: string) => void;
    remove: (cls: string) => void;
    contains: (cls: string) => boolean;
  };
  addEventListener: () => void;
};

function makeButton(): FakeButton {
  const classes = new Set<string>();
  return {
    dataset: {},
    style: { display: 'none' },
    disabled: false,
    textContent: '',
    innerHTML: '',
    classList: {
      add: (cls: string) => { classes.add(cls); },
      remove: (cls: string) => { classes.delete(cls); },
      contains: (cls: string) => classes.has(cls),
    },
    addEventListener: () => {},
  };
}

function loadMarketplaceDev(button: FakeButton, opts: { isDev?: boolean } = {}): any {
  const code = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/marketplace_dev.js'),
    'utf8',
  );
  const context: any = {
    document: {
      addEventListener: () => {},
      querySelector: (selector: string) => (
        selector === '[data-mp-detail-delete]' ? button : null
      ),
    },
    escapeHtml: (s: unknown) => String(s ?? ''),
    isDevMode: () => opts.isDev !== false,
    t: (key: string) => ({
      'marketplace.delete': 'Delete',
      'marketplace.deleting': 'Deleting...',
      'marketplace.tab_agent': 'Agents',
      'marketplace.tab_skill': 'Skills',
      'marketplace.delete_confirm_title': 'Delete item',
      'marketplace.delete_confirm_msg': 'Delete {kind} {name}?',
      'marketplace.delete_ok': 'Deleted',
      'marketplace.delete_failed': 'Delete failed: {reason}',
    } as Record<string, string>)[key] || key,
    uiConfirmDanger: async () => true,
    uiAlert: async () => {},
    window: { orkas: { invoke: async () => ({ ok: true }) } },
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'marketplace_dev.js' });
  return context;
}

describe('marketplace dev delete button', () => {
  it('re-enables the shared detail delete button when rendering a new item', () => {
    const button = makeButton();
    button.disabled = true;
    button.classList.add('is-disabled');
    button.innerHTML = '<span class="marketplace-btn-spinner"></span>Deleting...';
    const ctx = loadMarketplaceDev(button);

    ctx.onMarketplaceDetailRendered({ kind: 'skill', item: { id: 'skill1' } });

    expect(button.disabled).toBe(false);
    expect(button.classList.contains('is-disabled')).toBe(false);
    expect(button.textContent).toBe('Delete');
    expect(button.dataset).toMatchObject({ id: 'skill1', kind: 'skill' });
    expect(button.style.display).toBe('');
  });

  it('keeps the button hidden when the renderer is not in dev mode', () => {
    const button = makeButton();
    const ctx = loadMarketplaceDev(button, { isDev: false });

    ctx.onMarketplaceDetailRendered({ kind: 'skill', item: { id: 'skill1' } });

    expect(button.style.display).toBe('none');
    expect(button.disabled).toBe(false);
  });
});
