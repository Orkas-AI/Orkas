import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_FALLBACK_TOOL_GROUP_IDS,
  AGENT_DEPENDENCY_TOOL_GROUP_IDS,
  LOADABLE_TOOL_GROUP_IDS,
  TOOL_CATALOG,
  TOOL_GROUPS,
  canonicalToolGroupId,
  canonicalizeAgentToolGroups,
  canonicalizeToolGroups,
  expandToolGroups,
  invalidAgentToolGroupRefs,
  invalidToolGroupRefs,
  isToolVisibleToAgent,
  toolNamesForAgentGroups,
  toolNamesForGroups,
} from '../../../../src/main/model/core-agent/tool-catalog';
import {
  SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS,
  TOOL_DESCRIPTION_SOFT_BUDGET_CHARS,
  toToolDefinition,
  type AgentTool,
} from '../../../../src/core-agent/src/tools';
import {
  enumerateAllInjectedToolNames,
  enumerateAllInjectedTools,
} from './injected-tool-fixture';
import { createToolSurfaceController } from '../../../../src/main/model/core-agent/tool-surface';
import {
  BUILTIN_AGENT_TOOL_SURFACE_CASES,
} from './builtin-agent-tool-surface-fixture';

const OPEN_SOURCE_DESCRIPTION_BUDGET_EXCEPTIONS = new Set([
  'generate_image:/inputSchema/properties/output_path',
]);

function walkSchemaDescriptions(
  schema: unknown,
  visit: (path: string, description: string) => void,
  path = '/inputSchema',
): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => walkSchemaDescriptions(item, visit, `${path}/${index}`));
    return;
  }
  const obj = schema as Record<string, unknown>;
  if (typeof obj.description === 'string') visit(path, obj.description);
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'description') continue;
    walkSchemaDescriptions(value, visit, `${path}/${escapePointerSegment(key)}`);
  }
}

function descriptionAtPath(schema: unknown, path: string): string | undefined {
  const parts = path
    .replace(/^\/inputSchema/, '')
    .split('/')
    .filter(Boolean);
  let cursor: unknown = schema;
  for (const part of parts) {
    const key = unescapePointerSegment(part);
    if (Array.isArray(cursor)) {
      cursor = cursor[Number(key)];
    } else {
      cursor = (cursor as Record<string, unknown>)?.[key];
    }
  }
  return typeof (cursor as Record<string, unknown> | undefined)?.description === 'string'
    ? ((cursor as Record<string, unknown>).description as string)
    : undefined;
}

function escapePointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointerSegment(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function providerGuidanceText(tool: AgentTool): string {
  const def = toToolDefinition(tool);
  return `${def.description}\n${JSON.stringify(def.inputSchema)}`.toLowerCase();
}

function normalizedDescription(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'description')
      .map(([key, child]) => [key, withoutDescriptions(child)]),
  );
}

function toolByName(name: string): AgentTool {
  const tool = enumerateAllInjectedTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool not enumerated: ${name}`);
  return tool;
}

function propertyDescription(tool: AgentTool, name: string): string {
  const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
    .properties;
  return properties?.[name]?.description ?? '';
}

describe('tool-catalog', () => {
  it('TOOL_CATALOG covers every tool name injected by runner (anti-drift)', () => {
    const injected = enumerateAllInjectedToolNames();
    const catalog = new Set(TOOL_CATALOG.map((e) => e.name));
    const missing = [...injected].filter((n) => !catalog.has(n));
    expect(missing, `Injected tools missing from TOOL_CATALOG: ${missing.join(', ')}`).toEqual([]);
    const stale = [...catalog].filter((n) => !injected.has(n));
    expect(stale, `Catalog tools missing from injected fixture: ${stale.join(', ')}`).toEqual([]);
    expect(catalog.size).toBe(56);
  });

  it('TOOL_CATALOG has no duplicate names', () => {
    const names = TOOL_CATALOG.map((e) => e.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('keeps the group graph and catalog references valid at the architecture boundary', () => {
    const groupIds = TOOL_GROUPS.map((group) => group.id);
    const groupById = new Map(TOOL_GROUPS.map((group) => [group.id, group]));
    const problems: string[] = [];

    if (new Set(groupIds).size !== groupIds.length) problems.push('duplicate group id');
    for (const group of TOOL_GROUPS) {
      if (group.parent && !groupById.has(group.parent)) {
        problems.push(`${group.id}: unknown parent ${group.parent}`);
      }
      if (group.agentDependency && group.activation !== 'loadable') {
        problems.push(`${group.id}: Agent dependency is not loadable`);
      }
      if (group.parent && group.agentDependency && !groupById.get(group.parent)?.agentDependency) {
        problems.push(`${group.id}: Agent dependency has a non-Agent parent`);
      }
      const ancestors = new Set<string>([group.id]);
      let parent = group.parent;
      while (parent) {
        if (ancestors.has(parent)) {
          problems.push(`${group.id}: group cycle through ${parent}`);
          break;
        }
        ancestors.add(parent);
        parent = groupById.get(parent)?.parent;
      }
    }

    for (const entry of TOOL_CATALOG) {
      const groups = entry.loadGroups ?? [];
      if (!groups.length) problems.push(`${entry.name}: no group`);
      if (new Set(groups).size !== groups.length) {
        problems.push(`${entry.name}: duplicate group reference`);
      }
      for (const group of groups) {
        if (!groupById.has(group)) problems.push(`${entry.name}: unknown group ${group}`);
      }
      const owners = Array.isArray(entry.ownerAgent)
        ? entry.ownerAgent
        : entry.ownerAgent ? [entry.ownerAgent] : [];
      for (const owner of owners) {
        if (!/^[0-9a-f]{12}$/.test(owner)) problems.push(`${entry.name}: non-canonical owner ${owner}`);
      }
    }

    const expectedFallbackLeaves = TOOL_GROUPS
      .filter((group) => (
        group.agentDependency
        && !TOOL_GROUPS.some((child) => child.parent === group.id && child.agentDependency)
      ))
      .map((group) => group.id);
    expect(AGENT_FALLBACK_TOOL_GROUP_IDS).toEqual(expectedFallbackLeaves);
    expect(problems).toEqual([]);
  });

  it('every packaged official Agent declares canonical loadable groups', () => {
    const root = path.join(process.cwd(), 'resources', 'builtin', 'marketplace', 'agents');
    const files = fs.readdirSync(root)
      .map((id) => path.join(root, id, 'agent.json'))
      .filter((file) => fs.existsSync(file));
    expect(files).toHaveLength(BUILTIN_AGENT_TOOL_SURFACE_CASES.length);
    const expectedById = new Map(
      BUILTIN_AGENT_TOOL_SURFACE_CASES.map((item) => [item.agentId, item]),
    );
    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        agent_id?: string;
        name?: string;
        tool_list?: unknown;
      };
      const expected = expectedById.get(raw.agent_id ?? '');
      expect(expected, `unexpected packaged Agent ${raw.agent_id ?? raw.name}`).toBeDefined();
      expect(raw.name).toBe(expected?.name);
      expect(Array.isArray(raw.tool_list), `${raw.name} is missing tool_list`).toBe(true);
      const groups = raw.tool_list as unknown[];
      expect(invalidAgentToolGroupRefs(groups), `${raw.name} has invalid groups`).toEqual([]);
      expect(groups.every((value) => typeof value === 'string')).toBe(true);
      expect(groups, `${raw.name} tool_list is not canonical`)
        .toEqual(canonicalizeAgentToolGroups(groups as string[]));
      expect(groups, `${raw.name} must declare its reviewed fixed tool groups`)
        .toEqual(expected?.configuredGroups);
    }
  });

  it('separates runtime-loadable groups from Agent dependency groups', () => {
    expect(LOADABLE_TOOL_GROUP_IDS).toContain('management');
    expect(LOADABLE_TOOL_GROUP_IDS).toEqual(expect.arrayContaining([
      'management.app',
      'management.skills',
      'management.marketplace',
      'management.automation',
    ]));
    expect(AGENT_DEPENDENCY_TOOL_GROUP_IDS).not.toContain('management');
    expect(TOOL_GROUPS.find((group) => group.id === 'management')).toMatchObject({
      activation: 'loadable',
      agentDependency: false,
    });
    expect(TOOL_GROUPS.filter((group) => group.parent === 'management').map((group) => group.id))
      .toEqual([
        'management.app',
        'management.skills',
        'management.marketplace',
        'management.automation',
      ]);
    expect(TOOL_GROUPS.filter((group) => group.parent === 'management'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ activation: 'loadable', agentDependency: false }),
      ]));
    expect(invalidToolGroupRefs(['management'])).toEqual([]);
    expect(canonicalizeToolGroups(['management'])).toEqual(['management']);
    expect(invalidAgentToolGroupRefs(['management'])).toEqual(['management']);
    expect(canonicalizeAgentToolGroups(['management'])).toEqual([]);

    expect(TOOL_CATALOG.find((entry) => entry.name === 'skill_manage')?.loadGroups)
      .toEqual(['runtime']);
    expect(TOOL_CATALOG.find((entry) => entry.name === 'add_custom_connector'))
      .toMatchObject({ loadGroups: ['connectors'], agentAssignable: false });
    expect(toolNamesForGroups(['connectors'])).toEqual([
      'list_connector_tools', 'call_connector_tool', 'add_custom_connector',
    ]);
    expect(toolNamesForAgentGroups(['connectors'])).toEqual([
      'list_connector_tools', 'call_connector_tool',
    ]);
    expect(isToolVisibleToAgent('add_custom_connector', 'custom-agent')).toBe(false);
    expect(toolNamesForGroups(['management.skills'])).toEqual([
      'skill_search', 'import_skill_package',
    ]);
    expect(toolNamesForGroups(['management.marketplace'])).toEqual([
      'marketplace_search', 'marketplace_request_install',
    ]);
    expect(toolNamesForGroups(['management.automation'])).toEqual(['auto_tasks_list']);
    expect(toolNamesForGroups(['management.app'])).toEqual(['open_app_view', 'app_health']);
    // Keep the broad parent as an explicit compatibility alias while new
    // runtime calls can load only the focused child they need.
    expect(expandToolGroups(['management'])).toEqual([
      'management',
      'management.app',
      'management.skills',
      'management.marketplace',
      'management.automation',
    ]);
    expect(toolNamesForGroups(['management'])).toEqual([
      'skill_search',
      'import_skill_package',
      'marketplace_search',
      'marketplace_request_install',
      'auto_tasks_list',
      'open_app_view',
      'app_health',
    ]);
  });

  it('scopes Office leaves while preserving the parent and pdf alias', () => {
    expect(TOOL_GROUPS.filter((group) => group.parent === 'office').map((group) => group.id))
      .toEqual(['office.word', 'office.spreadsheet', 'office.presentation', 'office.pdf']);
    expect(canonicalToolGroupId('pdf')).toBe('office.pdf');
    expect(canonicalizeAgentToolGroups(['office', 'office.word'])).toEqual(['office']);

    expect(toolNamesForGroups(['office.presentation'])).toEqual([
      'create_pptx', 'office_read', 'edit_office', 'office_review',
    ]);
    expect(toolNamesForGroups(['pdf'])).toEqual(['create_pdf', 'edit_pdf', 'pdf_render']);
    expect(toolNamesForGroups(['office'])).toEqual([
      'create_pdf', 'edit_pdf', 'pdf_render',
      'create_docx', 'create_xlsx', 'create_pptx',
      'office_read', 'edit_office', 'office_review',
    ]);
  });

  it('splits output, editing, command, session, and media capabilities without weakening parent compatibility', () => {
    expect(toolNamesForGroups(['workspace.write.output'])).toEqual([
      'write_file', 'append_file', 'publish_outputs',
    ]);
    expect(toolNamesForGroups(['workspace.write.edit'])).toEqual([
      'apply_patch', 'edit_file', 'delete_file', 'workspace_diff',
    ]);
    expect(toolNamesForGroups(['workspace.write'])).toEqual([
      'write_file', 'append_file', 'publish_outputs',
      'apply_patch', 'edit_file', 'delete_file', 'workspace_diff',
    ]);
    expect(toolNamesForGroups(['workspace.execute.command'])).toEqual(['bash']);
    expect(toolNamesForGroups(['workspace.execute.session'])).toEqual([
      'process_session', 'interactive_cli',
    ]);
    expect(toolNamesForGroups(['workspace.execute'])).toEqual([
      'bash', 'process_session', 'interactive_cli',
    ]);
    expect(toolNamesForGroups(['media.image'])).toEqual(['generate_image', 'image_studio']);
    expect(toolNamesForGroups(['media.video'])).toEqual(['generate_video', 'video_studio']);
    expect(toolNamesForGroups(['media.speech'])).toEqual(['generate_speech']);
    expect(toolNamesForGroups(['media'])).toEqual([
      'generate_image', 'image_studio', 'generate_video', 'video_studio', 'generate_speech',
    ]);

    expect(expandToolGroups(['workspace'])).toEqual([
      'workspace',
      'workspace.read',
      'workspace.write',
      'workspace.write.output',
      'workspace.write.edit',
      'workspace.execute',
      'workspace.execute.command',
      'workspace.execute.session',
      'workspace.artifact',
    ]);
    expect(canonicalizeAgentToolGroups([
      'workspace', 'workspace.write.output', 'workspace.execute.command',
    ])).toEqual(['workspace']);
  });

  it('enforces each built-in Agent fixed capability boundary', () => {
    const previousMode = process.env.ORKAS_TOOL_LOADING_MODE;
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    try {
      for (const scenario of BUILTIN_AGENT_TOOL_SURFACE_CASES) {
        const availableToolNames = TOOL_CATALOG
          .map((entry) => entry.name)
          .filter((name) => isToolVisibleToAgent(name, scenario.agentId));
        const surface = createToolSurfaceController({
          availableToolNames,
          configuredGroups: scenario.configuredGroups,
          hostRequiredToolNames: ['read_files'],
          scopedEligible: true,
          dynamicLoading: false,
        });

        expect(surface.isActive('read_files'), `${scenario.name} must retain the host read primitive`)
          .toBe(true);
        for (const name of scenario.requiredTools) {
          expect(surface.isActive(name), `${scenario.name} required tool ${name} is unavailable`)
            .toBe(true);
        }
        for (const name of scenario.forbiddenTools) {
          expect(surface.isActive(name), `${scenario.name} crossed its fixed boundary with ${name}`)
            .toBe(false);
        }

        expect(surface.isActive('image_studio'), `${scenario.name} crossed the ImageStudio owner gate`)
          .toBe(scenario.agentId === '814b61b027f0');
        expect(surface.isActive('video_studio'), `${scenario.name} crossed the VideoStudio owner gate`)
          .toBe(scenario.agentId === '79df9cc89f5f');

        expect(
          scenario.groupRequirements.map((requirement) => requirement.group),
          `${scenario.name} must justify every configured group with a user outcome`,
        ).toEqual(scenario.configuredGroups);
        for (const requirement of scenario.groupRequirements) {
          expect(requirement.outcome.trim().length, `${scenario.name}:${requirement.group} lacks an outcome`)
            .toBeGreaterThan(0);
          const withoutGroup = createToolSurfaceController({
            availableToolNames,
            configuredGroups: scenario.configuredGroups.filter((group) => group !== requirement.group),
            hostRequiredToolNames: ['read_files'],
            scopedEligible: true,
            dynamicLoading: false,
          });
          for (const witness of requirement.witnessTools) {
            expect(surface.isActive(witness), `${scenario.name}:${requirement.group} witness ${witness} is missing`)
              .toBe(true);
            expect(
              withoutGroup.isActive(witness),
              `${scenario.name}:${requirement.group} is redundant; ${witness} survives its removal`,
            ).toBe(false);
          }
        }

        for (const mutation of scenario.overbroadReplacements ?? []) {
          expect(
            surface.isActive(mutation.newlyExposedTool),
            `${scenario.name} narrow baseline already exposes ${mutation.newlyExposedTool}`,
          ).toBe(false);
          const widened = createToolSurfaceController({
            availableToolNames,
            configuredGroups: scenario.configuredGroups.map((group) => (
              group === mutation.narrowGroup ? mutation.broadGroup : group
            )),
            hostRequiredToolNames: ['read_files'],
            scopedEligible: true,
            dynamicLoading: false,
          });
          expect(
            widened.isActive(mutation.newlyExposedTool),
            `${scenario.name} negative mutation did not expose ${mutation.newlyExposedTool}`,
          ).toBe(true);
        }
      }
    } finally {
      if (previousMode === undefined) delete process.env.ORKAS_TOOL_LOADING_MODE;
      else process.env.ORKAS_TOOL_LOADING_MODE = previousMode;
    }
  });

  it('describes edit_office preview rendering as explicit and optional', () => {
    const summary = TOOL_CATALOG.find((entry) => entry.name === 'edit_office')?.summary ?? '';
    expect(summary).toContain('optionally returns');
    expect(summary).toContain('preview:true');
    expect(summary).not.toContain('returns a PNG preview');
  });

  it('provider tool definitions preserve descriptions without a hard length cap', () => {
    const lost: string[] = [];
    for (const tool of enumerateAllInjectedTools()) {
      const def = toToolDefinition(tool);
      expect(def.description).toBe(normalizedDescription(tool.description));
      walkSchemaDescriptions(tool.inputSchema, (path, description) => {
        if (!description.trim()) return;
        const providerDescription = descriptionAtPath(def.inputSchema, path);
        if (!providerDescription?.trim()) lost.push(`${tool.name}:${path}`);
        expect(providerDescription).toBe(normalizedDescription(description));
      });
    }
    expect(lost).toEqual([]);
  });

  it('pins non-description schemas independently from wording changes', () => {
    const schemas = enumerateAllInjectedTools()
      .map((tool) => ({ name: tool.name, inputSchema: withoutDescriptions(tool.inputSchema) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(schemas))
      .digest('hex');
    expect(
      fingerprint,
      'A model-visible field, enum, bound, default, or required rule changed; review it as a schema change, not description cleanup.',
    // Reviewed 168 parity additions: image URL/role/negative-prompt inputs and
    // ImageStudio/VideoStudio production transaction identifiers. Existing
    // required inputs and tool visibility remain unchanged.
    ).toBe('68660ba57a038f6c2ad728e822af5ae70abe13d2b1410a9e8a5d2443b84ed05e');
  });

  it('keeps the reviewed stable tool corpus within the description budgets', () => {
    const overBudget: string[] = [];
    for (const tool of enumerateAllInjectedTools()) {
      if (normalizedDescription(tool.description).length > TOOL_DESCRIPTION_SOFT_BUDGET_CHARS) {
        overBudget.push(`${tool.name}:description=${tool.description.length}`);
      }
      walkSchemaDescriptions(tool.inputSchema, (path, description) => {
        if (
          normalizedDescription(description).length > SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS
          && !OPEN_SOURCE_DESCRIPTION_BUDGET_EXCEPTIONS.has(`${tool.name}:${path}`)
        ) {
          overBudget.push(`${tool.name}:${path}.description=${description.length}`);
        }
      });
    }
    expect(
      overBudget,
      `Descriptions above the ${TOOL_DESCRIPTION_SOFT_BUDGET_CHARS}/${SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS}-character review budgets need a documented exception.`,
    ).toEqual([]);
  });

  it('keeps operation and argument semantics on their owning parameters', () => {
    const patchTool = toolByName('apply_patch');
    expect(patchTool.description).not.toContain('*** Add File');
    expect(propertyDescription(patchTool, 'patch')).toContain('*** Add File');
    expect(propertyDescription(patchTool, 'patch')).toContain('*** Begin Patch');

    const append = toolByName('append_file');
    expect(append.description).not.toContain('base_revision');
    expect(propertyDescription(append, 'base_revision')).toContain('Required unless legacy expected_size');
    expect(propertyDescription(append, 'base_revision')).toContain('exact replay is idempotent');

    const edit = toolByName('edit_file');
    expect(edit.description).not.toContain('old_string');
    expect(propertyDescription(edit, 'old_string')).toContain('trailing-whitespace-insensitive');
    expect(propertyDescription(edit, 'expected_hash')).toContain('fails without writing');

    const diff = toolByName('workspace_diff');
    expect(diff.description).not.toContain('Defaults to');
    expect(propertyDescription(diff, 'scope')).toContain('(default)');
    expect(propertyDescription(diff, 'format')).toContain('(default)');

    const outputs = toolByName('publish_outputs');
    expect(outputs.description).not.toContain('Exclude previews');
    expect(propertyDescription(outputs, 'paths')).toContain('Exclude previews');
    expect(propertyDescription(outputs, 'paths')).toContain('replaces the prior declaration');

    const artifact = toolByName('create_artifact');
    expect(artifact.description).toMatch(/Remote and out-of-directory URLs are blocked/i);
    expect(artifact.description).toMatch(/bundle authorized assets in files or use data\/blob URLs/i);
    expect(artifact.description).not.toContain('top-level index.html');
    expect(propertyDescription(artifact, 'files')).toContain('top-level index.html');
    expect(propertyDescription(artifact, 'files')).toContain('__orkas/bridge.js');

    const html = toolByName('html_preview');
    expect(html.description).not.toContain('Use target');
    expect(propertyDescription(html, 'target')).toContain('Defaults to desktop');
    expect(propertyDescription(html, 'screenshots')).toContain('Defaults to false');

    const image = toolByName('generate_image');
    expect(image.description).not.toContain('reference images');
    expect(propertyDescription(image, 'reference_images')).toContain('editing/variations');

    const speech = toolByName('generate_speech');
    expect(speech.description).not.toContain('target_duration');
    expect(speech.description).not.toContain('output_path');
    expect(propertyDescription(speech, 'target_duration')).toContain('Required for timed media');
    expect(propertyDescription(speech, 'output_path')).toContain('once per turn');

    const pdf = toolByName('create_pdf');
    expect(pdf.description).not.toContain('ordinary prose');
    expect(pdf.description).toMatch(/if it fails, report the failure/i);
    expect(pdf.description).toContain('reportlab');
    expect(pdf.description).toMatch(/CJK\/font behavior/i);
    expect(propertyDescription(pdf, 'source_type')).toContain('ordinary prose');

    const editPdf = toolByName('edit_pdf');
    expect(editPdf.description).not.toContain('page numbers are 1-based');
    expect(propertyDescription(editPdf, 'pages')).toContain('1-based pages');

    const renderPdf = toolByName('pdf_render');
    expect(renderPdf.description).not.toContain('1-based PDF page');
    expect(propertyDescription(renderPdf, 'page')).toContain('1-based page number');

    const memory = toolByName('cross_session_memory');
    expect(memory.description).not.toContain('entries are already injected');
    expect(propertyDescription(memory, 'action')).toContain('entries are already injected');

    const metacognition = toolByName('metacognition');
    expect(metacognition.description).not.toMatch(/\d+ characters/);
    expect(propertyDescription(metacognition, 'content')).toContain('Maximum 3000 characters');

    const officeRead = toolByName('office_read');
    expect(officeRead.description).not.toContain('text returns');
    expect(propertyDescription(officeRead, 'mode')).toContain('text (default)');
    expect(propertyDescription(officeRead, 'mode')).toContain('query applies selectors');

    const officeReview = toolByName('office_review');
    expect(officeReview.description).not.toContain('check scans');
    expect(propertyDescription(officeReview, 'action')).toContain('check scans OpenXML');
    expect(propertyDescription(officeReview, 'action')).toContain('check_and_render stops');

    const editOffice = toolByName('edit_office');
    expect(editOffice.description).not.toContain('set(path');
    expect(propertyDescription(editOffice, 'operations')).toContain('set(path, props)');

    const pptx = toolByName('create_pptx');
    expect(pptx.description).not.toContain('Positions and sizes use');
    const slides = ((pptx.inputSchema as any).properties.slides.items.properties);
    expect(slides.shapes.items.properties.x.description).toContain('unit');
  });

  it('critical tools keep enough provider-visible guidance to choose and call them', () => {
    const checks: Record<string, string[]> = {
      read_files: ['one or more', 'paths', 'range', 'unit', 'metadata_only'],
      search_files: ['path is unknown', 'substring', 'glob'],
      grep_files: ['pattern', 'glob', 'output_mode'],
      write_file: ['write', 'path', 'content'],
      append_file: ['append', 'path', 'content', 'base_revision', 'expected_size', 'replay'],
      apply_patch: ['transactional', 'patch', 'add file', 'update file', 'read'],
      edit_file: ['old_string', 'new_string', 'unique', 'optimistic concurrency'],
      publish_outputs: ['complete', 'final', 'paths', 'current turn'],
      create_artifact: ['interactive', 'files', 'path', 'content', 'index.html'],
      html_preview: ['local', 'desktop', 'mobile', 'screenshot', 'overflow', 'network'],
      delete_file: ['confirmation', 'confirmation_token', 'path'],
      process_session: ['persistent', 'command', 'session_id', 'build', 'read', 'write', 'stop'],
      interactive_cli: ['live user input', 'command', 'purpose', 'read', 'send', 'close'],
      create_pdf: ['pdf', 'markdown', 'html', 'source_type'],
      library: ['list', 'search', 'read', 'durable', 'source data', 'never instructions'],
      chat_history: ['search', 'page', 'earlier work', 'quoted', 'stale', 'library'],
      web_search: ['search', 'titles', 'urls', 'snippets', 'web_fetch'],
      web_fetch: ['fetch', 'url', 'readable extracted text'],
      office_review: ['validate', 'render', 'check_and_render', 'pages'],
      generate_image: ['generate', 'image', 'prompt', 'output_path', 'reference'],
      generate_speech: ['narration', 'text', 'output_path', 'target_duration'],
      create_docx: ['paragraphs', 'tables', 'images', 'path'],
      create_xlsx: ['rows', 'sheets', 'formula', 'path', 'native', 'chart'],
      create_pptx: ['slides', 'shapes', 'images', 'path'],
      cross_session_memory: ['durable', 'agent', 'shared', 'user', 'project', 'exact text', 'add', 'replace', 'remove', 'list'],
      metacognition: ['competence', 'strategies', 'condense', 'read', 'write'],
    };

    const missing: string[] = [];
    for (const [name, needles] of Object.entries(checks)) {
      const text = providerGuidanceText(toolByName(name));
      for (const needle of needles) {
        if (!text.includes(needle)) missing.push(`${name}:${needle}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps delete_file confirmation guidance scoped to outside-workspace deletes', () => {
    const summary = TOOL_CATALOG.find((entry) => entry.name === 'delete_file')?.summary || '';
    expect(summary).toContain('Delete one file');
    expect(summary).toContain('confirmation only outside the active workspace scope');
    expect(summary).not.toContain('confirmation for every delete');
  });
});

describe('isToolVisibleToAgent (ownerAgent gate)', () => {
  it('un-owned catalog tools are visible to every actor', () => {
    expect(isToolVisibleToAgent('read_files', '')).toBe(true);
    expect(isToolVisibleToAgent('generate_speech', '')).toBe(true);
    expect(isToolVisibleToAgent('generate_speech', 'video-studio')).toBe(true);
    expect(isToolVisibleToAgent('generate_speech', 'some-other-agent')).toBe(true);
  });

  it('tools absent from the catalog (extraTools / builtins) are never gated', () => {
    // commander dispatch tools + core-agent builtins aren't catalog entries
    expect(isToolVisibleToAgent('dispatch_to', '')).toBe(true);
    expect(isToolVisibleToAgent('run_worker', 'video-studio')).toBe(true);
  });

  it('keeps image_studio private to the built-in ImageStudio agent', () => {
    expect(isToolVisibleToAgent('image_studio', '814b61b027f0')).toBe(true);
    expect(isToolVisibleToAgent('image_studio', '')).toBe(false);
    expect(isToolVisibleToAgent('image_studio', '79df9cc89f5f')).toBe(false);
    expect(isToolVisibleToAgent('video_studio', '814b61b027f0')).toBe(false);
  });
});
