import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Real renderer, DOMPurify, local MathJax and fonts. No account or model calls.
test.use({ launchOptions: { executablePath: process.env.ORKAS_E2E_BROWSER_PATH } });
const renderer = path.resolve(__dirname, '../../src/renderer');
const index = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
const mathConfig = index.slice(index.indexOf('window.MathJax = {'), index.indexOf('</script>', index.indexOf('window.MathJax = {')));
const capturedLogs = new WeakMap<Page, Array<{ level: string; message: string }>>();

test.afterEach(async ({ page }, testInfo) => {
  const logs = capturedLogs.get(page) || [];
  const fontWarnings = logs.filter(isFontFallbackNotice);
  if (fontWarnings.length) {
    // Chromium can emit this even for bundled file:// fonts. Classify it as
    // recovered only after the actual FontFaceSet confirms successful loads;
    // frame assertions separately reject any visible formula size change.
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      const faces = Array.from(document.fonts);
      return { failed: faces.filter(font => font.status === 'error').length,
        loaded: faces.filter(font => font.status === 'loaded').length };
    });
    expect(fonts.failed).toBe(0);
    expect(fonts.loaded).toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'warning', description: `${fontWarnings.length} local MathJax font fallback notices; fonts loaded successfully` });
  }
  const unknown = logs.filter(log => !isFontFallbackNotice(log)
    && !(log.level === 'info' && log.message === '[mathjax] ready'));
  await testInfo.attach('browser-log-audit.json', { body: JSON.stringify({ total: logs.length,
    startup: logs.length - unknown.length - fontWarnings.length, recoveredFontNotices: fontWarnings.length,
    unexpected: unknown.map(log => ({ ...log, message: log.message.replace(/file:\/\/\/\S+/g, '[local-file]') })) }), contentType: 'application/json' });
  expect(unknown).toEqual([]);
});

async function setup(page: Page) {
  const logs: Array<{ level: string; message: string }> = [];
  capturedLogs.set(page, logs);
  page.on('pageerror', e => logs.push({ level: 'error', message: e.message }));
  page.on('console', m => logs.push({ level: m.type(), message: m.text() }));
  const scripts = ['icons', 'strip-structural-blocks', 'utils', 'math', 'composer-input', 'conversation'];
  const fixture = test.info().outputPath('renderer.html');
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8">
    <base href="${pathToFileURL(renderer + path.sep).href}">
    <link rel="stylesheet" href="style.css">
    <script>window.createLogger = () => console; window.t = key => key;
    window.currentCid = 'fixture'; window.currentView = 'conversation'; window.conversations = [];
    window.pendingConvs = new Map(); window.groupBusyConvs = new Map(); window.isConvPending = () => false;
    window.orkas = { onPushEvent() { return () => {}; } }; ${mathConfig}</script>
    <script src="vendor/dompurify/purify.min.js"></script>
    <script src="vendor/prosemirror/prosemirror.min.js"></script>
    ${scripts.map(name => `<script src="modules/${name}.js"></script>`).join('')}
    </head><body><textarea id="composer"></textarea>
    <div id="chat-history" class="chat-history" style="height:500px;width:850px;overflow:auto"></div></body></html>`);
  await page.goto(pathToFileURL(fixture).href);
  await page.evaluate(() => {
    const w = window as any;
    const history = document.querySelector('#chat-history') as any;
    history._stickyEnabled = false;
    history.innerHTML = '<div class="chat-message assistant" data-message-actions="errors-only"><div class="chat-bubble"><details class="stream-process" data-role="process-container"><summary class="stream-process-summary"></summary><div class="stream-process-body" data-role="process"></div></details><div data-role="final" style="display:none"></div></div></div>';
    w.msg = history.firstElementChild;
    w.finalEl = w.msg.querySelector('[data-role="final"]');
    w.frames = [];
    w.mutations = 0;
    w.observe = (minimumFormulas = 0) => {
      let previousProgress = 0;
      const originalFormulas = [...w.finalEl.querySelectorAll('mjx-container')]
        .map((node: HTMLElement) => ({ node, size: node.getBoundingClientRect() }));
      const sample = () => {
        const formulas = [...w.finalEl.querySelectorAll('mjx-container')];
        const clone = w.finalEl.cloneNode(true);
        clone.querySelectorAll('mjx-container').forEach((n: Element) => n.remove());
        const text = clone.textContent || '';
        const progress = Math.max(0, ...Array.from(text.matchAll(/token-(\d+)/g), (m: any) => Number(m[1])));
        const frame = { formulas: formulas.length, visible: formulas.every((n: any) => n.getBoundingClientRect().height > 0),
          stableFormulaSize: originalFormulas.every(({ node, size }: any) => {
            const current = node.getBoundingClientRect();
            return w.finalEl.contains(node) && Math.abs(current.width - size.width) < 1 && Math.abs(current.height - size.height) < 1;
          }),
          rawCompletedMath: /\\\([^\n]*?\\\)|\$\$[\s\S]+?\$\$/.test(text),
          blank: !w.finalEl.textContent?.trim(), backwards: progress < previousProgress };
        w.frames.push(frame);
        previousProgress = Math.max(previousProgress, progress);
      };
      const observer = new MutationObserver(() => { w.mutations++; sample(); });
      observer.observe(w.finalEl, { childList: true, subtree: true, characterData: true });
      let stopped = false;
      const tick = () => { if (!stopped) { sample(); requestAnimationFrame(tick); } };
      requestAnimationFrame(tick);
      w.stopObserving = () => { stopped = true; observer.disconnect(); return { frames: w.frames, minimumFormulas, mutations: w.mutations }; };
    };
  });
  return logs;
}

async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.msg.dataset.streamPaintedDisplay === w.msg.dataset.finalText;
  })).toBe(true);
}

async function checkFrames(page: Page, testInfo: any) {
  const report = await page.evaluate(() => (window as any).stopObserving());
  await testInfo.attach('stream-frames.json', { body: JSON.stringify(report), contentType: 'application/json' });
  expect(report.frames.length).toBeGreaterThan(5);
  for (const frame of report.frames) {
    expect(frame).toMatchObject({ visible: true, stableFormulaSize: true, rawCompletedMath: false, blank: false, backwards: false });
    expect(frame.formulas).toBeGreaterThanOrEqual(report.minimumFormulas);
  }
  return report;
}

function isFontFallbackNotice(log: { level: string; message: string }) {
  return log.level === 'info' && log.message.startsWith('Slow network is detected.')
    && log.message.includes('Fallback font will be used while loading: file:')
    && /\/vendor\/mathjax\/output\/chtml\/fonts\/woff-v2\/MathJax_[\w-]+\.woff$/.test(log.message);
}

test('coalesces across frames while preserving long Markdown, typing and the latest trailing text', async ({ page }, testInfo) => {
  await setup(page);
  const text = '## Report\n\nUse `code` and **emphasis**.\n\n| Item | Value |\n| --- | --- |\n| Revenue | 42 |\n\n```js\nconst value = 42;\n```\n\n'.repeat(80);
  await page.evaluate(text => (window as any)._streamingAppendFinalDelta((window as any).msg, text, 'final_answer'), text);
  await settled(page);
  await page.evaluate(() => {
    const w = window as any; w.observe();
    w.streaming = (async () => {
      for (let i = 1; i <= 48; i++) {
        await new Promise(requestAnimationFrame);
        w._streamingAppendFinalDelta(w.msg, ` token-${i}`, 'final_answer');
      }
    })();
  });
  await page.locator('#composer').fill('Typing remains available');
  await expect(page.locator('#composer')).toHaveValue('Typing remains available');
  await page.evaluate(() => (window as any).streaming);
  await settled(page);
  await expect(page.locator('[data-role="final"]')).toContainText('token-48');
  await expect(page.locator('[data-role="final"] pre')).toHaveCount(80);
  await expect(page.locator('[data-role="final"] table')).toHaveCount(80);
  const report = await checkFrames(page, testInfo);
  // A real sequence of 48 separate animation frames must not rebuild the
  // entire answer on every frame. Count observable DOM commits, not calls.
  expect(report.mutations).toBeLessThan(24);
});

test('keeps rendered formulas visible through split math, prose appends and finalization', async ({ page }, testInfo) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    w._streamingAppendFinalDelta(w.msg, '已知 \\(y=2x+b\\)。\n\n', 'final_answer');
  });
  await settled(page);
  await expect(page.locator('[data-role="final"] mjx-container')).toHaveCount(1);
  await page.evaluate(async () => {
    const w = window as any; w.observe(1);
    const pieces = ['\n$$', '\\int_0^1', ' x^2', ' dx', '$$', ...Array.from({ length: 24 }, (_, i) => ` token-${i + 1}`)];
    for (const piece of pieces) {
      w._streamingAppendFinalDelta(w.msg, piece, 'final_answer');
      await new Promise(r => setTimeout(r, 20));
    }
    w._streamingSetFinal(w.msg, w.msg.dataset.finalText + '\n\nCompleted.');
  });
  await settled(page);
  await expect(page.locator('[data-role="final"] mjx-container')).toHaveCount(2);
  await expect(page.locator('[data-role="final"]')).toContainText('Completed.');
  await checkFrames(page, testInfo);
  await page.screenshot({ path: testInfo.outputPath('formulas-completed.png') });
});

test('identical formula display keeps existing formula nodes', async ({ page }, testInfo) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    w.source = 'Stable \\(a+b\\).';
    w._streamingAppendFinalDelta(w.msg, w.source, 'final_answer');
  });
  await settled(page);
  await page.evaluate(async () => {
    const w = window as any; w.observe(1);
    w.originalFormula = w.finalEl.querySelector('mjx-container');
    for (let i = 0; i < 12; i++) {
      w._paintStreamingFinalMarkdown(w.msg, w.finalEl, w.source);
      await new Promise(requestAnimationFrame);
    }
  });
  const report = await checkFrames(page, testInfo);
  expect(report.mutations).toBe(0);
  expect(await page.evaluate(() => {
    const w = window as any; return w.originalFormula === w.finalEl.querySelector('mjx-container');
  })).toBe(true);
});

for (const terminal of ['final', 'stop', 'error'] as const) {
  test(`late formula work cannot overwrite ${terminal}`, async ({ page }, testInfo) => {
    await setup(page);
    await page.evaluate(() => {
      const w = window as any;
      w._streamingAppendFinalDelta(w.msg, 'Stable \\(a+b\\).', 'final_answer');
    });
    await settled(page);
    await page.evaluate(() => {
      const w = window as any; w.observe(1);
      const typeset = w.typesetMathHtml;
      let delayed = false;
      w.typesetMathHtml = async (html: string) => {
        const result = await typeset(html);
        if (!delayed) {
          delayed = true;
          await new Promise<void>(resolve => { w.releaseOldMath = resolve; });
        }
        return result;
      };
      w._streamingAppendFinalDelta(w.msg, ' Older \\(c+d\\).', 'final_answer');
    });
    await expect.poll(() => page.evaluate(() => typeof (window as any).releaseOldMath)).toBe('function');
    await page.evaluate(terminal => {
      const w = window as any;
      w._streamingAppendFinalDelta(w.msg, ' Newest token-99.', 'final_answer');
      if (terminal === 'final') w._streamingSetFinal(w.msg, w.msg.dataset.finalText);
      if (terminal === 'error') w._streamingSetError(w.msg, 'fixture failure');
      if (terminal === 'stop') { w.stopObserving(); w._streamingMarkAborted(w.msg); }
      w.releaseOldMath();
    }, terminal);
    if (terminal === 'final') {
      await settled(page);
      await expect(page.locator('[data-role="final"]')).toContainText('Newest token-99.');
      await expect(page.locator('[data-role="final"] mjx-container')).toHaveCount(2);
    } else if (terminal === 'error') {
      await expect(page.locator('[data-role="final"] .msg-error')).toBeVisible();
      await expect(page.locator('[data-role="final"]')).toContainText('Newest token-99.');
      await expect(page.locator('[data-role="final"] mjx-container')).toHaveCount(2);
    } else {
      await expect(page.locator('[data-role="final"]')).toHaveText('chat.interrupted');
    }
    // Let both a trailing scheduled paint and the old offscreen result drain.
    await page.waitForTimeout(250);
    if (terminal === 'stop') {
      await expect(page.locator('[data-role="final"]')).toHaveText('chat.interrupted');
      await expect(page.locator('[data-role="final"] mjx-container')).toHaveCount(0);
    } else {
      await checkFrames(page, testInfo);
    }
    if (terminal === 'error') {
      // A later authoritative reply with identical body text must remove the
      // error suffix instead of being mistaken for an unchanged DOM paint.
      await page.evaluate(() => {
        const w = window as any;
        w.beforeRecovery = [...w.finalEl.querySelectorAll('mjx-container')];
        w._streamingSetFinal(w.msg, w.msg.dataset.finalText);
      });
      await expect(page.locator('[data-role="final"] .msg-error')).toHaveCount(0);
      await expect(page.locator('[data-role="final"] mjx-container')).toHaveCount(2);
      expect(await page.evaluate(() => {
        const w = window as any;
        return w.beforeRecovery.every((node: Node, i: number) => node === w.finalEl.querySelectorAll('mjx-container')[i]);
      })).toBe(true);
    }
  });
}

test('growing structural content leaves the visible placeholder and formula untouched', async ({ page }, testInfo) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    w._streamingAppendFinalDelta(w.msg, 'Stable \\(a+b\\).\n<skill>', 'final_answer');
  });
  await expect(page.locator('[data-role="final"] mjx-container')).toHaveCount(1);
  await expect(page.locator('[data-role="final"] .stream-placeholder')).toBeVisible();
  await page.evaluate(async () => {
    const w = window as any; w.observe(1);
    for (let i = 0; i < 24; i++) {
      w._streamingAppendFinalDelta(w.msg, 'internal-data', 'final_answer');
      await new Promise(requestAnimationFrame);
    }
    await new Promise(r => setTimeout(r, 150));
  });
  const report = await checkFrames(page, testInfo);
  expect(report.mutations).toBe(0);
  await expect(page.locator('[data-role="final"]')).not.toContainText('internal-data');
});

test('seals complete commentary in order without delayed writes into the next row', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    const body = w.msg.querySelector('[data-role="process"]');
    let commits = 0;
    const observer = new MutationObserver(() => commits++);
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    for (let i = 1; i <= 24; i++) {
      w._streamingAppendFinalDelta(w.msg, ` step-${i}`, 'commentary');
      await new Promise(requestAnimationFrame);
    }
    w._sealStreamingCommentary(w.msg);
    observer.disconnect();
    const first = body.querySelector('.stream-process-commentary');
    const sealed = first.textContent;
    w._appendProcessTextLines(body, 'Run command · inspect', 'tool', 'exec_command');
    w._streamingAppendFinalDelta(w.msg, 'Next commentary', 'commentary');
    w._sealStreamingCommentary(w.msg);
    await new Promise(r => setTimeout(r, 180));
    return { commits, sealed, rows: [...body.children].map((row: Element) => row.textContent), firstStill: first.textContent };
  });
  const expected = Array.from({ length: 24 }, (_, i) => ` step-${i + 1}`).join('').trim();
  expect(result.sealed?.trim()).toBe(expected);
  expect(result.firstStill).toBe(result.sealed);
  expect(result.rows).toHaveLength(3);
  expect(result.rows[2]).toBe('Next commentary');
  expect(result.commits).toBeLessThan(16);
});

test('incremental blocks match the canonical DOM at syntax boundaries and reject unsafe HTML', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(() => {
    const w = window as any;
    const sources = [
      '# Plan\n\n- one\n  - child\n\n  3. nested\n- [x] done\n\n> quote\n> two\n\nend',
      '| A | B |\n| :--- | ---: |\n| **one** | `two` |\n| three | four |\n\nend',
      'Mention ```` ``` ````.\n\n````js\n```\n$x$\n<div>literal</div>\n````\n\nend',
      'before `one\n\ntwo` after\n\n```text\none\n\ntwo\n```',
      'Cost $50 / $100.\n\n$$a\n\n+b$$\n\\[c<d\\]\n\\(e+f\\) and $g$ and `$h$`',
      '[image](chat-media://fixture/image.png)\n\ntext\n\n![image](chat-media://fixture/image.png)',
      'before\n\n<div class="box">\n\n**inside**\n\n</div>\n\nend',
      '<table><tr><td>raw\n\nnext\n\n</td></tr></table>\n\nend',
      '<span title="split\n\nattribute">inside</span>\n\nend',
      '---\ntitle: sample\n---\n# Result\n\n:::chart-bar\n[{"label":"A","value":2}]\n:::',
      'before\n\n:::chart-bar\n[{"label":"A","value":2,"unit":"\\u003cb>"}]\n:::\n\nafter',
      'before\n\n:::chart-bar\n[{"label":"A","value":"\\u003cb>"}]\n:::\n\nafter',
      ':::dashboard\n{"type":"markdown","content":"**inside**"}\n:::\n\nend',
      '<svg><a onload="window.fixtureXss=1">unsafe</a></svg>\n\n<script>window.fixtureXss=2</script>',
      '[bad](javascript:alert(1))\n\n<a href="javascript:alert(1)" onclick="window.fixtureXss=3">bad</a>',
      'before $a$\n\n`$b$`\n\n$$c$$\n\n```txt\nx\n```',
      '@unknown **mention**\n\n<skill>internal</skill>\n\nvisible',
    ];
    let checks = 0;
    const differences: any[] = [];
    for (let scenario = 0; scenario < sources.length; scenario++) {
      const source = sources[scenario];
      const cache = {};
      // Check every character boundary, then authoritative replacement and
      // truncation; cached protected-block indexes must not leak old content.
      const versions = Array.from({ length: source.length }, (_, i) => source.slice(0, i + 1));
      versions.push('replacement', source, source.slice(0, 9), '');
      for (const text of versions) {
        const full = document.createElement('div');
        const incremental = document.createElement('div');
        full.innerHTML = w._renderMessageMarkdown(text);
        incremental.innerHTML = w._renderMessageMarkdown(text, cache).join('');
        if (incremental.innerHTML !== full.innerHTML) differences.push({ scenario, length: text.length });
        if (incremental.querySelector('script, [onclick], [onload], [href^="javascript:"]')) differences.push({ unsafe: scenario });
        checks++;
      }
    }
    return { checks, differences, executed: !!w.fixtureXss };
  });
  expect(result.checks).toBeGreaterThan(1000);
  expect(result.differences).toEqual([]);
  expect(result.executed).toBe(false);
});

test('long replies append with bounded sanitization and retain the stable document', async ({ page }, testInfo) => {
  await setup(page);
  const reports = await page.evaluate(() => {
    const w = window as any;
    const unit = '## Report\n\nUse `code` and **emphasis** in a long streamed answer.\n\n| Item | Value |\n| --- | --- |\n| Revenue | 42 |\n\n';
    const reports: any[] = [];
    w.finalEl.style.display = '';
    const sanitize = w.DOMPurify.sanitize;
    for (const kib of [10, 100, 500]) {
      const text = unit.repeat(Math.ceil(kib * 1024 / unit.length));
      const baseline: number[] = [];
      const incremental: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        w._setStreamingFinalHtml(w.finalEl, w._streamingMarkdownBodyHtml(text + ` tail-${i}`));
        w.finalEl.getBoundingClientRect();
        baseline.push(performance.now() - start);
      }
      w.msg.dataset.streamPaintedDisplay = '';
      w._paintStreamingFinalMarkdown(w.msg, w.finalEl, text);
      w.finalEl.getBoundingClientRect();
      const heading = w.finalEl.querySelector('h2');
      const table = w.finalEl.querySelector('table');
      let sanitizedBytes = 0;
      w.DOMPurify.sanitize = (input: string, config: any) => {
        sanitizedBytes += input.length;
        return sanitize(input, config);
      };
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        w._paintStreamingFinalMarkdown(w.msg, w.finalEl, text + ` tail-${i}`);
        w.finalEl.getBoundingClientRect();
        incremental.push(performance.now() - start);
      }
      w.DOMPurify.sanitize = sanitize;
      reports.push({ kib, baseline, incremental, sanitizedBytes,
        sameHeading: heading === w.finalEl.querySelector('h2'), sameTable: table === w.finalEl.querySelector('table'),
        tables: w.finalEl.querySelectorAll('table').length, expectedTables: Math.ceil(kib * 1024 / unit.length),
        tail: w.finalEl.textContent.endsWith(' tail-2') });
    }
    return reports;
  });
  await testInfo.attach('stream-incremental-cost.json', { body: JSON.stringify(reports), contentType: 'application/json' });
  for (const report of reports) {
    // Work budget and live-node continuity are deterministic gates. Record
    // actual latency for comparison without a machine-speed-dependent cutoff.
    expect(report.sanitizedBytes).toBeLessThan(1024);
    expect(report.sameHeading && report.sameTable && report.tail).toBe(true);
    expect(report.tables).toBe(report.expectedTables);
  }
});

test('only changed formula blocks are typeset and existing formulas never flash', async ({ page }, testInfo) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    w._streamingAppendFinalDelta(w.msg, Array.from({ length: 30 }, (_, i) => `Formula \\(x_${i}+1\\).\n\n`).join(''), 'final_answer');
  });
  await settled(page);
  await page.evaluate(() => {
    const w = window as any; w.observe(30);
    w.originals = [...w.finalEl.querySelectorAll('mjx-container')];
    const typeset = w.MathJax.typesetPromise.bind(w.MathJax);
    w.mathInputs = [];
    w.MathJax.typesetPromise = (roots: HTMLElement[]) => {
      w.mathInputs.push(roots.map(root => root.textContent).join(''));
      return typeset(roots);
    };
    w._streamingAppendFinalDelta(w.msg, 'Only prose token-1.', 'final_answer');
  });
  await settled(page);
  expect(await page.evaluate(() => (window as any).mathInputs)).toEqual([]);
  await page.evaluate(() => {
    const w = window as any; w._streamingAppendFinalDelta(w.msg, '\n\nNew \\(z+2\\).', 'final_answer');
  });
  await settled(page);
  await expect(page.locator('[data-role="final"] mjx-container')).toHaveCount(31);
  await page.evaluate(() => {
    const w = window as any;
    w.newFormula = w.finalEl.querySelectorAll('mjx-container')[30];
    w._streamingAppendFinalDelta(w.msg, ' More prose token-2.', 'final_answer');
  });
  await settled(page);
  const continuity = await page.evaluate(async () => {
    const w = window as any;
    w._streamingSetFinal(w.msg, w.msg.dataset.finalText);
    await new Promise(requestAnimationFrame);
    return { originals: w.originals.every((node: Node, i: number) => node === w.finalEl.querySelectorAll('mjx-container')[i]),
      sameNew: w.newFormula === w.finalEl.querySelectorAll('mjx-container')[30],
      reprocessedOld: w.mathInputs.some((input: string) => input.includes('x_')),
      newInputs: w.mathInputs.length, released: !w.finalEl._streamMarkdown };
  });
  expect(continuity).toMatchObject({ originals: true, sameNew: true, reprocessedOld: false, released: true });
  expect(continuity.newInputs).toBeGreaterThan(0);
  await checkFrames(page, testInfo);
});

test('task switches discard detached formula jobs without retrying or touching the new task', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    const typeset = w.typesetMathHtml;
    w.jobs = 0;
    w.typesetMathHtml = async (...args: any[]) => {
      w.jobs++;
      const html = await typeset(...args);
      await new Promise<void>(resolve => { w.releaseDetached = resolve; });
      return html;
    };
    w._streamingAppendFinalDelta(w.msg, 'Old \\(a+b\\).', 'final_answer');
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseDetached)).toBe('function');
  await page.evaluate(() => {
    const w = window as any;
    w.msg.remove();
    document.querySelector('#chat-history')!.textContent = 'New task';
    w.releaseDetached();
  });
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => {
    const w = window as any;
    return { jobs: w.jobs, pending: !!w.msg._streamMathLatestPaint, busy: !!w.msg._streamMathPaintBusy,
      detachedText: w.finalEl.textContent, activeText: document.querySelector('#chat-history')!.textContent };
  })).toEqual({ jobs: 1, pending: false, busy: false, detachedText: '', activeText: 'New task' });
});

test('prose appends preserve loaded images and audio state, while later embeds retract duplicate links', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 2, 2);
    w.imageSrc = canvas.toDataURL() + '#fixture.png';
    // One second of local PCM silence, so metadata/seek tests need no server,
    // fixture download, permission, codec package, or account.
    const bytes = new Uint8Array(8044);
    const data = new DataView(bytes.buffer);
    const ascii = (at: number, text: string) => [...text].forEach((c, i) => bytes[at + i] = c.charCodeAt(0));
    ascii(0, 'RIFF'); data.setUint32(4, 8036, true); ascii(8, 'WAVEfmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
    data.setUint32(24, 8000, true); data.setUint32(28, 8000, true); data.setUint16(32, 1, true); data.setUint16(34, 8, true);
    ascii(36, 'data'); data.setUint32(40, 8000, true); bytes.fill(128, 44);
    w.audioSrc = 'data:audio/wav;base64,' + btoa(String.fromCharCode(...bytes)) + '#fixture.wav';
    w._streamingAppendFinalDelta(w.msg, `[image](${w.imageSrc}) caption\n\n![audio](${w.audioSrc}) caption`, 'final_answer');
  });
  await settled(page);
  await expect.poll(() => page.locator('[data-role="final"] img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(2);
  await expect.poll(() => page.locator('[data-role="final"] audio').evaluate((el: HTMLAudioElement) => el.readyState)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const w = window as any;
    w.image = w.finalEl.querySelector('img');
    w.shell = w.image.closest('.chat-md-img-shell');
    w.audio = w.finalEl.querySelector('audio');
    w.audio.currentTime = 0.25; w.audio.volume = 0.3;
    w._streamingAppendFinalDelta(w.msg, ' More prose.', 'final_answer');
  });
  await settled(page);
  expect(await page.evaluate(() => {
    const w = window as any;
    return { sameImage: w.image === w.finalEl.querySelector('img'), sameAudio: w.audio === w.finalEl.querySelector('audio'),
      sameShell: w.shell === w.finalEl.querySelector('.chat-md-img-shell'), loading: w.shell.classList.contains('is-loading'),
      time: w.audio.currentTime, volume: w.audio.volume };
  })).toEqual({ sameImage: true, sameAudio: true, sameShell: true, loading: false, time: 0.25, volume: 0.3 });
  await page.evaluate(() => {
    const w = window as any;
    w._streamingAppendFinalDelta(w.msg, `\n\n![embedded image](${w.imageSrc})`, 'final_answer');
  });
  await settled(page);
  // An append can change an earlier block: the explicit embed wins over a
  // link-upgraded image. Freezing the old Markdown prefix would show two.
  await expect(page.locator('[data-role="final"] img')).toHaveCount(1);
  await expect(page.locator('[data-role="final"] img')).toHaveAttribute('alt', 'embedded image');
  await expect(page.locator('[data-role="final"]')).toContainText('More prose.');
  expect(await page.evaluate(() => {
    const w = window as any; return w.audio === w.finalEl.querySelector('audio') && w.audio.currentTime === 0.25;
  })).toBe(true);
});
