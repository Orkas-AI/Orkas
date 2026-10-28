import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('native composer microphone boundary', () => {
  it('allows only audio in the trusted main frame at both permission boundaries', () => {
    const source = readFileSync(path.join(__dirname, '../../../src/main/index.ts'), 'utf8');
    const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    const statements: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
        && /^session\.defaultSession\.setPermission(?:Check|Request)Handler$/.test(node.expression.expression.getText(tree))) statements.push(node.getText(tree));
      ts.forEachChild(node, visit);
    }
    visit(tree);
    const handlers: Record<string, Function> = {};
    const main = {}, foreign = {};
    vm.runInNewContext(ts.transpileModule(statements.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      session: { defaultSession: {
        setPermissionCheckHandler: (fn: Function) => { handlers.check = fn; },
        setPermissionRequestHandler: (fn: Function) => { handlers.request = fn; },
      } }, BrowserWindow: { fromWebContents: (wc: unknown) => wc }, mainWindows: new Set([main]),
    });
    expect(handlers.check).toBeTypeOf('function');
    for (const [window, isMainFrame, mediaType, allowed] of [
      [main, true, 'audio', true], [main, true, 'video', false],
      [main, false, 'audio', false], [foreign, true, 'audio', false],
    ] as const) {
      expect(handlers.check(window, 'media', '', { isMainFrame, mediaType })).toBe(allowed);
      let result;
      handlers.request(window, 'media', (value: boolean) => { result = value; }, { isMainFrame, mediaTypes: [mediaType] });
      expect(result).toBe(allowed);
    }
  });
});

describe('voice IPC ownership across compatible channel names', () => {
  it.each(['voice', 'voiceInput'])('confines %s tickets, status and permission prompts to the main frame', async (prefix) => {
    const source = readFileSync(path.join(__dirname, '../../../src/main/ipc/index.ts'), 'utf8');
    const tree = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true);
    let register = '';
    const routes: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
        && node.expression.expression.getText(tree) === 'ipcMain.handle'
        && node.expression.arguments[0]?.getText(tree) === "'orkas.invoke'") register = node.getText(tree);
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'invokeHandlers'
        && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property) && /^['"]voice(?:Input)?\./.test(property.name.getText(tree))) routes.push(property.getText(tree));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    let invoke!: (event: unknown, request: unknown) => Promise<unknown>;
    let calls = 0;
    const main = { mainFrame: {} }, preview = { mainFrame: {} }, foreign = { mainFrame: {} };
    const context = {
      ipcMain: { handle: (_channel: string, callback: typeof invoke) => { invoke = callback; } },
      voiceInput: {
        getVoiceStatus: () => { calls++; return { configured: true }; },
        createVoiceSession: () => { calls++; return { url: 'wss://example.invalid/test-ticket' }; },
        ensureMicrophoneAccess: () => { calls++; return { granted: true }; },
      },
      isTrustedIpcSender: (sender: unknown) => sender === main || sender === preview,
      previewWindows: { isPreviewContents: (sender: unknown) => sender === preview },
      parseInvokeEnvelope: (request: unknown) => request,
      resolveContext: async () => ({}), log: { warn() {} },
    };
    vm.runInNewContext(ts.transpileModule(`const invokeHandlers = {${routes.join(',')}};\n${register}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    for (const operation of ['status', 'createSession', 'ensureMicrophoneAccess']) {
      const request = { channel: `${prefix}.${operation}`, payload: {} };
      const previousCalls = calls;
      for (const event of [
        { sender: main, senderFrame: {} },
        { sender: preview, senderFrame: preview.mainFrame },
        { sender: foreign, senderFrame: foreign.mainFrame },
      ]) expect(await invoke(event, request)).toMatchObject({ ok: false, code: 'E_IPC_SENDER' });
      expect(calls).toBe(previousCalls);
      expect(await invoke({ sender: main, senderFrame: main.mainFrame }, request)).toMatchObject({ ok: true });
      expect(calls).toBe(previousCalls + 1);
    }
  });
});
