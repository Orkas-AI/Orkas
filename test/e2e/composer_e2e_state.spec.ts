import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { expect, test, OrkasTestApp } from './fixtures/orkas';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

let previousKeepLogs: string | undefined;
test.beforeEach(() => {
  previousKeepLogs = process.env.ORKAS_E2E_KEEP_LOGS;
  process.env.ORKAS_E2E_KEEP_LOGS = '1';
});
test.afterEach(async ({}, info) => {
  if (previousKeepLogs === undefined) delete process.env.ORKAS_E2E_KEEP_LOGS;
  else process.env.ORKAS_E2E_KEEP_LOGS = previousKeepLogs;
  const file = info.outputPath('electron-main.log');
  expect(existsSync(file), 'Retain all main, renderer and cleanup logs on success too').toBe(true);
  const raw = readFileSync(file, 'utf8');
  let debuggerDisconnects = 0;
  const classified = raw.split(/\r?\n/).map(line => {
    // dispose() has already verified process exit. This exact Playwright
    // debugger lifecycle line is not an application error; raw logs stay intact.
    if (line === '[main:stderr] Waiting for the debugger to disconnect...') {
      debuggerDisconnects++;
      return '[main:stdout] [playwright-debugger] disconnect';
    }
    // Explicit fixture events are stdout, not continuations of preceding stderr.
    if (line.startsWith('[fixture-cleanup] ')) return `[main:stdout] ${line}`;
    return line;
  }).join('\n');
  const analysis = { ...analyzeWebAppLogs(classified), phase: 'composer-state', debuggerDisconnects };
  writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
  expect(analysis.passed, 'Review log-analysis.json for errors or incomplete coverage').toBe(true);
  if (analysis.requiresReview) console.warn('Composer E2E log warnings:', JSON.stringify(analysis.findings));
});


test('edits multiline Unicode and math literally, keeps native undo and a stable unrelated paragraph', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false });
  try {
    await app.launch();
    const page = app.page!;
    const input = page.locator('#new-chat-input');
    await expect(input).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('textarea.chat-rich-source')).toHaveCount(0);
    await page.evaluate(() => {
      const w = window as any;
      w.composerSetText('new-chat-input', '中文😀\n\\(x^2+y^2=z^2\\)\nlast');
      w.composerSetSelection('new-chat-input', 2);
      w.getChatRichComposerEditor('new-chat-input').focus();
      w.untouchedParagraph = document.querySelectorAll('#new-chat-input p')[1];
    });
    await page.keyboard.insertText('测');
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input')))
      .toBe('中文测😀\n\\(x^2+y^2=z^2\\)\nlast');
    await page.keyboard.press(`${modifier}+z`);
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input')))
      .toBe('中文😀\n\\(x^2+y^2=z^2\\)\nlast');
    await page.keyboard.press(`${modifier}+Shift+z`);
    expect(await page.evaluate(() => (window as any).untouchedParagraph === document.querySelectorAll('#new-chat-input p')[1])).toBe(true);
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input')))
      .toBe('中文测\n😀\n\\(x^2+y^2=z^2\\)\nlast');
  } finally { await app.dispose(); }
});

test('preserves literal code and quoted mentions, makes real chips atomic and undoes paste and deletion', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false });
  try {
    await app.launch();
    const page = app.page!;
    const editor = page.locator('#new-chat-input');
    const literal = '> @commander quoted\n```\n@commander code\n```\n`@commander inline`\n@commander real';
    await editor.fill(literal);
    await expect(editor.locator('[data-kind="commander"]')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe(literal);
    // Closing/opening a fence changes subsequent token presentation without
    // interpreting the quoted text as a new recipient or altering authored bytes.
    await page.evaluate(() => {
      const w = window as any;
      w.composerSetText('new-chat-input', '@commander tail');
      w.composerSetSelection('new-chat-input', '@commander '.length);
    });
    await editor.press('Backspace');
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe('tail');
    await editor.press(`${modifier}+z`);
    await expect(editor.locator('[data-kind="commander"]')).toHaveCount(1);
    await page.evaluate(() => {
      const w = window as any;
      w.composerSetText('new-chat-input', 'before after');
      w.composerSetSelection('new-chat-input', 7);
      const data = new DataTransfer();
      data.setData('text/plain', '中文😀\r\n\\(x^2\\)\r\n<img src=x onerror="window.badPaste=1">\n');
      data.setData('text/html', '<img src=x onerror="window.badPaste=1">');
      document.getElementById('new-chat-input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input')))
      .toBe('before 中文😀\n\\(x^2\\)\n<img src=x onerror="window.badPaste=1">\nafter');
    await expect(editor.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).badPaste)).toBeUndefined();
    await editor.press(`${modifier}+z`);
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe('before after');
  } finally { await app.dispose(); }
});

test('IME commit never submits, and task ownership fences undo and stale snapshots', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false });
  try {
    await app.launch();
    const page = app.page!;
    const input = page.locator('#new-chat-input');
    await input.focus();
    await page.evaluate(() => {
      const w = window as any;
      w.submitCount = 0;
      w.handleNewChatSubmit = () => { w.submitCount++; };
      document.getElementById('new-chat-input')!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    });
    await page.keyboard.insertText('中文');
    await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
    expect(await page.evaluate(() => (window as any).submitCount)).toBe(0);
    await input.dispatchEvent('compositionend', { data: '中文' });
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe('中文');
    // ProseMirror protects the native post-composition Enter as well.
    await page.waitForTimeout(550);
    await input.press('Enter');
    expect(await page.evaluate(() => (window as any).submitCount)).toBe(1);
    const ownership = await page.evaluate(() => {
      const w = window as any;
      w.composerBindOwner('new-chat-input', 'A');
      w.composerSetText('new-chat-input', 'same');
      const snapshot = w.composerSnapshot('new-chat-input');
      w.composerSetText('new-chat-input', 'changed');
      w.composerSetText('new-chat-input', 'same');
      const aba = snapshot.matches();
      const second = w.composerSnapshot('new-chat-input');
      w.composerBindOwner('new-chat-input', 'B');
      w.composerSetText('new-chat-input', 'B draft');
      w.composerBindOwner('new-chat-input', 'A');
      const switched = second.matches();
      const api = w._composerApi('new-chat-input');
      const undo = w.OrkasEditor.undo(api.view.state, api.view.dispatch);
      return { aba, switched, undo, text: w.composerText('new-chat-input') };
    });
    expect(ownership).toEqual({ aba: false, switched: false, undo: false, text: 'B draft' });
  } finally { await app.dispose(); }
});

test('voice range tracks unrelated edits, rejects overlap, cancellation and another task', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false });
  try {
    await app.launch();
    const result = await app.page!.evaluate(() => {
      const w = window as any;
      const id = 'new-chat-input';
      w.composerBindOwner(id, 'A');
      w.composerSetText(id, 'prefix suffix');
      w.composerSetSelection(id, 7);
      const range = w.composerInsertion(id);
      const first = range.replace('voice');
      const view = w._composerApi(id).view;
      view.dispatch(view.state.tr.insertText('USER ', 1));
      const second = range.replace('final');
      const combined = w.composerText(id);
      const selection = w._composerPosition(view.state.doc, 'USER prefix fi'.length);
      view.dispatch(view.state.tr.insertText('!', selection));
      const edited = w.composerText(id);
      const overlap = range.replace('SHOULD NOT REPLACE');
      w.composerSetSelection(id, 0);
      const cancelled = w.composerInsertion(id);
      cancelled.dispose();
      const afterCancel = cancelled.replace('STALE');
      const switched = w.composerInsertion(id);
      w.composerBindOwner(id, 'B');
      w.composerSetText(id, 'B draft');
      const otherTask = switched.replace('A transcript');
      const final = w.composerText(id);
      w.composerSetText(id, 'tail'); w.composerSetSelection(id, 0);
      const emptyRange = w.composerInsertion(id);
      const current = w._composerApi(id).view;
      current.dispatch(current.state.tr.insertText('typed ', 1));
      const boundaryResult = emptyRange.replace('voice ');
      const editor = document.getElementById(id)!;
      editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const duringIME = emptyRange.replace('must not disrupt native composition');
      const imeText = w.composerText(id);
      editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      return { first, second, combined, edited, overlap, afterCancel, otherTask, final, boundaryResult, boundaryText: w.composerText(id), duringIME, imeText };
    });
    expect(result).toEqual({ first: true, second: true, combined: 'USER prefix finalsuffix',
      edited: 'USER prefix fi!nalsuffix', overlap: false, afterCancel: false, otherTask: false, final: 'B draft', boundaryResult: true, boundaryText: 'typed voice tail', duringIME: false, imeText: 'typed voice tail' });
  } finally { await app.dispose(); }
});

for (const shape of ['5000-lines', 'long-paragraph'] as const) test(`${shape} retains untouched DOM and avoids whole-text work during a burst of local edits`, async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false });
  try {
    await app.launch();
    const page = app.page!;
    await page.evaluate(shape => {
      const w = window as any;
      const text = shape === '5000-lines' ? Array.from({ length: 5000 }, (_, n) => `line ${n}: 中文😀 \\(x^2\\)`).join('\n') : '中文😀 plain text '.repeat(1000);
      w.composerSetText('new-chat-input', text);
      w.composerSetSelection('new-chat-input', 10);
    }, shape);
    await page.waitForTimeout(250);
    const sample = await page.evaluate(async shape => {
      const w = window as any;
      const api = w._composerApi('new-chat-input');
      const stable = document.querySelectorAll('#new-chat-input p')[shape === '5000-lines' ? 4000 : 0];
      let serializations = 0;
      const original = w._composerDocumentText;
      w._composerDocumentText = (...args: any[]) => { serializations++; return original(...args); };
      const durations = [];
      try {
        for (let i = 0; i < 20; i++) {
          const before = performance.now();
          api.view.dispatch(api.view.state.tr.insertText('x', 10));
          durations.push(performance.now() - before);
        }
        const duringBurst = serializations;
        await new Promise(resolve => requestAnimationFrame(resolve));
        return { duringBurst, durations, stable: stable === document.querySelectorAll('#new-chat-input p')[shape === '5000-lines' ? 4000 : 0],
          paragraphs: document.querySelectorAll('#new-chat-input p').length };
      } finally { w._composerDocumentText = original; }
    }, shape);
    writeFileSync(info.outputPath('composer-performance.json'), JSON.stringify(sample, null, 2));
    expect(sample.duringBurst).toBe(0);
    expect(sample.stable).toBe(true);
    expect(sample.paragraphs).toBe(shape === '5000-lines' ? 5000 : 1);
    // A generous ceiling detects a full synchronous DOM rebuild without making
    // this a microbenchmark of the CI host. Actual timings remain in evidence.
    expect(Math.max(...sample.durations)).toBeLessThan(shape === '5000-lines' ? 150 : 300);
  } finally { await app.dispose(); }
});

test('an accepted delayed send preserves a newer identical draft and a switched task', async ({}, info) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(info, { modelStub: true });
  try {
    await app.launch();
    const a = await app.invoke<any>('conversations.create', { title: 'Composer race A' });
    const b = await app.invoke<any>('conversations.create', { title: 'Composer race B' });
    const cidA = a.conversation.conversation_id, cidB = b.conversation.conversation_id;
    const page = app.page!;
    await page.evaluate(async cid => { const w = window as any; await w.loadConversations(); w.setView('conversation', cid); }, cidA);
    const input = page.locator('#chat-input');
    await expect(page.locator('#chat-header-title')).toHaveText('Composer race A');
    await input.fill('authored request');
    await page.evaluate(() => {
      const w = window as any;
      const original = w._chatAttachSnapshotForSend;
      w._chatAttachSnapshotForSend = async (...args: any[]) => {
        await new Promise(resolve => { w.releaseComposerSend = resolve; });
        return original(...args);
      };
      w.delayedComposerSend = w.handleChatSubmit();
    });
    await input.fill('new text');
    await input.fill('authored request');
    await page.evaluate(async () => {
      const w = window as any;
      w.releaseComposerSend();
      await w.delayedComposerSend;
    });
    await expect.poll(() => page.evaluate(() => (window as any).composerText('chat-input'))).toBe('authored request');
    await expect(page.locator('#chat-history .chat-message.user')).toContainText('authored request');
    // A second in-flight request belongs to A even while B is being edited.
    await input.fill('second request for A');
    await page.evaluate(() => { const w = window as any; w.delayedComposerSend = w.handleChatSubmit(); });
    await input.fill('unsent A survives');
    await page.evaluate(cid => (window as any).setView('conversation', cid), cidB);
    await expect(page.locator('#chat-header-title')).toHaveText('Composer race B');
    await input.fill('unsent B survives');
    await page.evaluate(async () => { const w = window as any; w.releaseComposerSend(); await w.delayedComposerSend; });
    await expect.poll(() => page.evaluate(() => (window as any).composerText('chat-input'))).toBe('unsent B survives');
    await page.evaluate(cid => (window as any).setView('conversation', cid), cidA);
    await expect.poll(() => page.evaluate(() => (window as any).composerText('chat-input'))).toBe('unsent A survives');
    const relaunched = await app.relaunch();
    await expect.poll(() => relaunched.evaluate(() => (window as any).composerText('chat-input'))).toBe('unsent A survives');
    await relaunched.evaluate(cid => (window as any).setView('conversation', cid), cidB);
    await expect.poll(() => relaunched.evaluate(() => (window as any).composerText('chat-input'))).toBe('unsent B survives');
    // Send a restored draft without typing: navigation must not resurrect the
    // accepted text merely because restore did not emit an input event.
    await relaunched.evaluate(() => {
      const w = window as any;
      const original = w._chatAttachSnapshotForSend;
      w._chatAttachSnapshotForSend = async (...args: any[]) => {
        await new Promise(resolve => { w.releaseRestoredSend = resolve; });
        return original(...args);
      };
      w.restoredSend = w.handleChatSubmit();
    });
    await relaunched.evaluate(cid => (window as any)._addQuote(cid, {
      text: 'reference added after send began', role: 'user', msgId: 'later-reference', sourceCid: cid,
    }), cidB);
    await relaunched.evaluate(cid => (window as any).setView('conversation', cid), cidA);
    await relaunched.evaluate(async () => { const w = window as any; w.releaseRestoredSend(); await w.restoredSend; });
    await expect.poll(() => relaunched.evaluate(() => (window as any).composerText('chat-input'))).toBe('unsent A survives');
    await relaunched.evaluate(cid => (window as any).setView('conversation', cid), cidB);
    await expect.poll(() => relaunched.evaluate(() => (window as any).composerText('chat-input'))).toBe('');
    await expect(relaunched.locator('#chat-quote-preview')).toContainText('reference added after send began');
    const persisted = await relaunched.evaluate(cid => (window as any)._readDraftData(cid), cidB);
    expect(persisted.text).toBe('');
    expect(persisted.references).toEqual([expect.objectContaining({ text: 'reference added after send began' })]);
  } finally { await app.dispose(); }
});

test('new-chat preflight failure keeps the draft; successful retry leaves later input intact', async ({}, info) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(info, { modelStub: true });
  try {
    await app.launch();
    const page = app.page!;
    const input = page.locator('#new-chat-input');
    await input.fill('first request');
    await page.evaluate(() => {
      const w = window as any;
      const original = w._chatAttachSnapshotForSend;
      w._chatAttachSnapshotForSend = async (...args: any[]) => {
        const failed = await new Promise(resolve => { w.releaseNewComposer = resolve; });
        return failed ? { ok: false } : original(...args);
      };
      w.delayedNewSend = w.handleNewChatSubmit();
    });
    await page.evaluate(() => (window as any).releaseNewComposer(true));
    await expect(page.locator('.ui-dialog-overlay:visible')).toBeVisible();
    await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await page.evaluate(() => (window as any).delayedNewSend);
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe('first request');
    await page.evaluate(() => { const w = window as any; w.delayedNewSend = w.handleNewChatSubmit(); });
    await input.fill('later request remains here');
    await page.evaluate(async () => { const w = window as any; w.releaseNewComposer(false); await w.delayedNewSend; });
    await expect(page.locator('#panel-new-chat')).toHaveClass(/\bactive\b/);
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe('later request remains here');
    const listed = await app.invoke<any>('conversations.list');
    expect(listed.conversations.filter((item: any) => item.title === 'first request')).toHaveLength(1);
  } finally { await app.dispose(); }
});

test('copy and cut preserve token payloads, and metadata refresh does not steal another control’s selection', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false });
  try {
    await app.launch();
    const page = app.page!;
    const result = await page.evaluate(() => {
      const w = window as any;
      const id = 'new-chat-input';
      const token = w._chatUseTokenFor({ kind: 'skill', id: 'fixture', name: '中文 😀' });
      const authored = `before ${token}\n\\(x^2\\) after\n`;
      w.composerSetText(id, authored);
      w.composerSetSelection(id, 0, authored.length);
      const view = w._composerApi(id).view;
      const copy = view.serializeForClipboard(view.state.selection.content());
      const clipboard = new DataTransfer();
      document.getElementById(id)!.dispatchEvent(new ClipboardEvent('cut', { clipboardData: clipboard, cancelable: true, bubbles: true }));
      const cut = w.composerText(id);
      w.OrkasEditor.undo(view.state, view.dispatch);
      const restored = w.composerText(id);
      const field = document.createElement('input');
      document.body.appendChild(field);
      field.value = 'other control'; field.focus(); field.setSelectionRange(2, 5);
      w.refreshAllChatComposers();
      const focusPreserved = document.activeElement === field && field.selectionStart === 2 && field.selectionEnd === 5;
      field.remove();
      return { authored, copied: copy.text, clipboard: clipboard.getData('text/plain'), cut, restored, focusPreserved };
    });
    expect(result.copied).toBe(result.authored);
    expect(result.clipboard).toBe(result.authored);
    expect(result.cut).toBe('');
    expect(result.restored).toBe(result.authored);
    expect(result.focusPreserved).toBe(true);
  } finally { await app.dispose(); }
});

test('completes a multiline resource token without corrupting the caret or trailing lines', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false });
  try {
    await app.launch();
    const page = app.page!;
    const editor = page.locator('#new-chat-input');
    await editor.fill('@{skill:line one\nline two');
    await editor.press('End');
    await editor.press('}');
    await expect(editor.locator('[data-kind="skill"]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe('@{skill:line one\nline two}');
    await editor.press('Shift+Enter');
    await page.keyboard.insertText('tail');
    await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe('@{skill:line one\nline two}\ntail');
  } finally { await app.dispose(); }
});


test('disabled composers preserve selection and copy but cannot send, delete or undo until re-enabled', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false });
  try {
    await app.launch();
    const page = app.page!;
    const input = page.locator('#new-chat-input');
    await input.fill('draft');
    await input.press('End');
    await page.keyboard.insertText('!');
    await page.evaluate(() => {
      const w = window as any;
      w.submitCount = 0;
      w.handleNewChatSubmit = () => { w.submitCount++; };
      w.composerSetDisabled('new-chat-input', true);
    });
    await expect(input).toHaveAttribute('contenteditable', 'false');
    for (const key of ['Enter', 'Backspace', 'Delete', `${modifier}+z`]) await input.press(key);
    expect(await page.evaluate(() => (window as any).submitCount)).toBe(0);
    expect(await page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe('draft!');
    await page.evaluate(() => {
      const w = window as any;
      w.composerSetSelection('new-chat-input', 0, 6);
      const data = new DataTransfer();
      document.getElementById('new-chat-input')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      w.copiedDisabled = data.getData('text/plain');
      w.composerSetDisabled('new-chat-input', false);
      w.composerSetSelection('new-chat-input', 6);
      w.focusChatRichComposer('new-chat-input');
    });
    expect(await page.evaluate(() => (window as any).copiedDisabled)).toBe('draft!');
    await input.press('Backspace');
    expect(await page.evaluate(() => (window as any).composerText('new-chat-input'))).toBe('draft');
    await input.press('Enter');
    expect(await page.evaluate(() => (window as any).submitCount)).toBe(1);
  } finally { await app.dispose(); }
});


test('Home immediately after refocus crosses an atomic recipient without restoring the old caret', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false });
  try {
    await app.launch();
    const page = app.page!;
    const input = page.locator('#new-chat-input');
    for (let attempt = 0; attempt < 5; attempt++) {
      await input.fill('@commander 你好，check the request');
      await input.press('End');
      await page.locator('#new-chat-recipient-chip').focus();
      await page.evaluate(() => (window as any).focusChatRichComposer('new-chat-input'));
      // No settling delay: this must work inside the engine's focus window.
      await input.press('Home');
      for (let step = 0; step < 5; step++) await input.press('ArrowRight');
      await page.keyboard.insertText('X');
      await expect.poll(() => page.evaluate(() => (window as any).composerText('new-chat-input')))
        .toBe('@commander 你好，Xcheck the request');
    }
  } finally { await app.dispose(); }
});
