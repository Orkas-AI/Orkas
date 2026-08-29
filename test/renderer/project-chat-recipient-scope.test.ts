import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// The project detail composer keeps ONE ephemeral recipient for every project
// (`conversation.js::_projectChatRecipient`). Opening a project must therefore
// re-check that pick against the project the user is now looking at: the send
// path turns the chip into an `@name` prefix and the group bus resolves
// mentions against the GLOBAL agent registry, so a pick carried over from
// another project would really dispatch an out-of-project Agent into the new
// conversation.
//
// Both real decision sites run here: the wiring inside `loadProjectDetail`
// (project-detail.js) and the shared rule in `validateRecipientAgainstProject`
// (conversation.js). Only the recipient store and the heavy DOM renderers are
// fixtures, and the oracle is the recipient the send path would read back.

const projectDetailSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
  'utf8',
);
const conversationSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(source: string, name: string): string {
  const marker = `function ${name}`;
  const found = source.indexOf(marker);
  if (found < 0) throw new Error(`missing ${name}`);
  // Keep an `async` prefix — dropping it turns the body's `await` into a
  // SyntaxError instead of running the real function.
  const start = source.startsWith('async ', found - 6) ? found - 6 : found;
  const braceStart = source.indexOf('{', found);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

type Bindings = Record<string, string[]>;
type Recipient = { kind: string; id?: string; name?: string };

/** Let pending microtasks and the IPC promise chain settle. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function mountProjectDetail(bindings: Bindings, held: string[] = []) {
  const holdSet = new Set(held);
  const gates: Record<string, Array<() => void>> = {};
  const bindingCalls: string[] = [];
  const answer = (channel: string, value: unknown) => {
    if (!holdSet.has(channel)) return Promise.resolve(value);
    return new Promise((resolve) => {
      (gates[channel] ||= []).push(() => resolve(value));
    });
  };
  const context = vm.createContext({
    console,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; },
      createElement() { return { appendChild() {}, className: '', dataset: {}, style: {} }; },
    },
    window: {
      addEventListener() {},
      orkas: {
        invoke(channel: string, args: { projectId?: string }) {
          const pid = args?.projectId || '';
          switch (channel) {
            case 'projects.get':
              return answer(channel, { ok: true, project: { project_id: pid, name: pid } });
            case 'projects.bindings.list':
              bindingCalls.push(pid);
              return answer(channel, {
                ok: true,
                bindings: { agents: bindings[pid] || [], skills: [] },
                agentDetails: [],
                skillDetails: [],
              });
            case 'projects.files.tree':
              return answer(channel, { ok: true, tree: [] });
            case 'projects.files.status':
            case 'projects.instructions.get':
              return answer(channel, { ok: false });
            case 'autoTasks.list':
              return answer(channel, { ok: true, tasks: [] });
            default:
              return Promise.resolve({ ok: true });
          }
        },
      },
    },
    t: (key: string) => key,
    uiAlert() {},
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(projectDetailSource, context, { filename: 'project-detail.js' });
  vm.runInContext(
    extractFunction(conversationSource, 'validateRecipientAgainstProject'),
    context,
    { filename: 'conversation.js#validateRecipientAgainstProject' },
  );
  // Recipient store fixture — holds state only; the reset rule under test
  // lives in the two real functions loaded above.
  vm.runInContext(`
    let __projectRecipient = { kind: 'commander' };
    function _activeRecipient(target) {
      return target === 'project' ? __projectRecipient : { kind: 'commander' };
    }
    function setChatRecipient(target, next) {
      if (target === 'project') __projectRecipient = next;
    }
    function _renderRecipientChip() {}
    function __readProjectRecipient() { return JSON.parse(JSON.stringify(__projectRecipient)); }
    function __pickProjectAgent(id, name) { __projectRecipient = { kind: 'agent', id, name }; }
    _renderProjectDetail = function () {};
    _setProjectAutoTabCount = function () {};
    _kickProjectKbReconcileIfNeeded = function () {};
    _scheduleProjectKbStatusRefreshIfNeeded = function () {};
  `, context);
  return {
    bindingCalls,
    pickAgent(id: string, name: string) {
      vm.runInContext(`__pickProjectAgent(${JSON.stringify(id)}, ${JSON.stringify(name)})`, context);
    },
    open(pid: string) {
      return vm.runInContext(`loadProjectDetail(${JSON.stringify(pid)})`, context) as Promise<void>;
    },
    release(channel: string) {
      const queued = gates[channel] || [];
      gates[channel] = [];
      queued.forEach((fn) => fn());
    },
    recipient() {
      return vm.runInContext('__readProjectRecipient()', context) as Recipient;
    },
  };
}

const COMMANDER: Recipient = { kind: 'commander' };

describe('project composer recipient follows the open project', () => {
  it('drops an agent the newly opened project is not bound to', async () => {
    const panel = mountProjectDetail({ p_alpha: ['agent_writer'], p_beta: ['agent_coder'] });
    await panel.open('p_alpha');
    panel.pickAgent('agent_writer', 'Writer');

    await panel.open('p_beta');

    expect(panel.recipient()).toEqual(COMMANDER);
  });

  it('keeps a pick the newly opened project is also bound to', async () => {
    const panel = mountProjectDetail({ p_alpha: ['agent_writer'], p_beta: ['agent_writer'] });
    await panel.open('p_alpha');
    panel.pickAgent('agent_writer', 'Writer');

    await panel.open('p_beta');

    expect(panel.recipient()).toEqual({ kind: 'agent', id: 'agent_writer', name: 'Writer' });
  });

  it('drops the pick when that agent is unbound while the project stays open', async () => {
    const bindings: Bindings = { p_alpha: ['agent_writer'] };
    const panel = mountProjectDetail(bindings);
    await panel.open('p_alpha');
    panel.pickAgent('agent_writer', 'Writer');

    bindings.p_alpha = [];
    await panel.open('p_alpha'); // what `_removeProjectAgent` re-runs after a removal

    expect(panel.recipient()).toEqual(COMMANDER);
  });

  it('clears the stale target before the rest of the project load finishes', async () => {
    // A large library makes `projects.files.tree` the slow leg of the load
    // batch. The composer is usable that whole time, so the recipient must be
    // corrected off the bindings answer alone.
    const panel = mountProjectDetail(
      { p_alpha: ['agent_writer'], p_beta: [] },
      ['projects.files.tree'],
    );
    const first = panel.open('p_alpha');
    panel.release('projects.files.tree');
    await first;
    panel.pickAgent('agent_writer', 'Writer');

    const second = panel.open('p_beta');
    await settle();

    expect(panel.recipient()).toEqual(COMMANDER);

    panel.release('projects.files.tree');
    await second;
  });

  it('ignores a bindings answer for a project the user already left', async () => {
    const panel = mountProjectDetail(
      { p_alpha: ['agent_writer'], p_beta: ['agent_coder'] },
      ['projects.bindings.list'],
    );
    const first = panel.open('p_alpha');
    const second = panel.open('p_beta');
    panel.pickAgent('agent_coder', 'Coder'); // valid in the project now on screen

    panel.release('projects.bindings.list'); // p_alpha answers too, late
    await Promise.all([first, second]);

    expect(panel.recipient()).toEqual({ kind: 'agent', id: 'agent_coder', name: 'Coder' });
    expect(panel.bindingCalls).toEqual(['p_alpha', 'p_beta']);
  });
});
