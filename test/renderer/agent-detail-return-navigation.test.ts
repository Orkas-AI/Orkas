import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const agentsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/agents.js'), 'utf8');
const conversationSource = fs.readFileSync(path.join(root, 'src/renderer/modules/conversation.js'), 'utf8');
const projectDetailSource = fs.readFileSync(path.join(root, 'src/renderer/modules/project-detail.js'), 'utf8');
const searchSource = fs.readFileSync(path.join(root, 'src/renderer/modules/search.js'), 'utf8');
const stateSource = fs.readFileSync(path.join(root, 'src/renderer/modules/state.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(root, 'src/renderer/modules/boot.js'), 'utf8');

function extractFunction(source: string, name: string): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  const start = source.indexOf(asyncMarker) >= 0
    ? source.indexOf(asyncMarker)
    : source.indexOf(syncMarker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
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

function loadNavigation(initialView: string, initialId = '') {
  const elements = new Map<string, {
    style: Record<string, string>;
    classList: {
      add: (name: string) => void;
      remove: (name: string) => void;
      toggle: (name: string, force?: boolean) => boolean;
      contains: (name: string) => boolean;
    };
  }>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      const classes = new Set<string>();
      elements.set(id, {
        style: {},
        classList: {
          add: (name: string) => { classes.add(name); },
          remove: (name: string) => { classes.delete(name); },
          toggle: (name: string, force?: boolean) => {
            const next = force === undefined ? !classes.has(name) : force;
            if (next) classes.add(name);
            else classes.delete(name);
            return next;
          },
          contains: (name: string) => classes.has(name),
        },
      });
    }
    return elements.get(id)!;
  };
  const selectAgent = vi.fn(async () => {});
  const setView = vi.fn((view: string, id?: string) => {
    context.currentView = view;
    context.currentCid = view === 'conversation' ? (id || '') : null;
    if (view === 'project') context._projectDetailPid = id || '';
  });
  const context: any = {
    Object,
    currentView: initialView,
    currentCid: initialView === 'conversation' ? initialId : null,
    _projectDetailPid: initialView === 'project' ? initialId : '',
    _agentDetailReturnTarget: null,
    _agentEditing: false,
    _selectedAgent: null,
    _exitAgentEditMode: vi.fn(async () => {}),
    _closeAgentRowMenu: vi.fn(),
    document: {
      getElementById: (id: string) => element(id),
    },
    selectAgent,
    setView,
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction(agentsSource, '_normalizeAgentDetailReturnTarget'),
    extractFunction(agentsSource, '_captureAgentDetailReturnTarget'),
    extractFunction(agentsSource, '_showAgentsGridView'),
    extractFunction(agentsSource, '_showAgentsDetailView'),
    extractFunction(agentsSource, 'openAgentDetail'),
    extractFunction(agentsSource, '_isAgentDetailReturnTargetCurrent'),
    extractFunction(agentsSource, '_returnFromAgentsDetailView'),
    extractFunction(agentsSource, '_resetAgentsDetailForNavigation'),
  ].join('\n'), context);
  return { context, element, selectAgent, setView };
}

describe('agent detail return navigation', () => {
  it('returns a viewed agent to the conversation that opened it', async () => {
    const { context, element, selectAgent, setView } = loadNavigation('conversation', 'conversation-a');

    await context.openAgentDetail('agent-a');

    expect(setView).not.toHaveBeenCalled();
    expect(selectAgent).toHaveBeenCalledWith('agent-a', { refreshCliOptions: true });
    expect(element('agents-grid-view').style.display).toBe('none');
    expect(element('agents-detail-view').style.display).toBe('flex');
    expect(element('panel-agents').classList.contains('resource-detail-overlay')).toBe(true);
    expect(context.currentView).toBe('conversation');

    context._returnFromAgentsDetailView();

    expect(setView).not.toHaveBeenCalled();
    expect(element('agents-grid-view').style.display).toBe('flex');
    expect(element('agents-detail-view').style.display).toBe('none');
    expect(element('panel-agents').classList.contains('resource-detail-overlay')).toBe(false);
    expect(context.currentView).toBe('conversation');
  });

  it('returns a viewed agent to the project that opened it', async () => {
    const { context, setView } = loadNavigation('project', 'project-a');

    await context.openAgentDetail('agent-a');
    context._returnFromAgentsDetailView();

    expect(setView).not.toHaveBeenCalled();
    expect(context.currentView).toBe('project');
  });

  it('keeps AI Team as the return target when its own grid opened the detail', async () => {
    const { context, element, setView } = loadNavigation('agents');

    await context.openAgentDetail('agent-a');
    context._returnFromAgentsDetailView();

    expect(setView).not.toHaveBeenCalled();
    expect(element('panel-agents').classList.contains('resource-detail-overlay')).toBe(false);
    expect(element('agents-grid-view').style.display).toBe('flex');
    expect(element('agents-detail-view').style.display).toBe('none');
  });

  it('dismisses an open detail before explicit navigation so the tab reopens on its grid', async () => {
    const { context, element } = loadNavigation('conversation', 'conversation-a');

    await context.openAgentDetail('agent-a');
    context._resetAgentsDetailForNavigation();

    expect(element('panel-agents').classList.contains('resource-detail-overlay')).toBe(false);
    expect(element('agents-grid-view').style.display).toBe('flex');
    expect(element('agents-detail-view').style.display).toBe('none');
    expect(context._agentDetailReturnTarget).toBeNull();
    expect(bootSource).toContain("_resetAgentsDetailForNavigation === 'function'");
  });

  it('routes every cross-page entry and both back gestures through the shared helpers', () => {
    expect(conversationSource).toContain("await openAgentDetail('commander', { returnTarget })");
    expect(conversationSource).toContain('await openAgentDetail(aid, { returnTarget })');
    expect(conversationSource).toContain('openAgentDetail(aid, { returnTarget })');
    expect(projectDetailSource).toContain('await openAgentDetail(agentId)');
    expect(searchSource).toContain('await openAgentDetail(r.id, { returnTarget: agentReturnTarget })');
    expect(stateSource).toContain(
      "document.getElementById('agents-back-btn')?.addEventListener('click', () => _returnFromAgentsDetailView())",
    );
    expect(stateSource.match(/_returnFromAgentsDetailView\(\)/g)).toHaveLength(2);
  });

  it('preserves the modal entry target for both create flows until detail opens', () => {
    const createStart = agentsSource.indexOf('async function _saveCreateAgent');
    const createEnd = agentsSource.indexOf('async function _saveExternalAgent', createStart);
    const externalEnd = agentsSource.indexOf('/** Normalise IPC-shim error replies', createEnd);
    const createFlow = agentsSource.slice(createStart, createEnd);
    const externalFlow = agentsSource.slice(createEnd, externalEnd);

    expect(agentsSource).toContain('_agentModalReturnTarget = _captureAgentDetailReturnTarget()');
    expect(createFlow).toContain('const detailReturnTarget = _agentModalReturnTarget');
    expect(createFlow).toContain(
      'await openAgentDetail(data.agent.agent_id, { returnTarget: detailReturnTarget })',
    );
    expect(externalFlow).toContain('const detailReturnTarget = _agentModalReturnTarget');
    expect(externalFlow).toContain(
      'await openAgentDetail(data.agent.agent_id, { returnTarget: detailReturnTarget })',
    );
  });
});
