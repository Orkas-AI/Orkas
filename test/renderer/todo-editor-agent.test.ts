import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(load?: (channel: string, args: any) => Promise<any>) {
  const calls: any[] = [];
  const alerts: string[] = [];
  const elements: Record<string, any> = {};
  const selects: Record<string, any> = {};
  for (const id of ['input', 'add', 'agent', 'project', 'status', 'save', 'cancel']) {
    elements['project-todo-' + id] = {
      id: 'project-todo-' + id, value: '', maxLength: 200, dataset: {}, hidden: false,
      focus() {}, setSelectionRange() {}, classList: { toggle() {} }, querySelector() { return null; },
    };
  }
  const context = vm.createContext({
    setTimeout, clearTimeout,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    document: { readyState: 'loading', addEventListener() {}, getElementById: (id: string) => elements[id] || null },
    window: { addEventListener() {}, orkas: { async invoke(channel: string, args: any) {
      calls.push({ channel, args });
      if (load) return load(channel, args);
      if (channel === 'agents.list') return { agents: [{ agent_id: 'a', name: 'Alpha' }, { agent_id: 'b', name: 'Beta' }] };
      if (channel === 'projects.bindings.list') return { ok: true, agentDetails: [{ agent_id: args.projectId, name: args.projectId }] };
      return { ok: true };
    } } },
    t: (key: string) => key,
    uiAlert: (message: string) => alerts.push(message),
    _aiSelectMount(el: any, config: any) {
      const api = {
        state: { ...config }, close() {},
        setOptions(options: any[], opts: any = {}) { api.state.options = options; if (opts.value !== undefined) api.state.value = opts.value; },
        getValue() { return api.state.value; },
        pick(value: string) { api.state.value = value; api.state.onChange?.(value); },
      };
      selects[el.id] = api;
      return api;
    },
  });
  vm.runInContext(source, context);
  const open = async (task: any = null, pid = '') => {
    context._openProjectTodoEditor(task, { pid, global: !pid, projects: [{ project_id: 'p', name: 'Project' }] });
    await tick();
  };
  return { context, calls, alerts, elements, selects, open };
}

describe('todo editor assignment', () => {
  it.each(['', 'p'])('creates, reopens, and clears an assigned task in scope %s', async (pid) => {
    const h = harness();
    await h.open(null, pid);
    h.elements['project-todo-input'].value = 'Deliver brief';
    h.selects['project-todo-agent'].pick(pid || 'a');
    await h.context._saveProjectTodoEditor();
    const created = h.calls.find((c) => c.channel === 'projects.tasks.create').args;
    expect(created).toMatchObject({ projectId: pid, owner_agent_id: pid || 'a', owner_agent: pid || 'Alpha' });
    await h.open({ ...created, id: 't_aabbccddeeff' }, pid);
    expect(h.selects['project-todo-agent'].getValue()).toBe(pid || 'a');
    h.selects['project-todo-agent'].pick('');
    await h.context._saveProjectTodoEditor();
    expect(h.calls.find((c) => c.channel === 'projects.tasks.update').args)
      .toMatchObject({ owner_agent: '', owner_agent_id: '' });
    expect(h.alerts).toEqual([]);
  });

  it('preserves concurrent assignment on a title-only edit, including a removed owner', async () => {
    const h = harness();
    await h.open({ id: 't_aabbccddeeff', title: 'Old', status: 'todo', owner_agent_id: 'removed', owner_agent: 'Previous owner' });
    expect(h.selects['project-todo-agent'].getValue()).toBe('removed');
    h.elements['project-todo-input'].value = 'New';
    await h.context._saveProjectTodoEditor();
    const patch = h.calls.find((c) => c.channel === 'projects.tasks.update').args;
    expect(patch).toEqual({ projectId: '', taskId: 't_aabbccddeeff', title: 'New' });
  });

  it('discards stale agent responses when the project changes and never carries an owner across scopes', async () => {
    let release: (value: any) => void = () => {};
    const h = harness(async (channel, args) => {
      if (channel === 'agents.list') return { agents: [{ agent_id: 'a', name: 'Alpha' }] };
      if (channel === 'projects.bindings.list' && args.projectId === 'slow') return new Promise((resolve) => { release = resolve; });
      if (channel === 'projects.bindings.list') return { agentDetails: [{ agent_id: 'p', name: 'Project agent' }] };
      return { ok: true };
    });
    await h.open();
    h.selects['project-todo-agent'].pick('a');
    h.selects['project-todo-project'].pick('slow');
    h.selects['project-todo-project'].pick('p');
    await tick();
    release({ agentDetails: [{ agent_id: 'wrong', name: 'Wrong project' }] });
    await tick();
    expect(h.selects['project-todo-agent'].state.options.map((o: any) => o.value)).toEqual(['', 'p']);
    expect(h.selects['project-todo-agent'].getValue()).toBe('');
    h.elements['project-todo-input'].value = 'New';
    await h.context._saveProjectTodoEditor();
    expect(h.calls.find((c) => c.channel === 'projects.tasks.create').args).not.toHaveProperty('owner_agent_id');
  });

  it('keeps the selected owner and title after a failed save so the user can retry', async () => {
    let fail = true;
    const h = harness(async (channel) => channel === 'agents.list'
      ? { agents: [{ agent_id: 'a', name: 'Alpha' }] }
      : { ok: !fail });
    await h.open();
    h.elements['project-todo-input'].value = 'Keep draft';
    h.selects['project-todo-agent'].pick('a');
    await h.context._saveProjectTodoEditor();
    expect(h.elements['project-todo-input'].value).toBe('Keep draft');
    expect(h.selects['project-todo-agent'].getValue()).toBe('a');
    expect(h.alerts).toEqual(['project.todo.failed']);
    fail = false;
    await h.context._saveProjectTodoEditor();
    expect(h.elements['project-todo-add'].hidden).toBe(true);
    expect(h.calls.filter((c) => c.channel === 'projects.tasks.create').map((c) => c.args.owner_agent_id)).toEqual(['a', 'a']);
  });
});
