import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { LocalAppData } from '../../../src/main/features/web_apps/data';

const root = path.resolve('resources/builtin/system/skills/web-app-sdk/assets/web');
const source = () => fs.readFileSync(path.join(root, 'index.html'), 'utf8').split('<script>')[1].split('</script>')[0];
const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'orkas-app.json'), 'utf8'));
type Data = { query: (args: any) => Promise<any>; insert?: (args: any) => Promise<any> };
function mount(data: Data) {
  const node = () => ({ textContent: '', value: '', disabled: false, hidden: false, children: [] as any[],
    onclick: undefined as undefined | (() => Promise<void>),
    replaceChildren(...rows: any[]) { this.children = rows; }, append(...rows: any[]) { this.children.push(...rows); }, focus() {} });
  const input = node(), save = node(), list = node(), saveStatus = node(), listStatus = node(), more = node(), refresh = node(), retry = node();
  const form = { body: input, querySelector: () => save, reset() { input.value = ''; }, onsubmit: undefined as any };
  const ids: Record<string, any> = { message: input, save, messages: list, saveStatus, listStatus, more, refresh, retry };
  const queries: any[] = [], pending = new Set<Promise<any>>();
  let idsIssued = 0;
  vm.runInNewContext(source(), {
    window: { orkasApp: { data: { ...data, query(args: any) {
      queries.push(structuredClone(args));
      const work = data.query(args); pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
    } } } },
    document: { getElementById: (id: string) => ids[id], createElement: node,
      querySelector: (selector: string) => selector === 'form' ? form : selector === 'ul' ? list : selector === '[role=status]' ? saveStatus : input },
    crypto: { randomUUID: () => `request-${++idsIssued}` },
  }, { timeout: 1000 });
  return { input, save, list, saveStatus, listStatus, more, refresh, retry, queries,
    bodies: () => list.children.map(row => row.textContent),
    submit: () => form.onsubmit({ preventDefault() {} }),
    async idle() { while (pending.size) await Promise.allSettled([...pending]); for (let i = 0; i < 4; i++) await Promise.resolve(); },
  };
}
const records = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `id-${String(index).padStart(3, '0')}`, body: `Message ${index}` }));
const query = (rows: any[]) => async (args: any) => ({ records: rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 20)) });

describe('Official web data starter user outcomes', () => {
  it.each([0, 19, 20, 21, 101])('exposes every persisted message at the %i-record boundary and after reopening', async count => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-starter-pages-'));
    let db = new LocalAppData(path.join(dir, 'data.sqlite'), dir, manifest().data);
    try {
      for (let i = 0; i < count; i++) await db.call('data.insert', { table: 'messages', values: { body: `Message ${i}` } });
      for (const reopen of [false, true]) {
        if (reopen) { await db.close(); db = new LocalAppData(path.join(dir, 'data.sqlite'), dir, manifest().data); }
        const app = mount({ query: args => db.call('data.query', args) }); await app.idle();
        expect(app.bodies()).toHaveLength(Math.min(count, 20));
        expect(app.queries).toHaveLength(1);
        for (let page = 0; !app.more.hidden && page < 7; page++) { expect(app.more.onclick).toBeTypeOf('function'); await app.more.onclick!(); }
        expect(app.bodies().sort()).toEqual(Array.from({ length: count }, (_, i) => `Message ${i}`).sort());
        expect(app.more.hidden).toBe(true);
        expect(app.listStatus.textContent).toContain(count ? 'All' : 'No messages');
        expect(app.queries.every(args => args.limit === 20 && args.order.field === 'id' && args.order.direction === 'asc')).toBe(true);
      }
    } finally { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves visible messages on a failed next page or refresh and retries that read explicitly', async () => {
    const rows = records(21); let fail = false;
    const app = mount({ query: async args => { if (fail) throw { code: 'E_BUSY' }; return query(rows)(args); } });
    await app.idle(); const first = app.bodies();
    fail = true; await app.more.onclick!();
    expect(app.bodies()).toEqual(first); expect(app.retry.hidden).toBe(false);
    fail = false; await app.retry.onclick!();
    expect(app.bodies()).toHaveLength(21); expect(app.queries.at(-1).offset).toBe(20);
    fail = true; await app.refresh.onclick!(); expect(app.bodies()).toHaveLength(21);
    fail = false; await app.retry.onclick!(); expect(app.bodies()).toHaveLength(20);
    expect(app.queries.at(-1).offset).toBe(0);
  });

  it('keeps an initial read failure recoverable without presenting it as an empty list', async () => {
    let fail = true;
    const app = mount({ query: async args => { if (fail) throw { code: 'E_UNAVAILABLE' }; return query(records(1))(args); } });
    await app.idle(); expect(app.listStatus.textContent).toContain('Could not load');
    expect(app.listStatus.textContent).not.toContain('No messages');
    fail = false; await app.retry.onclick!(); expect(app.bodies()).toEqual(['Message 0']);
  });

  it('serializes overlapping user actions and retains a draft while reads are pending', async () => {
    let release!: (value: any) => void;
    const app = mount({ query: async () => new Promise(resolve => { release = resolve; }), insert: async () => { throw Error('unexpected write'); } });
    app.input.value = 'Draft';
    await app.refresh.onclick!(); await app.more.onclick!(); await app.submit();
    expect(app.queries).toHaveLength(1); expect(app.save.disabled).toBe(true);
    release({ records: [] }); await app.idle();
    expect(app.input.value).toBe('Draft'); expect(app.save.disabled).toBe(false);
  });

  it('preserves one uncertain write identity and distinguishes successful saving from failed refreshing', async () => {
    const requests: any[] = []; const stored = new Map(); let readFails = false;
    const app = mount({ query: async () => { if (readFails) throw { code: 'E_BUSY' }; return { records: [] }; },
      insert: async args => { requests.push(structuredClone(args)); stored.set(args.requestId, args.values.body); if (requests.length === 1) throw { code: 'E_BUSY' }; readFails = true; return { id: 'saved' }; } });
    await app.idle(); app.input.value = 'First'; await app.submit();
    expect(app.input.disabled).toBe(true); expect(app.save.textContent).toContain('Retry');
    app.input.value = 'Changed after timeout'; await app.submit();
    expect(requests[1]).toEqual(requests[0]); expect(stored.size).toBe(1);
    expect([...stored.values()]).toEqual(['First']); expect(app.saveStatus.textContent).toContain('Saved');
    expect(app.listStatus.textContent).toContain('Could not load'); expect(app.retry.hidden).toBe(false);
    expect(app.input.disabled).toBe(false);
  });

  it('ignores repeated saving while a write is pending and preserves the exact message', async () => {
    const requests: any[] = []; let release!: (value: any) => void;
    const app = mount({ query: query([]), insert: args => {
      requests.push(structuredClone(args)); return new Promise(resolve => { release = resolve; });
    } });
    await app.idle(); await app.submit(); expect(requests).toHaveLength(0);
    app.input.value = '  Message with spaces  '; const saving = app.submit();
    await app.submit(); await app.refresh.onclick!();
    expect(requests).toHaveLength(1); expect(app.queries).toHaveLength(1);
    expect(app.input.disabled).toBe(true); expect(requests[0].values.body).toBe('  Message with spaces  ');
    release({ id: 'saved' }); await saving;
    expect(app.saveStatus.textContent).toBe('Saved.'); expect(app.input.value).toBe('');
    expect(app.save.disabled).toBe(false);
  });

  it('resets the list after a successful save and safely renders message text', async () => {
    const rows = records(21);
    const app = mount({ query: query(rows), insert: async () => { rows.unshift({ id: 'id-new', body: '<script>untrusted</script>' }); return { id: 'id-new' }; } });
    await app.idle(); await app.more.onclick!();
    app.input.value = 'New'; await app.submit();
    expect(app.bodies()).toHaveLength(20); expect(app.bodies()[0]).toBe('<script>untrusted</script>');
    expect(app.queries.at(-1).offset).toBe(0); expect(app.input.value).toBe('');
  });
});
