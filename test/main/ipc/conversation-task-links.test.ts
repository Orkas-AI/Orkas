import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(path.join(__dirname, '../../../src/main/ipc/index.ts'), 'utf8');
const start = source.indexOf('async function conversationNavigationRows(');
const code = ts.transpileModule(source.slice(start, source.indexOf('\nfunction conversationProjectHint(', start)), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

describe('conversation navigation enrichment', () => {
  it('adds scoped destinations without mutating cached conversation metadata or pagination', async () => {
    const link = { kind: 'todo', task_id: 't_0123456789ab', project_id: 'p1', title: 'Review' };
    const lookup = vi.fn(async () => new Map([['c1', [link]]]));
    const context = vm.createContext({ require: () => ({ conversationTaskLinks: lookup }), log: { warn: vi.fn() } });
    vm.runInContext(code, context);
    const row = { conversation_id: 'c1', project_id: 'p1', title: 'Task' };
    const page = { conversations: [row], total: 27, next_offset: 10 };
    expect(await context.conversationNavigationPage('account-a', page)).toEqual({
      ...page, conversations: [{ ...row, task_links: [link] }],
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith('account-a', [row]);
    expect(row).not.toHaveProperty('task_links');
  });

  it('keeps conversations available and excludes raw private lookup failures from logs', async () => {
    const warn = vi.fn();
    const context = vm.createContext({
      require: () => ({ conversationTaskLinks: async () => { throw new Error('Private task title'); } }), log: { warn },
    });
    vm.runInContext(code, context);
    const rows = [{ conversation_id: 'c1', title: 'Task' }];
    expect(await context.conversationNavigationRows('account-a', rows)).toEqual(rows);
    expect(warn).toHaveBeenCalledExactlyOnceWith('conversation task links unavailable');
  });
});
