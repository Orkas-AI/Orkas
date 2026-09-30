import { createServer } from 'node:http';
import path from 'node:path';
import { expect, test, type OrkasTestApp } from './fixtures/orkas';

async function withInputPage(orkas: OrkasTestApp, run: (browser: Awaited<ReturnType<typeof openInputPage>>) => Promise<void>) {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Background input</title><style>
      body{margin:0;height:3200px}main{position:absolute;top:900px;left:100px}
      #slider{width:80px;height:40px;background:blue;user-select:none;touch-action:none}
      #cover{position:fixed;inset:0;background:white;z-index:10}
      </style><main><label>Draft<input id="draft"></label><button id="save">Save</button>
      <label>Enabled<input type="checkbox" id="check"></label>
      <div id="slider" role="slider" aria-label="Position"></div><p id="result"></p></main>
      <script>
      window.evidence={clicks:0,down:false,distance:0,trusted:false};
      save.addEventListener('click',e=>{evidence.clicks++;evidence.trusted=e.isTrusted;result.textContent=draft.value});
      let start;
      slider.addEventListener('mousedown',e=>{start=e.clientX;evidence.down=true});
      document.addEventListener('mousemove',e=>{if(evidence.down)evidence.distance=e.clientX-start});
      document.addEventListener('mouseup',()=>{evidence.down=false});
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await run(await openInputPage(orkas, origin + '/first'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function openInputPage(orkas: OrkasTestApp, origin: string) {
  const root = path.resolve(__dirname, '../..');
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Background input' })).conversation.conversation_id;
  await orkas.page!.evaluate(async id => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
    (window as any).ConversationInfo.openAndSetTab('browser');
  }, cid);
  await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
    // Leave the inspector stack before entering the lazy module loader.
    await new Promise<void>(resolve => setImmediate(resolve));
    const req = (process as any).mainModule.require;
    req(args.root + '/src/main/features/web_assist.ts').bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
    req(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'input-run');
    ((globalThis as any).__inputTools ||= {})[args.cid] = req(args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid);
  }, { cid, root });
  const call = (input: Record<string, unknown>) => test.step(`browser ${input.operation} ${input.page_action || ''}`, () => orkas.electronApp!.evaluate(async (_e, args) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    return JSON.parse((await (globalThis as any).__inputTools[args.cid].execute(args.input, {})).content);
  }, { cid, input }));
  const opened = await call({ operation: 'open', url: origin });
  const tabId = opened.active_tab_id;
  expect(await call({ operation: 'wait', tab_id: tabId })).toMatchObject({ ok: true });
  await expect(orkas.page!.locator('.web-assist-shell')).toBeVisible();
  // A narrow real view exercises Orkas device-emulation input scaling.
  await orkas.invoke('webAssist.layout', { x: 0, y: 0, width: 600, height: 500 });
  await orkas.page!.evaluate(() => {
    (window as any).setView('connectors');
    document.getElementById('foreground-draft')?.remove();
    const input = document.createElement('textarea');
    input.id = 'foreground-draft'; input.style.cssText = 'position:fixed;top:10px;left:10px;z-index:9999';
    document.body.append(input); input.focus();
  });
  await orkas.page!.locator('#foreground-draft').fill('User keeps working');
  const inspect = async (code: string) => orkas.electronApp!.evaluate(({ webContents }, args) => {
    const target = webContents.getAllWebContents().find(wc => wc.getURL() === args.url)!;
    return target.executeJavaScript(args.code);
  }, { url: origin, code });
  const act = async (label: string, page_action: string, extras: Record<string, unknown> = {}) => {
    const observed = await call({ operation: 'observe', tab_id: tabId });
    expect(observed.ok).toBe(true);
    const element = observed.elements.find((e: any) => e.label === label);
    expect(element).toBeTruthy();
    return call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: element.ref, page_action, ...extras });
  };
  return { cid, tabId, origin, call, inspect, act };
}

test('long articles fill background editors completely without taking foreground input', async ({ orkas }) => {
  await withInputPage(orkas, async ({ act, inspect }) => {
    await inspect(`document.querySelector('main').insertAdjacentHTML('beforeend',
      '<textarea aria-label="Article"></textarea><pre contenteditable="true" aria-label="Markdown"></pre>');
      window.articleState = '';
      const article = document.querySelector('textarea');
      article.addEventListener('input', event => { if (event instanceof InputEvent) window.articleState = article.value; });
      article.addEventListener('focus', () => { article.value = window.articleState; })`);
    const text = '# 中文正文\n\n|字段|值|\n|---|---|\n|标题|完整|\n\n```js\n  const value = "<img src=x onerror=alert(1)> & quoted";\n```\n\n[官网](https://example.com/?a=1&b=2#end)\n'.repeat(1000).slice(0, 99999) + '\n';
    expect(text.length).toBe(100000);
    for (const [label, read] of [['Article', 'document.querySelector("textarea").value'],
      ['Markdown', 'document.querySelector("pre").innerText']]) {
      const filled = await act(label, 'fill', { text });
      expect(filled, JSON.stringify({ label, filled })).toMatchObject({ ok: true });
      expect(await inspect(read)).toBe(text);
      if (label === 'Article') expect(await inspect('window.articleState')).toBe(text);
      expect(await inspect('document.querySelectorAll("img").length')).toBe(0);
      expect(await act(label, 'fill', { text: text + 'x' })).toMatchObject({ ok: false });
      expect(await inspect(read)).toBe(text);
      await expect(orkas.page!.locator('#foreground-draft')).toBeFocused();
      await expect(orkas.page!.locator('#foreground-draft')).toHaveValue('User keeps working');
      await expect(orkas.page!.locator('.web-assist-shell')).toBeHidden();
    }
    await inspect(`document.querySelector('textarea').addEventListener('input', event => {
      queueMicrotask(() => { event.target.value = 'rejected'; });
    })`);
    expect(await act('Article', 'fill', { text })).toMatchObject({ ok: false, code: 'fill_rejected' });
  });
});

test('background page input preserves the user workspace, scaled coordinates and automatic handback', async ({ orkas }) => {
  await withInputPage(orkas, async ({ cid, tabId, origin, call, inspect, act }) => {
    expect(await act('Draft', 'fill', { text: 'Background draft' })).toMatchObject({ ok: true });
    expect(await act('Save', 'click')).toMatchObject({ ok: true });
    expect(await call({ operation: 'wait', tab_id: tabId, wait_condition: 'text', text: 'Background draft' })).toMatchObject({ ok: true });
    expect(await inspect('evidence')).toMatchObject({ clicks: 1, trusted: true });
    expect(await act('Enabled', 'check')).toMatchObject({ ok: true });
    expect(await inspect('check.checked')).toBe(true);
    await orkas.page!.locator('#foreground-draft').press('End');
    const backgroundDrag = act('Position', 'drag', { drag_delta_x: 160, drag_delta_y: 0 });
    await expect.poll(() => inspect('evidence.down'), { intervals: [5] }).toBe(true);
    // keyboard.type uses the current focus; a locator action would refocus and hide a regression.
    await orkas.page!.keyboard.type(' uninterrupted', { delay: 5 });
    expect(await inspect('evidence.down')).toBe(true);
    await expect(orkas.page!.locator('#foreground-draft')).toHaveValue('User keeps working uninterrupted');
    expect(await backgroundDrag).toMatchObject({ ok: true });
    expect(await inspect('evidence')).toMatchObject({ down: false, distance: 160 });
    await expect(orkas.page!.locator('#foreground-draft')).toBeFocused();
    await expect(orkas.page!.locator('#foreground-draft')).toHaveValue('User keeps working uninterrupted');
    await expect(orkas.page!.locator('.web-assist-shell')).toBeHidden();
    // A covered control must not click the overlay or report success.
    await inspect("document.body.insertAdjacentHTML('beforeend','<div id=cover></div>')");
    expect(await act('Save', 'click')).toMatchObject({ ok: false, code: 'element_not_ready' });
    expect(await inspect('evidence.clicks')).toBe(1);
    await inspect('cover.remove()');
    expect(await act('Save', 'click')).toMatchObject({ ok: true });
    expect(await inspect('evidence.clicks')).toBe(2);
    // Taking control during a held pointer cancels further movement and releases it.
    await inspect('evidence.distance=0');
    const drag = act('Position', 'drag', { drag_delta_x: 300, drag_delta_y: 0 });
    await expect.poll(() => inspect('evidence.down'), { intervals: [10] }).toBe(true);
    await orkas.electronApp!.evaluate(({ webContents }, url) => {
      webContents.getAllWebContents().find(wc => wc.getURL() === url)!.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
    }, origin);
    expect(await drag).toMatchObject({ ok: false, code: 'user_controlled' });
    expect(await inspect('evidence.down')).toBe(false);
    expect(await inspect('evidence.distance')).toBeLessThan(300);
    expect(await call({ operation: 'navigate', tab_id: tabId, navigation: 'goto', url: origin + '/unwanted' })).toMatchObject({ ok: false, code: 'user_controlled' });
    expect(await call({ operation: 'close', tab_id: tabId })).toMatchObject({ ok: false, code: 'user_controlled' });
    const stale = await call({ operation: 'observe', tab_id: tabId });
    expect(await act('Draft', 'fill', { text: 'Must not overwrite' })).toMatchObject({ ok: false, code: 'user_controlled' });
    expect(await inspect('draft.value')).toBe('Background draft');
    await orkas.page!.evaluate(id => {
      document.getElementById('foreground-draft')!.remove();
      (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, cid);
    await expect(orkas.page!.locator('[data-act="control"]')).toHaveCount(0);
    await orkas.electronApp!.evaluate(({ webContents }, url) => {
      webContents.getAllWebContents().find(wc => wc.getURL() === url)!.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
    }, origin);
    expect(await call({ operation: 'wait', tab_id: tabId, timeout_ms: 15000 })).toMatchObject({ ok: true });
    await expect.poll(async () => (await call({ operation: 'tabs' })).tabs.find((t: any) => t.tab_id === tabId).user_controlled).toBeFalsy();
    expect(await call({ operation: 'act', tab_id: tabId, page_id: stale.page_id, element_ref: 'e1', page_action: 'fill', text: 'stale' })).toMatchObject({ ok: false, code: 'stale_page' });
    expect(await act('Draft', 'fill', { text: 'Resumed draft' })).toMatchObject({ ok: true });
    expect(await inspect('draft.value')).toBe('Resumed draft');
  });
});

for (const intervention of ['mouse', 'keyboard', 'scroll'] as const) {
  test(`native ${intervention} intervention cancels AI input until the user becomes idle`, async ({ orkas }) => {
    await withInputPage(orkas, async ({ cid, tabId, origin, call, inspect, act }) => {
      await orkas.page!.evaluate(id => {
        document.getElementById('foreground-draft')!.remove();
        (window as any).setView('conversation', id);
        (window as any).ConversationInfo.openAndSetTab('browser');
      }, cid);
      await expect(orkas.page!.locator('.web-assist-shell')).toBeVisible();
      await inspect(`document.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
        window.nativeEvents=[];
        document.addEventListener('mousedown',e=>nativeEvents.push({type:'mouse',trusted:e.isTrusted}));
        document.addEventListener('keydown',e=>nativeEvents.push({type:'keyboard',trusted:e.isTrusted}));
        document.addEventListener('wheel',e=>nativeEvents.push({type:'scroll',trusted:e.isTrusted}));`);
      await orkas.electronApp!.evaluate(({ webContents }, url) => {
        const target = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
        (globalThis as any).__mouseEvidence = [];
        target.on('before-mouse-event', (_e, input) => (globalThis as any).__mouseEvidence.push(input.type));
        target.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 });
        const original = target.debugger.sendCommand.bind(target.debugger);
        // Delay one native move acknowledgement to expose mouse-vs-AI races deterministically.
        target.debugger.sendCommand = async (method, params) => {
          const result = await original(method, params);
          if (params?.type === 'mouseMoved' && params.buttons === 1) {
            target.debugger.sendCommand = original;
            await new Promise<void>(resolve => { (globalThis as any).__releaseMove = resolve; });
          }
          return result;
        };
      }, origin);
      const drag = act('Position', 'drag', { drag_delta_x: 300, drag_delta_y: 0 });
      await expect.poll(() => inspect('evidence.down'), { intervals: [5] }).toBe(true);
      await expect.poll(() => orkas.electronApp!.evaluate(() => typeof (globalThis as any).__releaseMove)).toBe('function');
      // Real Electron input traverses the native event hook; no fake emitter or takeover IPC.
      await orkas.electronApp!.evaluate(({ webContents }, args) => {
        const target = webContents.getAllWebContents().find(wc => wc.getURL() === args.origin)!;
        if (args.intervention === 'mouse') {
          target.sendInputEvent({ type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1 });
          target.sendInputEvent({ type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 1 });
        } else if (args.intervention === 'scroll') {
          target.sendInputEvent({ type: 'mouseWheel', x: 10, y: 10, deltaY: -80, deltaX: 0 });
        } else {
          target.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
          target.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
        }
        (globalThis as any).__releaseMove();
        delete (globalThis as any).__releaseMove;
      }, { origin, intervention });
      const dragResult = await drag;
      expect(dragResult, JSON.stringify({ dragResult, native: await inspect('nativeEvents'), hook: await orkas.electronApp!.evaluate(() => (globalThis as any).__mouseEvidence) })).toMatchObject({ ok: false, code: 'user_controlled' });
      expect(await inspect('evidence.down')).toBe(false);
      expect(await inspect('evidence.distance')).toBeLessThan(300);
      const events = await inspect('nativeEvents');
      expect(events.filter((event: any) => event.type === intervention && event.trusted).length).toBe(intervention === 'mouse' ? 2 : 1);
      expect(await act('Save', 'click')).toMatchObject({ ok: false, code: 'user_controlled' });
      expect(await inspect('evidence.clicks')).toBe(0);
      await expect(orkas.page!.locator('[data-act="control"]')).toHaveCount(0);
      // Returning control must not require showing this task or clicking chrome.
      await orkas.page!.evaluate(() => (window as any).setView('connectors'));
      expect(await call({ operation: 'wait', tab_id: tabId, timeout_ms: 15000 })).toMatchObject({ ok: true });
      await expect.poll(async () => (await call({ operation: 'tabs' })).tabs.find((t: any) => t.tab_id === tabId).user_controlled).toBeFalsy();
      expect(await act('Save', 'click')).toMatchObject({ ok: true });
      expect(await inspect('evidence.clicks')).toBe(1);
    });
  });
}

test('IME candidate selection stays human controlled and automatically resumes when composition ends without another key', async ({ orkas }) => {
  await withInputPage(orkas, async ({ cid, tabId, origin, call, inspect, act }) => {
    await orkas.page!.evaluate(id => {
      (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, cid);
    await inspect(`draft.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));`);
    expect((await call({ operation: 'tabs' })).tabs.find((t: any) => t.tab_id === tabId).user_controlled).toBeFalsy();
    await inspect(`draft.focus(); window.imeEvents=[];
      for(const type of ['compositionstart','compositionend','input']) document.addEventListener(type,e=>imeEvents.push({type,trusted:e.isTrusted,composing:e.isComposing,inputType:e.inputType}));`);
    const ime = (commit: boolean) => orkas.electronApp!.evaluate(async ({ webContents }, args) => {
      const target = webContents.getAllWebContents().find(wc => wc.getURL() === args.origin)!;
      if (!target.debugger.isAttached()) target.debugger.attach('1.3');
      if (!args.commit) {
        (globalThis as any).__imeEvidence = [];
        target.on('before-input-event', (_e, input) => (globalThis as any).__imeEvidence.push({ type: input.type, code: input.code, composing: input.isComposing }));
        target.ipc.on('web-assist:composition', (e, active) => (globalThis as any).__imeEvidence.push({ active, frame: e.senderFrame?.frameToken }));
      }
      if (args.commit) {
        // End the native composition explicitly: CDP insertText alone leaves
        // a composing input followed by an untrusted compositionend in Chromium.
        await target.debugger.sendCommand('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
        await target.debugger.sendCommand('Input.insertText', { text: '你好' });
      }
      else await target.debugger.sendCommand('Input.imeSetComposition', { text: '你好', selectionStart: 0, selectionEnd: 2 });
    }, { origin, commit });
    await ime(false);
    await expect.poll(async () => (await call({ operation: 'tabs' })).tabs.find((t: any) => t.tab_id === tabId).user_controlled).toBe(true);
    // A candidate can remain open beyond the idle threshold with no held key.
    expect(await call({ operation: 'wait', tab_id: tabId, timeout_ms: 10500 })).toMatchObject({ ok: false, code: 'wait_timeout' });
    expect(await act('Draft', 'fill', { text: 'Must wait' })).toMatchObject({ ok: false, code: 'user_controlled' });
    await ime(true);
    const resumed = await call({ operation: 'wait', tab_id: tabId, timeout_ms: 15000 });
    const evidence = await orkas.electronApp!.evaluate(() => (globalThis as any).__imeEvidence);
    expect(resumed, JSON.stringify({ evidence, page: await inspect('({events:imeEvents,value:draft.value,focus:document.activeElement.id})') })).toMatchObject({ ok: true });
    expect(await inspect('draft.value')).toBe('你好');
    expect(await inspect('typeof window.orkas')).toBe('undefined');
    expect(await act('Draft', 'fill', { text: 'Resumed' })).toMatchObject({ ok: true });
    expect(await inspect('draft.value')).toBe('Resumed');
  });
});

test('concurrent task pages stay isolated and competing input cannot overwrite a held operation', async ({ orkas }) => {
  await withInputPage(orkas, async first => {
    const second = await openInputPage(orkas, first.origin.replace('/first', '/second'));
    expect(first.tabId).not.toBe(second.tabId);
    expect(await first.act('Draft', 'fill', { text: 'First task' })).toMatchObject({ ok: true });
    expect(await second.act('Draft', 'fill', { text: 'Second task' })).toMatchObject({ ok: true });
    const foreign = await first.call({ operation: 'observe', tab_id: second.tabId });
    expect(foreign.ok).toBe(false);
    expect(foreign.elements).toBeUndefined();
    const observed = await first.call({ operation: 'observe', tab_id: first.tabId });
    const drag = first.call({ operation: 'act', tab_id: first.tabId, page_id: observed.page_id,
      element_ref: observed.elements.find((e: any) => e.label === 'Position').ref,
      page_action: 'drag', drag_delta_x: 240, drag_delta_y: 0 });
    await expect.poll(() => first.inspect('evidence.down'), { intervals: [5] }).toBe(true);
    const competing = await first.call({ operation: 'act', tab_id: first.tabId, page_id: observed.page_id,
      element_ref: observed.elements.find((e: any) => e.label === 'Draft').ref, page_action: 'fill', text: 'Overwrite' });
    expect(competing).toMatchObject({ ok: false, code: 'action_in_progress' });
    expect(await first.call({ operation: 'navigate', tab_id: first.tabId, navigation: 'reload' })).toMatchObject({ ok: false, code: 'action_in_progress' });
    // Another task can complete an operation while the first task holds its pointer.
    expect(await second.act('Draft', 'fill', { text: 'Second task continues' })).toMatchObject({ ok: true });
    expect(await first.inspect('evidence.down')).toBe(true);
    const dragResult = await drag;
    expect(dragResult, JSON.stringify(dragResult)).toMatchObject({ ok: true });
    expect(await first.inspect('({draft:draft.value,...evidence})')).toMatchObject({ draft: 'First task', down: false, distance: 240, clicks: 0 });
    expect(await second.inspect('({draft:draft.value,...evidence})')).toMatchObject({ draft: 'Second task continues', down: false, distance: 0, clicks: 0 });
    await expect(orkas.page!.locator('#foreground-draft')).toBeFocused();
    await expect(orkas.page!.locator('.web-assist-shell')).toBeHidden();
    expect(await first.act('Save', 'click')).toMatchObject({ ok: true });
    expect(await second.inspect('evidence.clicks')).toBe(0);
  });
});
