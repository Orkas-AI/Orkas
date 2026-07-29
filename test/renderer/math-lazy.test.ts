import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadMathBridge({ failLoads = 0 } = {}) {
  const appended: any[] = [];
  const warn = vi.fn();
  const typesetPromise = vi.fn(async () => {});
  const context: any = {
    Map,
    Promise,
    Error,
    String,
    console: { info() {}, warn },
    createLogger: () => ({ info() {}, warn }),
    window: {
      MathJax: {
        startup: { typeset: false },
      },
    },
    document: {
      createElement: () => ({ dataset: {}, remove: vi.fn() }),
      head: {
        appendChild(script: any) {
          appended.push(script);
          if (appended.length <= failLoads) {
            script.onerror();
            return;
          }
          context.window.MathJax = {
            startup: { promise: Promise.resolve() },
            typesetPromise,
            typesetClear: () => {},
          };
          script.onload();
        },
      },
      documentElement: { appendChild() {} },
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/math.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'math.js' });
  return { context, appended, typesetPromise, warn };
}

describe('renderer MathJax lazy loading', () => {
  it('does not load the runtime for ordinary chat content', async () => {
    const { context, appended } = loadMathBridge();
    await context.window.typesetMath({ textContent: 'plain message', querySelectorAll: () => [] });
    expect(appended).toEqual([]);
  });

  it('loads the runtime once when concurrent formula renders arrive', async () => {
    const { context, appended } = loadMathBridge();
    const root = { textContent: 'solve $x+1=2$', querySelectorAll: () => [] };
    await Promise.all([
      context.window.typesetMath(root),
      context.window.typesetMath(root),
    ]);
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe('./vendor/mathjax/tex-chtml.js');
    expect(appended[0].async).toBe(true);
  });

  it('retries after a transient runtime load failure without exposing the raw error', async () => {
    const { context, appended, typesetPromise, warn } = loadMathBridge({ failLoads: 1 });
    const root = { textContent: 'solve $x+1=2$', querySelectorAll: () => [] };

    await context.window.typesetMath(root);
    await context.window.typesetMath(root);

    expect(appended).toHaveLength(2);
    expect(appended[0].remove).toHaveBeenCalledOnce();
    expect(typesetPromise).toHaveBeenCalledWith([root]);
    expect(warn).toHaveBeenCalledWith('typeset failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('MathJax runtime');
  });
});
