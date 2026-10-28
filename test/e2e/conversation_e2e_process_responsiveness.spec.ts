import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, OrkasTestApp, test } from './fixtures/orkas';

const functions = new Set([
  '_refreshProcessCompactGroup', '_createProcessCompactGroup', '_compactAdjacentProcessRows',
  '_processLifecycleRow', '_appendProcessTextLines', '_appendProjectedProcessRowToBody',
]);
function declarations(source: string): string {
  const ast = ts.createSourceFile('conversation.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = ast.statements.filter(node => ts.isFunctionDeclaration(node) && functions.has(node.name?.text || ''));
  expect(found).toHaveLength(functions.size);
  return found.map(node => node.getText(ast)).join('\n');
}

// Optional paired measurement uses a caller-supplied, archived source file.
// Regular regression runs need neither Git history nor an external service.
test('restores and updates a complete process rail without changing disclosure or focus', async ({}, testInfo) => {
  const app = new OrkasTestApp(testInfo, { marketplaceStub: true });
  const candidate = declarations(readFileSync(path.resolve(__dirname, '../..', 'src/renderer/modules/conversation.js'), 'utf8'));
  const baseline = process.env.ORKAS_PROCESS_BASELINE_SOURCE;
  const variants = [
    ...(baseline ? [{ name: 'baseline', source: declarations(readFileSync(baseline, 'utf8')) }] : []),
    { name: 'candidate', source: candidate },
  ];
  try {
    await app.launch();
    const results = [];
    for (const variant of variants) {
      results.push(await app.page!.evaluate(async ({ name, source }) => {
        const api = window as any;
        (0, eval)(source);
        const host = document.createElement('div');
        host.className = 'chat-history';
        host.style.cssText = 'position:fixed;top:80px;left:300px;width:600px;height:400px;display:block;overflow:auto;background:var(--bg-primary);z-index:9999';
        host.style.scrollBehavior = 'auto';
        document.body.appendChild(host);
        api._bindStickToBottom(host);
        const focus = document.createElement('input');
        host.appendChild(focus);
        focus.focus();
        const row: HTMLElement = api._createStreamingAssistantMessage(host);
        const items = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({
          type: 'event', event: { stream: 'tool', data: {
            name: 'bash', phase: 'end', callId: `responsiveness-${start + i}`, output: `Complete result ${start + i}\nLast line`,
          } },
        }));
        const start = performance.now();
        api._replayPersistedProcessItems(row, items(0, 2500));
        const restoreMs = performance.now() - start;
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const usableFrameMs = performance.now() - start;
        const group = row.querySelector('.stream-process-compact-group') as HTMLDetailsElement;
        group.open = true;
        await new Promise(resolve => setTimeout(resolve, 100));
        host.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
        host.scrollTop = 84;
        const scrollBefore = host.scrollTop;
        const append = performance.now();
        api._replayPersistedProcessItems(row, items(2500, 100));
        const appendMs = performance.now() - append;
        const body = row.querySelector('.stream-process-body')!;
        const rows = [...body.querySelectorAll<HTMLElement>('[data-process-operation="1"]')];
        const result = {
          name, restoreMs, usableFrameMs, appendMs, markup: body.innerHTML,
          identities: rows.map(node => node.dataset.processCallId),
          lastOutput: (rows.at(-1) as any)._fullOutput,
          open: group.open, focused: document.activeElement === focus,
          scrollBefore, scrollAfter: host.scrollTop,
          geometry: { height: host.clientHeight, scrollHeight: host.scrollHeight,
            rowHeight: row.clientHeight, outerOpen: (row.querySelector('.stream-process') as HTMLDetailsElement).open },
        };
        if (name === 'baseline') host.remove();
        return result;
      }, variant));
    }
    const current = results.at(-1)!;
    console.log('Process geometry', JSON.stringify(results.map(({ markup, identities, ...result }) => ({ ...result, rows: identities.length }))));
    expect(current.identities).toHaveLength(2600);
    expect(new Set(current.identities).size).toBe(2600);
    expect(current.lastOutput).toBe('Complete result 2599\nLast line');
    expect(current.open).toBe(true);
    expect(current.focused).toBe(true);
    expect(current.scrollBefore).toBe(84);
    expect(current.scrollAfter).toBe(current.scrollBefore);
    if (baseline) {
      expect(current.markup).toBe(results[0].markup);
      expect(current.identities).toEqual(results[0].identities);
      expect(current.scrollAfter).toBe(results[0].scrollAfter);
    }
    const evidence = { launchReadyMs: app.lastLaunchReadyMs,
      results: results.map(({ markup, identities, ...result }) => ({ ...result, rows: identities.length })) };
    writeFileSync(testInfo.outputPath('process-responsiveness.json'), JSON.stringify(evidence, null, 2));
    console.log('Process rail measurement', JSON.stringify(evidence));
    await app.page!.screenshot({ path: testInfo.outputPath('unchanged-app.png') });
  } finally { await app.dispose(); }
});
