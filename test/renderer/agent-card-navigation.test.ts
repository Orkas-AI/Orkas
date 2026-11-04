import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../../src/renderer/modules/agents.js', import.meta.url), 'utf8');
function harness() {
  const ast = ts.createSourceFile('agents.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['clearAgentCardHighlights', '_applyAgentCardHighlights', 'showAgentCards'];
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || '')).map(node => node.getText(ast)).join('\n');
  const cards = ['saved_a', 'saved_b', 'same_name_other_id'].map(id => ({ dataset: { id }, classList: { add: vi.fn(), remove: vi.fn() }, scrollIntoView: vi.fn(), setAttribute: vi.fn(), focus: vi.fn() }));
  let finish!: (result?: boolean) => void;
  const context: any = { window: {}, currentView: 'conversation', currentUserId: 'a', _agentsActiveCategory: 'hidden',
    document: { querySelectorAll: () => cards }, setTimeout, clearTimeout, Date,
    uiAlert: vi.fn(), t: (key: string) => key,
    _showAgentsGridView: vi.fn(), loadAgents: vi.fn(() => new Promise<boolean | undefined>(r => { finish = r; })),
    setView: vi.fn((view: string) => { context.currentView = view; }),
  };
  vm.createContext(context); vm.runInContext('let _agentCardHighlight = null; let _agentCardNavigationEpoch = 0;\n' + functions, context);
  return { context, cards, finish: (result?: boolean) => finish(result) };
}
afterEach(() => vi.useRealTimers());
it('clears filters, refreshes, highlights only returned ids, reapplies on repaint and expires', async () => {
  vi.useFakeTimers(); const { context: c, cards, finish } = harness();
  const pending = c.showAgentCards(['saved_a', 'saved_b', '../bad']);
  expect(c._agentsActiveCategory).toBe(''); expect(c.setView).toHaveBeenCalledWith('agents');
  finish(); await pending;
  expect(cards[0].scrollIntoView).toHaveBeenCalledTimes(1);
  expect(cards[1].classList.add).toHaveBeenCalledWith('is-highlighted');
  expect(cards[2].classList.add).not.toHaveBeenCalled();
  c._applyAgentCardHighlights(); expect(cards[0].scrollIntoView).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2501);
  expect(cards[0].classList.remove).toHaveBeenCalled();
});
it.each(['account', 'view', 'leave-and-return'])('abandons a delayed target after %s changes', async mode => {
  const { context: c, cards, finish } = harness(); const pending = c.showAgentCards(['saved_a']);
  if (mode === 'account') c.currentUserId = 'b';
  else if (mode === 'view') c.currentView = 'conversation';
  else { c.clearAgentCardHighlights(); c.currentView = 'agents'; }
  finish(); await pending;
  expect(cards[0].classList.add).not.toHaveBeenCalled();
});

it.each(['deleted', 'load-failed'])('keeps the list and explains a missing target after %s without recreating it', async mode => {
  const { context: c, cards, finish } = harness();
  if (mode === 'deleted') cards.splice(0);
  const pending = c.showAgentCards(['saved_a']); finish(mode === 'load-failed' ? false : undefined); await pending;
  expect(c.uiAlert).toHaveBeenCalledWith(mode === 'deleted' ? 'agents.agent_not_found' : 'agents.load_failed');
  expect(c.setView).toHaveBeenCalledTimes(1);
});
