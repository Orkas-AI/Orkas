import { describe, expect, it } from 'vitest';
import * as os from 'node:os';

import {
  TOOL_CATALOG,
  getLoadableToolGroupsSystemPromptBlock,
  isToolVisibleToAgent,
} from '../../../src/main/model/core-agent/tool-catalog';
import {
  createToolLoadTool,
  createToolSurfaceController,
} from '../../../src/main/model/core-agent/tool-surface';
import {
  toToolDefinition,
  type AgentTool,
} from '../../../src/core-agent/src/tools';
import { BUILTIN_AGENT_TOOL_SURFACE_CASES } from '../model/core-agent/builtin-agent-tool-surface-fixture';
import { enumerateAllInjectedTools } from '../model/core-agent/injected-tool-fixture';
import { createToolResultTools } from '../../../src/main/model/core-agent/tool-result-tools';

/**
 * The tool block is the largest fixed cost in every request, and nothing owned
 * its size.
 *
 * Skill bodies have had a budget gate since 2026-08-07
 * (`skill-inline-budget.test.ts`); tool definitions never did. Measured on
 * 2026-08-11 against the eight professional-agent E2E runs of 08-09
 * (`approxBodyBytes` at `msgCount=1` minus `resolved_system_prompt_chars`):
 * 85,014 / 85,014 / 85,061 / 84,957 / 89,779 / 85,073 / 85,049 / 85,249 chars.
 * Every agent paid the same ~85K — roughly 21K tokens, about TWICE the system
 * prompt — on every single request, and the 4,730-char spread on ImageStudio
 * is exactly its owner-scoped `image_studio` tool.
 *
 * A tool definition is not free text: before the Office schema review,
 * `create_xlsx` alone serialized to over 10,000 characters, mostly inputSchema,
 * and `create_xlsx` + `create_pptx` were ~23% of the whole surface. Growth here is invisible —
 * there is no spill, no warning, and no failing test; the only symptom is a
 * larger bill and a smaller usable window on every turn, for every agent.
 *
 * This gate does not judge which agent should see which tool — that is a
 * capability decision governed by
 * `docs/architecture/builtin-agent-native-dependency-policy.md`. It only makes
 * the total visible and stops it drifting up unnoticed.
 */

/** Serialized size of one tool exactly as it rides in the request body. */
function definitionChars(tool: AgentTool): number {
  return JSON.stringify(toToolDefinition(tool)).length;
}

/**
 * Ceiling for the assembled surface. Reset after the 2026-08-16 Office review
 * (64,871 chars over the pre-merge 39-tool enumeration path) plus ~8% headroom, so
 * ordinary wording edits pass and a new heavyweight schema does not land
 * unnoticed. Raising it is a deliberate act that belongs in review with the
 * reason, exactly like the skill budget.
 */
const TOOL_SURFACE_BUDGET_CHARS = 70_000;

/** No single tool may dominate; the current largest reviewed schema is the
 *  7,161-char create_pptx definition. */
const SINGLE_TOOL_BUDGET_CHARS = 8_000;
const CONSOLIDATED_RETRIEVAL_BUDGET_CHARS = 4_000;
/** `tool_result` is host-required in every non-reflection request. Measured 5,276
 *  chars on 2026-09-08 after collapsing the four per-action copies of the request
 *  schema into one `requests.items` union (was 7,181); ~4% headroom. */
const TOOL_RESULT_BUDGET_CHARS = 5_500;
/** Re-pinned on 2026-08-24 after the reviewed XLSX edit contract exposed A1
 * paths and the reusable cell value/style schema through `edit_office`.
 * The whole surface and every built-in Agent remain below their own caps. */
const OFFICE_GROUP_BUDGET_CHARS = 23_000;
const OFFICE_HEAVY_TOOL_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  create_xlsx: 5_600,
  create_pptx: 7_500,
});

/** Named-Agent fallback discovery is part of every stable prompt, so it gets
 * a separate byte gate from the deferred tool schemas. */
const AGENT_FALLBACK_DIRECTORY_BUDGET_CHARS = 1_900;
/** Commander discovery includes deferred names and purposes, not full schemas.
 * The maximal catalog fixture is separate from the common injection corpus. */
// The retained public video description adds six characters ("short ")
// to the shared directory. Keep the shared ceiling and account for this exact delta.
const COMMANDER_DIRECTORY_BUDGET_CHARS = 4_500 + 6;
const COMMANDER_COMMON_INITIAL_BUDGET_CHARS = 19_000;
// The approved shared browser adds one initially active definition, including
// task-turn retention. Keep its cost separate so the existing corpus cannot grow.
const BROWSER_DEFINITION_BUDGET_CHARS = 3_000;

/**
 * Per-Agent ceilings for the stable common injection corpus. Built-in Agents
 * start with fixed authored capability surfaces plus one compact tool_load
 * fallback schema; deferred groups do not contribute until loaded.
 * Actor-/project-specific host tools keep their own contract tests; this gate
 * owns the schema cost controlled by the built-in Agent preload decision.
 * Each ceiling includes modest wording headroom over the 2026-08-14 scoped
 * measurement, while making a new parent group or heavyweight Office schema a
 * reviewed budget change instead of silent request growth.
 */
const BUILTIN_AGENT_INITIAL_SURFACE_BUDGETS: Readonly<Record<
  string,
  { tools: number; chars: number }
>> = Object.freeze({
  ContentWriter: { tools: 22, chars: 25_000 },
  DeepResearcher: { tools: 24, chars: 25_000 },
  VideoStudio: { tools: 25, chars: 32_000 },
  PptMaker: { tools: 16, chars: 25_000 },
  ImageStudio: { tools: 20, chars: 31_000 },
  OfficeWorker: { tools: 21, chars: 36_000 },
  ProductDeveloper: { tools: 25, chars: 27_000 },
  UIDesigner: { tools: 25, chars: 27_000 },
  SeoGeoAgent: { tools: 24, chars: 25_000 },
});

describe('injected tool surface budget', () => {
  const tools = enumerateAllInjectedTools();

  it('bounds Commander deferred discovery and its combined initial common-corpus surface', () => {
    const previousMode = process.env.ORKAS_TOOL_LOADING_MODE;
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    try {
      const availableToolNames = TOOL_CATALOG
        .filter((entry) => isToolVisibleToAgent(entry.name, ''))
        .map((entry) => entry.name);
      const surface = createToolSurfaceController({
        availableToolNames,
        hostPreloadGroups: ['workspace.read', 'workspace.execute.command', 'web'],
        hostRequiredToolNames: ['open_app_view', 'publish_outputs'],
        scopedEligible: true,
      });
      const directory = getLoadableToolGroupsSystemPromptBlock({
        availableToolNames,
        initialActiveToolNames: surface.activeToolNames(),
        allowedGroupIds: surface.loadableGroups(),
      });
      expect(directory).toContain('`create_pptx` —');
      expect(directory).toContain('`marketplace_search` —');
      expect(directory).not.toContain('`image_studio`');
      expect(directory).not.toContain('`bash`');
      expect(directory.length).toBeLessThanOrEqual(COMMANDER_DIRECTORY_BUDGET_CHARS);

      const commonTools = tools.filter((tool) => isToolVisibleToAgent(tool.name, ''));
      const commonSurface = createToolSurfaceController({
        availableToolNames: [...commonTools.map((tool) => tool.name), 'tool_load'],
        hostPreloadGroups: ['workspace.read', 'workspace.execute.command', 'web'],
        hostRequiredToolNames: ['publish_outputs'],
        scopedEligible: true,
      });
      const commonDirectory = getLoadableToolGroupsSystemPromptBlock({
        availableToolNames: commonTools.map((tool) => tool.name),
        initialActiveToolNames: commonSurface.activeToolNames(),
        allowedGroupIds: commonSurface.loadableGroups(),
      });
      const schemaChars = [
        ...commonTools.filter((tool) => commonSurface.isActive(tool.name)),
        createToolLoadTool(commonSurface),
      ].reduce((sum, tool) => sum + definitionChars(tool), 0);
      const browserChars = definitionChars(commonTools.find(tool => tool.name === 'browser')!);
      expect(browserChars).toBeLessThanOrEqual(BROWSER_DEFINITION_BUDGET_CHARS);
      expect(commonDirectory.length + schemaChars)
        .toBeLessThanOrEqual(COMMANDER_COMMON_INITIAL_BUDGET_CHARS + BROWSER_DEFINITION_BUDGET_CHARS);
      expect(commonDirectory.length + schemaChars - browserChars)
        .toBeLessThanOrEqual(COMMANDER_COMMON_INITIAL_BUDGET_CHARS);
      // eslint-disable-next-line no-console
      console.log(`[tool-surface:commander] max_directory=${directory.length} common_directory=${commonDirectory.length} common_initial_schemas=${schemaChars}`);
    } finally {
      if (previousMode === undefined) delete process.env.ORKAS_TOOL_LOADING_MODE;
      else process.env.ORKAS_TOOL_LOADING_MODE = previousMode;
    }
  });

  it('keeps the named-Agent fallback directory compact and leaf-scoped', () => {
    const block = getLoadableToolGroupsSystemPromptBlock({
      availableToolNames: TOOL_CATALOG
        .filter((entry) => entry.agentAssignable !== false)
        .map((entry) => entry.name),
      purpose: 'agent-runtime',
    });

    expect(block.length).toBeLessThanOrEqual(AGENT_FALLBACK_DIRECTORY_BUDGET_CHARS);
    expect(block).toContain('`workspace.write.output`');
    expect(block).not.toContain('- `workspace` —');
    expect(block).not.toContain('- `office` —');
    expect(block).not.toContain('- `media` —');
  });

  it('finds the injected tool corpus', () => {
    // A silent empty/short corpus would make every assertion below vacuous:
    // a factory signature change that returns [] must fail here, not pass
    // quietly with a 0-char surface.
    // The merged surface includes the 1.7 additions and the 1.6.6 retirement
    // of the duplicate read_file/stat_file tools.
    expect(tools).toHaveLength(39);
    expect(tools.some((tool) => tool.name === 'browser')).toBe(true);
    expect(tools.some((tool) => tool.name === 'create_xlsx')).toBe(true);
    expect(tools.some((tool) => tool.name === 'read_files')).toBe(true);
  });

  it('keeps Library and conversation history consolidated into two bounded schemas', () => {
    const retrievalTools = tools.filter(
      (tool) => tool.name === 'library' || tool.name === 'chat_history',
    );
    expect(retrievalTools.map((tool) => tool.name).sort())
      .toEqual(['chat_history', 'library']);
    expect(tools.some((tool) => [
      'kb_list', 'kb_search', 'kb_read', 'chat_search', 'chat_read',
    ].includes(tool.name))).toBe(false);

    const chars = retrievalTools.reduce((sum, tool) => sum + definitionChars(tool), 0);
    expect(
      chars,
      `consolidated Library/history definitions total ${chars} chars; budget ${CONSOLIDATED_RETRIEVAL_BUDGET_CHARS}`,
    ).toBeLessThanOrEqual(CONSOLIDATED_RETRIEVAL_BUDGET_CHARS);
  });

  it('keeps the host-required tool_result definition compact', () => {
    // Host-required, so it is not part of the enumerated allowlist surface.
    const [toolResult] = createToolResultTools({ toolResultsDir: os.tmpdir() } as any);
    const chars = definitionChars(toolResult);
    expect(
      chars,
      `tool_result definition is ${chars} chars; budget ${TOOL_RESULT_BUDGET_CHARS} — it is sent on every model request`,
    ).toBeLessThanOrEqual(TOOL_RESULT_BUDGET_CHARS);
  });

  it('keeps the whole injected tool surface under budget', () => {
    const total = tools.reduce((sum, tool) => sum + definitionChars(tool), 0);
    expect(
      total,
      `injected tool definitions total ${total} chars (budget ${TOOL_SURFACE_BUDGET_CHARS}); `
      + 'this rides in EVERY request for EVERY agent — trim a schema or scope the tool, '
      + 'do not raise the budget without recording why',
    ).toBeLessThanOrEqual(TOOL_SURFACE_BUDGET_CHARS);
  });

  it('keeps any single tool definition under budget', () => {
    const oversized = tools
      .map((tool) => ({ name: tool.name, chars: definitionChars(tool) }))
      .filter((row) => row.chars > SINGLE_TOOL_BUDGET_CHARS)
      .map((row) => `${row.name}: ${row.chars} chars (budget ${SINGLE_TOOL_BUDGET_CHARS})`);

    expect(oversized, 'one tool must not dominate the shared surface').toEqual([]);
  });

  it('keeps the reviewed Office schemas within their group and heavy-tool budgets', () => {
    const officeNames = new Set(
      TOOL_CATALOG
        .filter((entry) => entry.loadGroups?.some((group) => group.startsWith('office.')))
        .map((entry) => entry.name),
    );
    const officeTools = tools.filter((tool) => officeNames.has(tool.name));
    const chars = officeTools.reduce((sum, tool) => sum + definitionChars(tool), 0);

    expect(officeTools).toHaveLength(9);
    expect(
      chars,
      `Office definitions total ${chars} chars; budget ${OFFICE_GROUP_BUDGET_CHARS}`,
    ).toBeLessThanOrEqual(OFFICE_GROUP_BUDGET_CHARS);
    for (const [name, budget] of Object.entries(OFFICE_HEAVY_TOOL_BUDGETS)) {
      const tool = officeTools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`missing reviewed Office tool ${name}`);
      expect(
        definitionChars(tool),
        `${name} exceeds its reviewed ${budget}-char schema budget`,
      ).toBeLessThanOrEqual(budget);
    }
  });

  it('keeps each built-in Agent initial schema surface within budget', () => {
    const previousMode = process.env.ORKAS_TOOL_LOADING_MODE;
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const measurements: string[] = [];
    try {
      for (const scenario of BUILTIN_AGENT_TOOL_SURFACE_CASES) {
        const availableTools = tools.filter((tool) =>
          isToolVisibleToAgent(tool.name, scenario.agentId),
        );
        const surface = createToolSurfaceController({
          availableToolNames: [...availableTools.map((tool) => tool.name), 'tool_load'],
          configuredGroups: scenario.configuredGroups,
          hostRequiredToolNames: ['read_files'],
          scopedEligible: true,
          dynamicLoading: true,
          dynamicLoadPolicy: 'agent-dependency',
          allowLegacyAll: false,
        });
        const initialTools = [
          ...availableTools.filter((tool) => surface.isActive(tool.name)),
          createToolLoadTool(surface),
        ];
        const chars = initialTools.reduce((sum, tool) => sum + definitionChars(tool), 0);
        const budget = BUILTIN_AGENT_INITIAL_SURFACE_BUDGETS[scenario.name];

        if (!budget) throw new Error(`${scenario.name} is missing an initial schema budget`);
        expect(
          initialTools.length,
          `${scenario.name} sends ${initialTools.length} common-corpus schemas; budget ${budget.tools}`,
        ).toBeLessThanOrEqual(budget.tools);
        expect(
          chars,
          `${scenario.name} sends ${chars} common-corpus schema chars; budget ${budget.chars}`,
        ).toBeLessThanOrEqual(budget.chars);
        measurements.push(`${scenario.name}=${initialTools.length}/${chars}`);
      }
    } finally {
      if (previousMode === undefined) delete process.env.ORKAS_TOOL_LOADING_MODE;
      else process.env.ORKAS_TOOL_LOADING_MODE = previousMode;
    }

    // eslint-disable-next-line no-console
    console.log(`[tool-surface:builtins] tools/chars ${measurements.join(' ')}`);
  });

  it('detects an unnecessary parent-workspace expansion for ContentWriter', () => {
    const previousMode = process.env.ORKAS_TOOL_LOADING_MODE;
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    try {
      const scenario = BUILTIN_AGENT_TOOL_SURFACE_CASES.find(
        (item) => item.name === 'ContentWriter',
      );
      if (!scenario) throw new Error('ContentWriter tool-surface case is missing');
      const availableTools = tools.filter((tool) =>
        isToolVisibleToAgent(tool.name, scenario.agentId),
      );
      const regressed = createToolSurfaceController({
        availableToolNames: availableTools.map((tool) => tool.name),
        configuredGroups: ['workspace', 'web'],
        hostRequiredToolNames: ['read_files'],
        scopedEligible: true,
        dynamicLoading: false,
      });
      const regressedCount = availableTools.filter((tool) => regressed.isActive(tool.name)).length;

      expect(regressedCount).toBeGreaterThan(BUILTIN_AGENT_INITIAL_SURFACE_BUDGETS.ContentWriter.tools);
    } finally {
      if (previousMode === undefined) delete process.env.ORKAS_TOOL_LOADING_MODE;
      else process.env.ORKAS_TOOL_LOADING_MODE = previousMode;
    }
  });

  it('reports the largest tools and groups', () => {
    // Not a failure condition — the visible ranking the next person adding a
    // schema field needs, and the per-group split that any scoping proposal
    // has to argue against. Office is aggregated here even though runtime
    // loading now uses format-specific leaves.
    const groupOf = new Map(TOOL_CATALOG.map((entry) => {
      const first = entry.loadGroups?.[0];
      return [
        entry.name,
        first?.startsWith('workspace.')
          ? 'workspace'
          : first?.startsWith('office.')
            ? 'office'
            : first,
      ];
    }));
    const rows = tools
      .map((tool) => ({
        name: tool.name,
        group: groupOf.get(tool.name) ?? '(uncatalogued)',
        chars: definitionChars(tool),
      }))
      .sort((left, right) => right.chars - left.chars);

    const byGroup = new Map<string, number>();
    for (const row of rows) byGroup.set(row.group, (byGroup.get(row.group) ?? 0) + row.chars);

    const total = rows.reduce((sum, row) => sum + row.chars, 0);
    // eslint-disable-next-line no-console
    console.log(
      `[tool-surface] total=${total} chars over ${rows.length} tools\n`
      + `  by group: ${[...byGroup.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([group, chars]) => `${group}=${chars}`)
        .join(' ')}\n`
      + `  largest: ${rows.slice(0, 8).map((row) => `${row.name}=${row.chars}`).join(' ')}`,
    );

    expect(rows.length).toBeGreaterThan(0);
  });
});
