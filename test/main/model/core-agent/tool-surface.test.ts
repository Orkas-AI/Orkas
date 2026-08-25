import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createToolLoadTool,
  createToolSurfaceController,
} from '../../../../src/main/model/core-agent/tool-surface';
import {
  getActiveToolGroupsTurnBlock,
  getLoadableToolGroupsSystemPromptBlock,
} from '../../../../src/main/model/core-agent/tool-catalog';

describe('tool-surface', () => {
  let previousMode: string | undefined;

  beforeEach(() => {
    previousMode = process.env.ORKAS_TOOL_LOADING_MODE;
  });

  afterEach(() => {
    if (previousMode === undefined) delete process.env.ORKAS_TOOL_LOADING_MODE;
    else process.env.ORKAS_TOOL_LOADING_MODE = previousMode;
  });

  it('uses scoped mode by default for an eligible new session', () => {
    delete process.env.ORKAS_TOOL_LOADING_MODE;
    const surface = createToolSurfaceController({
      availableToolNames: ['read_files', 'write_file', 'web_search', 'tool_load'],
      configuredGroups: ['workspace.read'],
      scopedEligible: true,
    });

    expect(surface.mode).toBe('scoped');
    expect(surface.dynamicLoading).toBe(true);
    expect(surface.activeToolNames()).toEqual(expect.arrayContaining(['read_files', 'tool_load']));
    expect(surface.activeToolNames()).toHaveLength(2);
  });

  it('keeps the full available surface when legacy rollback is explicit', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'legacy';
    const surface = createToolSurfaceController({
      availableToolNames: ['read_files', 'write_file', 'web_search'],
      configuredGroups: [],
      scopedEligible: true,
    });

    expect(surface.mode).toBe('legacy_all');
    expect(surface.activeToolNames()).toEqual(['read_files', 'write_file', 'web_search']);
  });

  it('keeps fixed actors scoped, drops restored dynamic groups, and rejects loading', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'legacy';
    const states: Array<{ loadedGroups: string[] }> = [];
    const surface = createToolSurfaceController({
      availableToolNames: ['read_files', 'write_file', 'web_search'],
      configuredGroups: ['workspace.write'],
      restoredState: {
        version: 2,
        mode: 'legacy_all',
        loadedGroups: ['web'],
        catalogRevision: '4',
      },
      preserveLegacySession: true,
      scopedEligible: true,
      dynamicLoading: false,
      persist: (state) => states.push(state),
    });

    expect(surface.mode).toBe('scoped');
    expect(surface.dynamicLoading).toBe(false);
    expect(surface.activeToolNames()).toEqual(['write_file']);
    expect(surface.isActive('web_search')).toBe(false);
    expect(surface.load(['web'])).toMatchObject({ isError: true });
    expect(JSON.parse(surface.load(['web']).content)).toEqual({
      ok: false,
      error: 'E_TOOL_LOADING_DISABLED',
    });
    expect(states.at(-1)?.loadedGroups).toEqual([]);
  });

  it('observes host-owned current-turn grants independently of dynamic loading', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const runtimeGrantedGroups: string[] = [];
    const surface = createToolSurfaceController({
      availableToolNames: ['read_files', 'web_search', 'list_connector_tools', 'call_connector_tool'],
      configuredGroups: ['web'],
      runtimeGrantedGroups,
      scopedEligible: true,
      dynamicLoading: false,
    });

    expect(surface.isActive('web_search')).toBe(true);
    expect(surface.isActive('list_connector_tools')).toBe(false);
    expect(surface.load(['connectors'])).toMatchObject({ isError: true });

    runtimeGrantedGroups.push('connectors');

    expect(surface.isActive('list_connector_tools')).toBe(true);
    expect(surface.isActive('call_connector_tool')).toBe(true);
    expect(surface.loadedGroups()).toEqual(['web', 'connectors']);
    expect(surface.dynamicLoading).toBe(false);
    expect(surface.runtimeStats()).toEqual({
      loadCalls: 1,
      newlyLoadedGroups: [],
      newlyActivatedToolNames: [],
    });
  });

  it('gives a named Agent a current-turn fallback limited to Agent dependency groups', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'legacy';
    const surface = createToolSurfaceController({
      availableToolNames: [
        'read_files', 'write_file', 'web_search', 'marketplace_search', 'tool_load',
      ],
      configuredGroups: ['workspace.read'],
      scopedEligible: true,
      dynamicLoading: true,
      dynamicLoadPolicy: 'agent-dependency',
      allowLegacyAll: false,
    });
    const loadTool = createToolLoadTool(surface);
    const groupEnum = ((loadTool.inputSchema as any).properties.groups.items.enum) as string[];

    expect(loadTool.description).toContain('in-domain request');
    expect(loadTool.description).toContain('does not expand the Agent domain');
    expect(surface.mode).toBe('scoped');
    expect(surface.activeToolNames()).toEqual(expect.arrayContaining(['read_files', 'tool_load']));
    expect(surface.isActive('write_file')).toBe(false);
    expect(surface.load(['management'])).toMatchObject({ isError: true });
    expect(surface.isActive('marketplace_search')).toBe(false);
    expect(groupEnum).toContain('workspace.write.output');
    expect(groupEnum).not.toContain('workspace');
    expect(groupEnum).not.toContain('workspace.write');
    expect(groupEnum).not.toContain('management');
    expect(groupEnum).not.toContain('runtime');

    expect(surface.load(['workspace.write'])).toMatchObject({ isError: true });
    expect(JSON.parse(surface.load(['workspace.write.output']).content)).toMatchObject({
      ok: true,
      newly_loaded: ['workspace.write.output'],
    });
    expect(surface.isActive('write_file')).toBe(true);
  });

  it('keeps the tool_load enum aligned with runtime availability and validates its bounds', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const surface = createToolSurfaceController({
      availableToolNames: ['read_files', 'web_search', 'tool_load'],
      scopedEligible: true,
      dynamicLoadPolicy: 'agent-dependency',
      allowLegacyAll: false,
    });
    const loadTool = createToolLoadTool(surface);
    const groupEnum = ((loadTool.inputSchema as any).properties.groups.items.enum) as string[];
    const promptBlock = getLoadableToolGroupsSystemPromptBlock({
      availableToolNames: ['read_files', 'web_search', 'tool_load'],
      allowedGroupIds: surface.loadableGroups(),
      purpose: 'agent-runtime',
    });
    const promptGroups = [...promptBlock.matchAll(/^- `([^`]+)`/gm)]
      .map((match) => match[1]);

    expect(surface.loadableGroups()).toEqual(['workspace.read', 'web']);
    expect(groupEnum).toEqual(['workspace.read', 'web']);
    expect(promptGroups).toEqual(surface.loadableGroups());
    expect(promptBlock).not.toContain('`office.pdf`');
    expect(surface.load(['office.pdf'])).toMatchObject({ isError: true });
    expect(JSON.parse(surface.load(['web', 'web']).content)).toEqual({
      ok: false,
      error: 'E_TOOL_GROUP_DUPLICATE',
      duplicates: ['web'],
    });
    expect(JSON.parse(surface.load([
      'web', 'workspace.read', 'web', 'workspace.read', 'web',
      'workspace.read', 'web', 'workspace.read', 'web',
    ]).content)).toEqual({
      ok: false,
      error: 'E_TOOL_GROUP_LIMIT',
      max_groups: 8,
    });
    expect(surface.isActive('web_search')).toBe(false);
    expect(JSON.parse(surface.load(['web']).content)).toMatchObject({
      ok: true,
      newly_loaded: ['web'],
    });
    expect(surface.isActive('web_search')).toBe(true);
  });

  it('separates dormant host-grantable tools from model-loadable fallback groups', () => {
    const runtimeGrantedGroups: string[] = [];
    const surface = createToolSurfaceController({
      availableToolNames: [
        'web_search', 'list_connector_tools', 'call_connector_tool', 'tool_load',
      ],
      dynamicLoadableToolNames: ['web_search', 'tool_load'],
      runtimeGrantedGroups,
      scopedEligible: true,
      dynamicLoading: true,
      dynamicLoadPolicy: 'agent-dependency',
      allowLegacyAll: false,
    });

    expect(surface.loadableGroups()).toContain('web');
    expect(surface.loadableGroups()).not.toContain('connectors');
    expect(surface.load(['connectors'])).toMatchObject({ isError: true });
    expect(surface.isActive('list_connector_tools')).toBe(false);

    runtimeGrantedGroups.push('connectors');
    expect(surface.isActive('list_connector_tools')).toBe(true);
    expect(surface.isActive('call_connector_tool')).toBe(true);
  });

  it('keeps Commander Connector installation loadable without exposing dormant action tools', () => {
    const surface = createToolSurfaceController({
      availableToolNames: [
        'list_connector_tools', 'call_connector_tool', 'add_custom_connector', 'tool_load',
      ],
      dynamicLoadableToolNames: ['add_custom_connector', 'tool_load'],
      scopedEligible: true,
      dynamicLoading: true,
      dynamicLoadPolicy: 'loadable',
    });

    expect(surface.loadableGroups()).toContain('connectors');
    expect(surface.load(['connectors'])).not.toMatchObject({ isError: true });
    expect(surface.isActive('add_custom_connector')).toBe(true);
    expect(surface.isActive('list_connector_tools')).toBe(false);
    expect(surface.isActive('call_connector_tool')).toBe(false);
  });

  it('activates configured leaves plus host-managed and required tools', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const surface = createToolSurfaceController({
      availableToolNames: [
        'read_files', 'write_file', 'bash', 'web_search',
        'chat_history', 'manage_execution_plan', 'tool_load',
      ],
      configuredGroups: ['workspace.write'],
      hostRequiredToolNames: ['read_files'],
      scopedEligible: true,
    });

    expect(surface.mode).toBe('scoped');
    expect(surface.isActive('write_file')).toBe(true);
    expect(surface.isActive('read_files')).toBe(true);
    expect(surface.isActive('chat_history')).toBe(true);
    expect(surface.isActive('manage_execution_plan')).toBe(true);
    expect(surface.isActive('tool_load')).toBe(true);
    expect(surface.isActive('bash')).toBe(false);
    expect(surface.isActive('web_search')).toBe(false);
  });

  it('keeps configured and host-preloaded groups out of durable dynamic state', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const states: Array<{ loadedGroups: string[] }> = [];
    const surface = createToolSurfaceController({
      availableToolNames: ['read_files', 'web_search', 'tool_load'],
      configuredGroups: ['web'],
      hostPreloadGroups: ['workspace.read'],
      scopedEligible: true,
      persist: (state) => states.push(state),
    });

    expect(surface.loadedGroups()).toEqual(['workspace.read', 'web']);
    expect(surface.isActive('read_files')).toBe(true);
    expect(surface.isActive('web_search')).toBe(true);
    expect(states.at(-1)?.loadedGroups).toEqual([]);

    const redundantLoad = JSON.parse(surface.load(['web', 'workspace.read']).content);
    expect(redundantLoad).toMatchObject({
      ok: true,
      newly_loaded: [],
      already_loaded: ['workspace.read', 'web'],
    });
    expect(states.at(-1)?.loadedGroups).toEqual([]);
  });

  it('batch-loads groups once for the current turn without persisting them', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const states: unknown[] = [];
    const surface = createToolSurfaceController({
      availableToolNames: [
        'read_files', 'write_file', 'bash', 'create_artifact', 'library', 'tool_load',
      ],
      scopedEligible: true,
      persist: (state) => states.push(state),
    });
    const load = createToolLoadTool(surface);
    expect(load.description).toContain('current user turn');
    expect(load.description).toContain('one call');

    const first = JSON.parse((await load.execute(
      { groups: ['workspace', 'library'] },
      { state: {} },
    )).content);
    expect(first).toMatchObject({
      ok: true,
      newly_loaded: ['workspace', 'library'],
      unavailable: [],
    });
    expect(surface.loadedGroups()).toEqual(['workspace', 'library']);
    expect(['read_files', 'write_file', 'bash', 'create_artifact'].every((name) => surface.isActive(name)))
      .toBe(true);
    expect(surface.isActive('library')).toBe(true);

    const second = JSON.parse((await load.execute({ groups: ['workspace.read'] }, { state: {} })).content);
    expect(second).toMatchObject({ ok: true, already_loaded: ['workspace.read'] });
    expect(states).toEqual([expect.objectContaining({
      version: 3,
      mode: 'scoped',
      loadedGroups: [],
      catalogRevision: '10',
    })]);
    expect(surface.runtimeStats()).toEqual({
      loadCalls: 2,
      newlyLoadedGroups: ['workspace', 'library'],
      newlyActivatedToolNames: [
        'read_files',
        'write_file',
        'bash',
        'create_artifact',
        'library',
      ],
    });
  });

  it('returns configured group context only after that group loads successfully', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const surface = createToolSurfaceController({
      availableToolNames: [
        'web_search', 'list_connector_tools', 'call_connector_tool', 'tool_load',
      ],
      scopedEligible: true,
      dynamicLoadPolicy: 'agent-dependency',
      allowLegacyAll: false,
    });
    const load = createToolLoadTool(surface, {
      contextByGroup: { connectors: '## Connectors\n\n- **notion** — Notion' },
    });

    const unrelated = JSON.parse((await load.execute(
      { groups: ['web'] },
      { state: {} },
    )).content);
    expect(unrelated).not.toHaveProperty('loaded_group_context');

    const loaded = JSON.parse((await load.execute(
      { groups: ['connectors'] },
      { state: {} },
    )).content);
    expect(loaded).toMatchObject({
      ok: true,
      newly_loaded: ['connectors'],
      loaded_group_context: {
        connectors: '## Connectors\n\n- **notion** — Notion',
      },
    });

    const rejected = await load.execute({ groups: ['management'] }, { state: {} });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content)).not.toHaveProperty('loaded_group_context');
  });

  it('keeps Management out of Agent dependencies but activates it at runtime', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const states: Array<{ loadedGroups: string[] }> = [];
    const surface = createToolSurfaceController({
      availableToolNames: [
        'skill_search', 'marketplace_search', 'skill_manage', 'tool_load',
      ],
      // A stale or bypassed Agent config must not preload a runtime-only group.
      configuredGroups: ['management'],
      scopedEligible: true,
      persist: (state) => states.push(state),
    });

    expect(surface.isActive('skill_manage')).toBe(true);
    expect(surface.isActive('tool_load')).toBe(true);
    expect(surface.isActive('skill_search')).toBe(false);
    expect(surface.isActive('marketplace_search')).toBe(false);
    expect(states.at(-1)?.loadedGroups).toEqual([]);

    expect(JSON.parse(surface.load(['management']).content)).toMatchObject({
      ok: true,
      newly_loaded: ['management'],
      unavailable: [],
    });
    expect(surface.isActive('skill_search')).toBe(true);
    expect(surface.isActive('marketplace_search')).toBe(true);
    expect(states.at(-1)?.loadedGroups).toEqual([]);
    expect(surface.runtimeStats()).toEqual({
      loadCalls: 1,
      newlyLoadedGroups: ['management'],
      newlyActivatedToolNames: ['skill_search', 'marketplace_search'],
    });
  });

  it('rejects host-managed, unknown, and unavailable groups without leaking tools', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const surface = createToolSurfaceController({
      availableToolNames: ['read_files', 'tool_load'],
      scopedEligible: true,
    });

    const result = surface.load(['context', 'not-real', 'office']);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      ok: false,
      error: 'E_TOOL_GROUP_INVALID',
      unavailable: ['context', 'not-real', 'office'],
    });
    expect(surface.isActive('read_files')).toBe(false);
  });

  it('drops persisted dynamic groups between turns and preserves pre-feature sessions', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const migratedV2States: Array<{ version: number; loadedGroups: string[] }> = [];
    const restored = createToolSurfaceController({
      availableToolNames: ['read_files', 'web_search', 'tool_load'],
      restoredState: {
        version: 2,
        mode: 'scoped',
        loadedGroups: ['web'],
        catalogRevision: '5',
      },
      scopedEligible: true,
      persist: (state) => migratedV2States.push(state),
    });
    expect(restored.mode).toBe('scoped');
    expect(restored.isActive('web_search')).toBe(false);
    expect(migratedV2States).toEqual([expect.objectContaining({
      version: 3,
      loadedGroups: [],
    })]);

    const migratedStates: Array<{ version: number; loadedGroups: string[] }> = [];
    const ambiguousV1 = createToolSurfaceController({
      availableToolNames: ['read_files', 'web_search', 'tool_load'],
      restoredState: {
        version: 1,
        mode: 'scoped',
        loadedGroups: ['workspace.read', 'web'],
        catalogRevision: '1',
      },
      scopedEligible: true,
      persist: (state) => migratedStates.push(state),
    });
    expect(ambiguousV1.mode).toBe('scoped');
    expect(ambiguousV1.isActive('web_search')).toBe(false);
    expect(migratedStates.at(-1)).toMatchObject({ version: 3, loadedGroups: [] });

    const oldSession = createToolSurfaceController({
      availableToolNames: ['read_files', 'web_search'],
      preserveLegacySession: true,
      scopedEligible: true,
    });
    expect(oldSession.mode).toBe('legacy_all');
    expect(oldSession.activeToolNames()).toEqual(['read_files', 'web_search']);
  });

  it('does not rewrite an unchanged v3 marker and clears older alias caches once', () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const states: Array<{ version: number; loadedGroups: string[]; catalogRevision?: string }> = [];
    const restored = createToolSurfaceController({
      availableToolNames: ['library', 'tool_load'],
      restoredState: {
        version: 2,
        mode: 'scoped',
        loadedGroups: ['kb'],
        catalogRevision: '0',
      },
      scopedEligible: true,
      persist: (state) => states.push(state),
    });

    expect(restored.isActive('library')).toBe(false);
    expect(restored.loadedGroups()).toEqual([]);
    expect(states).toEqual([expect.objectContaining({
      version: 3,
      loadedGroups: [],
      catalogRevision: '10',
    })]);

    const unchangedWrites: unknown[] = [];
    createToolSurfaceController({
      availableToolNames: ['library', 'tool_load'],
      restoredState: {
        version: 3,
        mode: 'scoped',
        loadedGroups: [],
        catalogRevision: '10',
      },
      scopedEligible: true,
      persist: (state) => unchangedWrites.push(state),
    });
    expect(unchangedWrites).toEqual([]);
  });

  it('keeps runtime group selection compact without the Agent dependency inventory', () => {
    const block = getLoadableToolGroupsSystemPromptBlock({
      availableToolNames: [
        'read_files', 'write_file', 'create_pdf', 'web_search', 'marketplace_search',
      ],
    });

    expect(block).toContain('`workspace.read`');
    expect(block).toContain('`workspace.write`');
    expect(block).toContain('`office`');
    expect(block).toContain('`web`');
    expect(block).toContain('`management` (runtime only; not an Agent dependency)');
    expect(block).toContain('all clearly needed groups in one call');
    expect(block).toContain('current user turn only');
    expect(block).not.toContain('Tools:');
    expect(block).not.toContain('`read_files`');
    expect(block).not.toContain('`create_pdf`');
    expect(block).not.toContain('`web_search`');
    expect(block).not.toContain('`marketplace_search`');
    expect(block).not.toContain('`media`');
    expect(block).not.toContain('(loaded)');

    expect(getActiveToolGroupsTurnBlock(['workspace.read', 'library'])).toBe([
      '## Active tool groups',
      '',
      'Already active; do not call `tool_load` for these groups: `workspace.read`, `library`.',
    ].join('\n'));
  });

  it('keeps every ancestor visible when only a grandchild group has an available tool', () => {
    const block = getLoadableToolGroupsSystemPromptBlock({
      availableToolNames: ['write_file', 'generate_speech'],
      purpose: 'agent-authoring',
    });

    expect(block).toContain('- `workspace`');
    expect(block).toContain('  - `workspace.write`');
    expect(block).toContain('    - `workspace.write.output`');
    expect(block).not.toContain('`workspace.write.edit`');
    expect(block).not.toContain('`workspace.execute`');
    expect(block).toContain('- `media`');
    expect(block).toContain('  - `media.speech`');
    expect(block).not.toContain('`media.image`');
  });

  it('renders an authoring-only directory without claiming runtime activation', () => {
    const block = getLoadableToolGroupsSystemPromptBlock({
      availableToolNames: [
        'read_files', 'write_file', 'create_pdf', 'web_search', 'marketplace_search',
      ],
      purpose: 'agent-authoring',
    });

    expect(block).toContain('## Agent tool dependencies');
    expect(block).toContain('exact group ids');
    expect(block).toContain('does not change the current session');
    expect(block).toContain('Tools: `read_files`.');
    expect(block).toContain('Tools: `write_file`.');
    expect(block).toContain('Tools: `create_pdf`.');
    expect(block).toContain('Tools: `web_search`.');
    expect(block).not.toContain('marketplace_search');
    expect(block).not.toContain('tool_load');
    expect(block).not.toContain('(loaded)');
    expect(block).not.toContain('`management`');
  });

  it('renders a named-Agent fallback directory with exact tools and no management groups', () => {
    const block = getLoadableToolGroupsSystemPromptBlock({
      availableToolNames: [
        'read_files', 'write_file', 'create_pdf', 'web_search', 'marketplace_search',
      ],
      purpose: 'agent-runtime',
    });

    expect(block).toContain('## Loadable tool groups');
    expect(block).toContain('Fallback only');
    expect(block).toContain('- `workspace.read` — Workspace read. Tools: `read_files`.');
    expect(block).toContain('- `workspace.write.output` — Workspace output. Tools: `write_file`.');
    expect(block).toContain('- `office.pdf` — PDF. Tools: `create_pdf`.');
    expect(block).not.toContain('- `workspace`');
    expect(block).not.toContain('- `workspace.write` —');
    expect(block).not.toContain('- `office` —');
    expect(block).not.toContain('marketplace_search');
    expect(block).not.toContain('`management`');
  });
});
