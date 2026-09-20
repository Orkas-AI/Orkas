import { estimateBudgetTokens } from '../../../src/main/util/token-estimate';
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

/** Local conservative token budgets for the serialized provider definitions.
 * Calibrated 2026-09-18 after the bounded-history retrieval change: individual
 * definitions 118–2,194; Library/history 1,490; tool_result 1,529; built-in initial
 * surfaces 6,725–11,081 tokens, with about 5–10% wording headroom. Concurrent
 * root-schema simplification lowers the integrated corpus to 19,940 and initial
 * surfaces to 6,359–10,794; retain the already calibrated caps.
 * This intentionally replaces the three stale character gates broken by that
 * retrieval change. Tool names, schemas and per-agent capability counts stay
 * unchanged. Raising a cap still requires review; estimates are not billing. */

/** Serialized size of one tool exactly as it rides in the request body. */
function definitionTokens(tool: AgentTool): number {
  return estimateBudgetTokens(JSON.stringify(toToolDefinition(tool)));
}

const TOOL_SURFACE_BUDGET_TOKENS = 22_000;

const SINGLE_TOOL_BUDGET_TOKENS = 2_500;
const CONSOLIDATED_RETRIEVAL_BUDGET_TOKENS = 1_600;

const TOOL_RESULT_BUDGET_TOKENS = 1_600;

const OFFICE_GROUP_BUDGET_TOKENS = 7_600;
const OFFICE_HEAVY_TOOL_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  create_xlsx: 1_900,
  create_pptx: 2_300,
});

const AGENT_FALLBACK_DIRECTORY_BUDGET_TOKENS = 650;

const COMMANDER_DIRECTORY_BUDGET_TOKENS = 1_500;
const COMMANDER_COMMON_INITIAL_BUDGET_TOKENS = 6_500;
// The approved shared browser adds one initially active definition, including
// task-turn retention. Keep its cost separate so the existing corpus cannot grow.
const BROWSER_DEFINITION_BUDGET_TOKENS = 1_000;

const BUILTIN_AGENT_INITIAL_SURFACE_BUDGETS: Readonly<Record<
  string,
  { tools: number; tokens: number }
>> = Object.freeze({
  ContentWriter: { tools: 22, tokens: 7_300 },
  DeepResearcher: { tools: 24, tokens: 7_300 },
  VideoStudio: { tools: 25, tokens: 9_500 },
  VoiceStudio: { tools: 23, tokens: 7_900 },
  PptMaker: { tools: 16, tokens: 8_100 },
  ImageStudio: { tools: 20, tokens: 8_400 },
  OfficeWorker: { tools: 21, tokens: 12_000 },
  ProductDeveloper: { tools: 25, tokens: 8_800 },
  UIDesigner: { tools: 25, tokens: 8_800 },
  SeoGeoAgent: { tools: 24, tokens: 8_500 },
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
      expect(estimateBudgetTokens(directory)).toBeLessThanOrEqual(COMMANDER_DIRECTORY_BUDGET_TOKENS);

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
      const schemaTokens = [
        ...commonTools.filter((tool) => commonSurface.isActive(tool.name)),
        createToolLoadTool(commonSurface),
      ].reduce((sum, tool) => sum + definitionTokens(tool), 0);
      const browserTokens = definitionTokens(commonTools.find(tool => tool.name === 'inner_browser')!);
      expect(browserTokens).toBeLessThanOrEqual(BROWSER_DEFINITION_BUDGET_TOKENS);
      expect(estimateBudgetTokens(commonDirectory) + schemaTokens)
        .toBeLessThanOrEqual(COMMANDER_COMMON_INITIAL_BUDGET_TOKENS + BROWSER_DEFINITION_BUDGET_TOKENS);
      expect(estimateBudgetTokens(commonDirectory) + schemaTokens - browserTokens)
        .toBeLessThanOrEqual(COMMANDER_COMMON_INITIAL_BUDGET_TOKENS);
      // eslint-disable-next-line no-console
      console.log(`[tool-surface:commander] max_directory=${estimateBudgetTokens(directory)} common_directory=${estimateBudgetTokens(commonDirectory)} common_initial_schemas=${schemaTokens}`);
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

    expect(estimateBudgetTokens(block)).toBeLessThanOrEqual(AGENT_FALLBACK_DIRECTORY_BUDGET_TOKENS);
    expect(block).toContain('`workspace.write.output`');
    expect(block).not.toContain('- `workspace` —');
    expect(block).not.toContain('- `office` —');
    expect(block).not.toContain('- `media` —');
  });

  it('finds the injected tool corpus', () => {
    // A silent empty/short corpus would make every assertion below vacuous:
    // a factory signature change that returns [] must fail here, not pass
    // quietly with a 0-token surface.
    // The merged surface includes the 1.7 additions and the 1.6.6 retirement
    // of read_file/stat_file and the requester-confirmed local OCR retirement.
    expect(tools).toHaveLength(38);
    expect(tools.some((tool) => tool.name === 'ocr_file')).toBe(false);
    expect(tools.some((tool) => tool.name === 'inner_browser')).toBe(true);
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

    const tokens = retrievalTools.reduce((sum, tool) => sum + definitionTokens(tool), 0);
    expect(
      tokens,
      `consolidated Library/history definitions total ${tokens} tokens; budget ${CONSOLIDATED_RETRIEVAL_BUDGET_TOKENS}`,
    ).toBeLessThanOrEqual(CONSOLIDATED_RETRIEVAL_BUDGET_TOKENS);
  });

  it('keeps the host-required tool_result definition compact', () => {
    // Host-required, so it is not part of the enumerated allowlist surface.
    const [toolResult] = createToolResultTools({ toolResultsDir: os.tmpdir() } as any);
    const tokens = definitionTokens(toolResult);
    expect(
      tokens,
      `tool_result definition is ${tokens} tokens; budget ${TOOL_RESULT_BUDGET_TOKENS} — it is sent on every model request`,
    ).toBeLessThanOrEqual(TOOL_RESULT_BUDGET_TOKENS);
  });

  it('keeps the whole injected tool surface under budget', () => {
    const total = tools.reduce((sum, tool) => sum + definitionTokens(tool), 0);
    expect(
      total,
      `injected tool definitions total ${total} tokens (budget ${TOOL_SURFACE_BUDGET_TOKENS}); `
      + 'this bounds the all-active corpus — trim a schema or scope the tool, '
      + 'do not raise the budget without recording why',
    ).toBeLessThanOrEqual(TOOL_SURFACE_BUDGET_TOKENS);
  });

  it('keeps any single tool definition under budget', () => {
    const oversized = tools
      .map((tool) => ({ name: tool.name, tokens: definitionTokens(tool) }))
      .filter((row) => row.tokens > SINGLE_TOOL_BUDGET_TOKENS)
      .map((row) => `${row.name}: ${row.tokens} tokens (budget ${SINGLE_TOOL_BUDGET_TOKENS})`);

    expect(oversized, 'one tool must not dominate the shared surface').toEqual([]);
  });

  it('keeps the reviewed Office schemas within their group and heavy-tool budgets', () => {
    const officeNames = new Set(
      TOOL_CATALOG
        .filter((entry) => entry.loadGroups?.some((group) => group.startsWith('office.')))
        .map((entry) => entry.name),
    );
    const officeTools = tools.filter((tool) => officeNames.has(tool.name));
    const tokens = officeTools.reduce((sum, tool) => sum + definitionTokens(tool), 0);

    expect(officeTools).toHaveLength(9);
    expect(
      tokens,
      `Office definitions total ${tokens} tokens; budget ${OFFICE_GROUP_BUDGET_TOKENS}`,
    ).toBeLessThanOrEqual(OFFICE_GROUP_BUDGET_TOKENS);
    for (const [name, budget] of Object.entries(OFFICE_HEAVY_TOOL_BUDGETS)) {
      const tool = officeTools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`missing reviewed Office tool ${name}`);
      expect(
        definitionTokens(tool),
        `${name} exceeds its reviewed ${budget}-token schema budget`,
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
        const tokens = initialTools.reduce((sum, tool) => sum + definitionTokens(tool), 0);
        const budget = BUILTIN_AGENT_INITIAL_SURFACE_BUDGETS[scenario.name];

        if (!budget) throw new Error(`${scenario.name} is missing an initial schema budget`);
        expect(
          initialTools.length,
          `${scenario.name} sends ${initialTools.length} common-corpus schemas; budget ${budget.tools}`,
        ).toBeLessThanOrEqual(budget.tools);
        expect(
          tokens,
          `${scenario.name} sends ${tokens} common-corpus schema tokens; budget ${budget.tokens}`,
        ).toBeLessThanOrEqual(budget.tokens);
        measurements.push(`${scenario.name}=${initialTools.length}/${tokens}`);
      }
    } finally {
      if (previousMode === undefined) delete process.env.ORKAS_TOOL_LOADING_MODE;
      else process.env.ORKAS_TOOL_LOADING_MODE = previousMode;
    }

    // eslint-disable-next-line no-console
    console.log(`[tool-surface:builtins] tools/tokens ${measurements.join(' ')}`);
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

  it('rejects dense CJK schema growth that fits the former character gate', () => {
    const original = tools.find(tool => tool.name === 'write_file')!;
    const regressed = { ...original, description: '界'.repeat(1_700) };
    expect(JSON.stringify(toToolDefinition(regressed)).length).toBeLessThan(8_000);
    expect(definitionTokens(regressed)).toBeGreaterThan(SINGLE_TOOL_BUDGET_TOKENS);
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
        tokens: definitionTokens(tool),
      }))
      .sort((left, right) => right.tokens - left.tokens);

    const byGroup = new Map<string, number>();
    for (const row of rows) byGroup.set(row.group, (byGroup.get(row.group) ?? 0) + row.tokens);

    const total = rows.reduce((sum, row) => sum + row.tokens, 0);
    // eslint-disable-next-line no-console
    console.log(
      `[tool-surface] total=${total} tokens over ${rows.length} tools\n`
      + `  by group: ${[...byGroup.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([group, tokens]) => `${group}=${tokens}`)
        .join(' ')}\n`
      + `  largest: ${rows.slice(0, 8).map((row) => `${row.name}=${row.tokens}`).join(' ')}`,
    );

    expect(rows.length).toBeGreaterThan(0);
  });
});
