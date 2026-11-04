/**
 * Background task browser input canary — pages no automation client watches.
 *
 * A task page that loads while the user is in another task used to refuse
 * every native click: its document never rendered, so Chromium never
 * acknowledged the first mouse move and each click timed out (seen
 * 2026-09-27 on Google Search Console). Playwright E2E cannot observe this.
 * It enables DevTools focus emulation on every page it attaches to, which
 * keeps that page painting whether or not its view is shown.
 *
 * So this drives the production browser module from a GUI Electron main
 * process that nothing is attached to (`test/gui/electron-main.mjs`
 * is the host). It is offline and deterministic. Before each click the page
 * shows it has never rendered; the click goes through the model's act path,
 * and success is read from the page and a local server, not the tool result.
 *
 * Exit: 0 pass, 1 a case failed, 2 the host has no usable window.
 */
import * as http from 'node:http';
import { BrowserWindow, WebContentsView, type WebContents } from 'electron';

type WebAssist = typeof import('../../src/main/features/web_assist');
type Result = Record<string, any>;

const CANARY_EXIT_PASS = 0;
const CANARY_EXIT_FAILED = 1;
const CANARY_EXIT_NO_WINDOW = 2;
const USER = 'canary-user';
const TASK = 'canary-background-task';

const PAGE = `<!doctype html><title>Report</title><h1>Report</h1>
<label>Draft<input id="draft"></label>
<button id="continue" type="button">Continue</button><p id="state">idle</p>
<script>
  document.querySelector('#continue').addEventListener('click', event => {
    document.querySelector('#state').textContent = event.isTrusted ? 'trusted' : 'synthetic';
    fetch(location.pathname + '/clicked', { method: 'POST', body: JSON.stringify({ draft: document.querySelector('#draft').value }) });
  });
</script>`;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(50);
  }
}

/** Read from the page itself, bypassing the host under test. */
function pageState(contents: WebContents): Promise<{ rendering: boolean; state: string }> {
  return contents.executeJavaScript(`new Promise(resolve => {
    const state = document.querySelector('#state').textContent;
    requestAnimationFrame(() => resolve({ rendering: true, state }));
    setTimeout(() => resolve({ rendering: false, state }), 500);
  })`);
}

export async function main(): Promise<number> {
  const web = await import('../../src/main/features/web_assist') as unknown as WebAssist;
  const { createDesktopWindowController } = await import('../../src/main/features/desktop_windows');
  const hiddenOnly = process.env.ORKAS_WEB_ASSIST_CANARY_HIDDEN_ONLY === '1';
  const clicks: string[] = [];
  const drafts: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        clicks.push(String(req.url)); drafts.push(JSON.parse(body).draft);
        res.end('ok');
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The app window: on screen, with the user in another task.
  const owner = new BrowserWindow({ width: 900, height: 700, show: false, ...(hiddenOnly ? { focusable: false } : {}) });
  const desktop = createDesktopWindowController({ canHide: () => true, isShutdownComplete: () => false });
  desktop.install(owner);
  let nativeShows = 0;
  owner.on('show', () => { nativeShows++; });
  let tabId = '';
  let failed = 0;
  const view = () => owner.contentView.children.find(child => child instanceof WebContentsView) as WebContentsView | undefined;
  const settle = async (): Promise<string[]> => {
    const loading = await until(() => web.listModelWebAssistTabs(USER, TASK).tabs?.[0]?.loading, value => value === false);
    return loading === false ? [] : ['the page did not finish loading'];
  };
  const navigate = async (path: string): Promise<string[]> => {
    const navigated = await web.navigateModelWebAssist(USER, TASK, { tabId, action: 'goto', url: origin + path }) as Result;
    return navigated.ok === true ? settle() : [`navigate failed: ${String(navigated.code)}`];
  };
  /** One model click on a page that loaded while hidden, checked at the page and server. */
  const clickHiddenPage = async (path: string, neverRendered: boolean | null = true): Promise<string[]> => {
    const contents = view()?.webContents;
    if (!contents) return ['the task page has no native view'];
    const failures: string[] = [];
    // Without a never-rendered page this case would pass without testing anything.
    if (neverRendered !== null && (await pageState(contents)).rendering === neverRendered) {
      failures.push(neverRendered
        ? 'setup: the page rendered before the click; the defect is no longer reproduced'
        : 'the previously woken page stopped rendering');
    }
    const ownerState = { visible: owner.isVisible(), minimized: owner.isMinimized(), focused: owner.isFocused() };
    const pageFocused = contents.isFocused();
    const observed = await web.observeModelWebAssist(USER, TASK, tabId) as Result;
    const ref = (observed.elements as Array<{ ref: string; label: string }> | undefined)
      ?.find(element => element.label === 'Continue')?.ref;
    if (observed.ok !== true || !ref) return [...failures, `observe failed: ${String(observed.code)}`];
    // Observation may own a persistent frame-controller session. Input must
    // preserve that session and release only a session it attached itself.
    const debuggerAttachedBeforeInput = contents.debugger.isAttached();
    const before = clicks.length;
    const acted = await web.actOnModelWebAssist(USER, TASK, {
      tabId, pageId: observed.page_id, elementRef: ref, action: 'click',
    }) as Result;
    if (acted.ok !== true) failures.push(`expected the click to act, got ${String(acted.code)}: ${String(acted.error)}`);
    await until(() => clicks.length, count => count > before, 5000);
    // Time for a duplicate to arrive, so exactly one is a real assertion.
    await sleep(300);
    const received = clicks.slice(before);
    if (received.join() !== `${path}/clicked`) failures.push(`expected one ${path} click at the server, got ${JSON.stringify(received)}`);
    const state = (await pageState(contents)).state;
    if (state !== 'trusted') failures.push(`expected a trusted native click in the page, got ${state}`);
    if (view()?.getVisible()) failures.push('the background page was revealed');
    if (owner.isVisible() !== ownerState.visible || owner.isMinimized() !== ownerState.minimized
      || owner.isFocused() !== ownerState.focused || contents.isFocused() !== pageFocused) {
      failures.push('background input changed native window or page focus/visibility');
    }
    if (contents.debugger.isAttached() !== debuggerAttachedBeforeInput) {
      failures.push('background input changed the controller debugger attachment');
    }
    // Native clicking itself makes document.hasFocus() true even after the
    // emulation session has ended. Native window/view focus above is the oracle
    // for stealing the user's focus; document focus is not that boundary.
    return failures;
  };
  const closedCases: Array<{ name: string; run: () => Promise<string[]> }> = [
    {
      name: 'a closed main window stays alive while its cold task page receives a native click',
      run: async () => {
        owner.close();
        if (owner.isDestroyed() || !desktop.owns(owner.webContents)) return ['close destroyed the main window'];
        const opened = await web.openModelWebAssist(USER, TASK, { url: origin + '/closed-first' }) as Result;
        if (!opened.ok) return [`open failed: ${String(opened.code)}`];
        tabId = String(opened.active_tab_id);
        const loading = await settle();
        return loading.length ? loading : clickHiddenPage('/closed-first');
      },
    },
    {
      name: 'a closed task page fills Unicode input and submits it once without waking its owner',
      run: async () => {
        const observed = await web.observeModelWebAssist(USER, TASK, tabId) as Result;
        const ref = observed.elements?.find((element: any) => element.label === 'Draft')?.ref;
        if (!ref) return ['draft input was not observed'];
        const draft = '后台报告 / background report';
        const filled = await web.actOnModelWebAssist(USER, TASK, {
          tabId, pageId: observed.page_id, elementRef: ref, action: 'fill', text: draft,
        }) as Result;
        if (!filled.ok) return [`fill failed: ${String(filled.code)}`];
        if (await view()?.webContents.executeJavaScript("document.querySelector('#draft').value") !== draft) return ['page did not retain the complete draft'];
        // A completed fill can release its frame-painting session on Windows.
        // Rendering continuity is not the input outcome; cold-click cases above
        // and below independently require an unrendered page before their input.
        const failures = await clickHiddenPage('/closed-first', null);
        if (drafts.at(-1) !== draft) failures.push('website did not receive the exact draft');
        return failures;
      },
    },
    {
      name: 'navigation while closed rejects a stale click and permits one fresh cold-page click',
      run: async () => {
        const observed = await web.observeModelWebAssist(USER, TASK, tabId) as Result;
        const ref = observed.elements?.find((element: any) => element.label === 'Continue')?.ref;
        if (!ref) return ['continue button was not observed'];
        const loading = await navigate('/closed-second');
        if (loading.length) return loading;
        const before = clicks.length;
        const stale = await web.actOnModelWebAssist(USER, TASK, {
          tabId, pageId: observed.page_id, elementRef: ref, action: 'click',
        }) as Result;
        if (stale.ok !== false || clicks.length !== before) return ['stale click was not rejected without a website write'];
        const failures = await clickHiddenPage('/closed-second');
        owner.close();
        if (owner.isDestroyed() || owner.isVisible() || owner.isFocused() || nativeShows) failures.push('closed-window work revealed, focused or destroyed the owner');
        return failures;
      },
    },
  ];
  const cases: Array<{ name: string; run: () => Promise<string[]> }> = [
    {
      name: 'a page opened by a background task takes one native click without being shown',
      run: async () => {
        const opened = await web.openModelWebAssist(USER, TASK, { url: origin + '/first' }) as Result;
        if (opened.ok !== true) return [`open failed: ${String(opened.code)}`];
        tabId = String(opened.active_tab_id);
        const loading = await settle();
        return loading.length ? loading : clickHiddenPage('/first');
      },
    },
    {
      name: 'a previously woken background page takes another click without revealing or focusing its native view',
      run: () => clickHiddenPage('/first', false),
    },
    {
      name: 'a background navigation replaces it with an unrendered page that still takes a click',
      run: async () => {
        const loading = await navigate('/second');
        return loading.length ? loading : clickHiddenPage('/second');
      },
    },
    {
      name: 'an unattended run clicks a page loaded under a hidden window',
      run: async () => {
        owner.hide();
        const loading = await navigate('/third');
        return loading.length ? loading : clickHiddenPage('/third');
      },
    },
    {
      name: 'an unattended run clicks a page without restoring its minimized window',
      run: async () => {
        owner.showInactive();
        owner.minimize();
        if (!await until(() => owner.isMinimized(), Boolean, 3000)) return ['setup: owner did not minimize'];
        const loading = await navigate('/fourth');
        return loading.length ? loading : clickHiddenPage('/fourth');
      },
    },
  ];
  try {
    await owner.loadURL('data:text/html,<title>Orkas</title>');
    web.bindWebAssistConversation(USER, TASK, owner.webContents);
    web.setActiveWebAssistConversation(owner.webContents, 'canary-foreground-task');
    const runCase = async (testCase: typeof cases[number]) => {
      let failures: string[];
      try {
        failures = await testCase.run();
      } catch (err) {
        failures = [`threw: ${(err as Error).message}`];
      }
      if (failures.length) {
        failed += 1;
        process.stdout.write(`FAIL ${testCase.name}\n`);
        for (const reason of failures) process.stdout.write(`     ${reason}\n`);
      } else {
        process.stdout.write(`ok   ${testCase.name}\n`);
      }
    };
    for (const testCase of closedCases) await runCase(testCase);
    if (tabId) await web.closeModelWebAssistTab(USER, TASK, tabId);
    if (!hiddenOnly) {
      owner.showInactive();
      if (!await until(() => owner.isVisible(), Boolean, 3000)) {
        process.stderr.write('[web-assist-input-canary] no usable window on this host; run it on a desktop session\n');
        return CANARY_EXIT_NO_WINDOW;
      }
      for (const testCase of cases) await runCase(testCase);
    }
    process.stdout.write(`[web-assist-input-canary] ${failed ? `${failed} failed` : 'all cases passed'}\n`);
    return failed ? CANARY_EXIT_FAILED : CANARY_EXIT_PASS;
  } finally {
    web.closeWebAssist(owner.webContents);
    owner.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
