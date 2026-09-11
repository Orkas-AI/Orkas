import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const connectorMocks = vi.hoisted(() => ({
  resolveVisibleConnectors: vi.fn(),
}));

vi.mock('../../../../src/main/features/connectors/tools-adapter', () => ({
  resolveVisibleConnectors: connectorMocks.resolveVisibleConnectors,
}));

import {
  createRunProgramTool,
  isProgrammaticToolCallContext,
  markProgrammaticToolCallState,
} from '../../../../src/core-agent/src/tools/run-program';
import { normalizeMcpToolSchema } from '../../../../src/main/features/connectors/mcp-client';
import { createProgrammaticToolPolicy } from '../../../../src/main/model/core-agent/programmatic-tool-policy';
import { programmaticExecutionExposureFromSessionId } from '../../../../src/main/model/core-agent/runner';
import { TOOL_CATALOG } from '../../../../src/main/model/core-agent/tool-catalog';
import { createToolResultTools } from '../../../../src/main/model/core-agent/tool-result-tools';
import {
  persistToolResult,
  toolResultRefForPath,
} from '../../../../src/main/util/tool-result-cap';

const context = (workingDir = '/tmp/workspace') => ({ workingDir, state: {} });

const EXPECTED_PROGRAMMATIC_TOOL_NAMES = [
  'read_files',
  'list_files',
  'ocr_file',
  'search_files',
  'grep_files',
  'write_file',
  'append_file',
  'apply_patch',
  'edit_file',
  'delete_file',
  'workspace_diff',
  'bash',
  'pdf_render',
  'office_read',
  'office_review',
  'library',
  'research_verify_citations',
  'web_search',
  'web_fetch',
  'list_connector_tools',
  'call_connector_tool',
  'chat_history',
  'skill_search',
  'marketplace_search',
  'auto_tasks_list',
  'app_health',
  'tool_result',
] as const;

type ProgrammaticToolName = typeof EXPECTED_PROGRAMMATIC_TOOL_NAMES[number];

const VALID_PROGRAMMATIC_INPUTS: Record<ProgrammaticToolName, Record<string, unknown>> = {
  read_files: {},
  list_files: {},
  ocr_file: {},
  search_files: {},
  grep_files: {},
  write_file: {},
  append_file: {},
  apply_patch: {},
  edit_file: {},
  delete_file: {},
  workspace_diff: {},
  bash: {},
  pdf_render: { path: 'report.pdf' },
  office_read: { path: 'report.docx' },
  office_review: { path: 'report.docx' },
  library: {},
  research_verify_citations: {},
  web_search: { query: 'programmatic tools' },
  web_fetch: { url: 'https://example.com/evidence' },
  list_connector_tools: { connector_id: 'github' },
  call_connector_tool: { connector_id: 'github', tool_name: 'get_items', args: {} },
  chat_history: {},
  skill_search: { query: 'pdf' },
  marketplace_search: { query: 'pdf' },
  auto_tasks_list: {},
  app_health: {},
  tool_result: {},
};

function visibleConnector(options: {
  id?: string;
  origin?: 'catalog' | 'custom';
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
} = {}) {
  return {
    instance: {
      id: options.id ?? 'github',
      display_name: 'GitHub',
      ...(options.origin ? { origin: options.origin } : {}),
    },
    tools: [{
      name: 'get_items',
      description: 'Read items',
      input_schema: { type: 'object' },
      ...(options.annotations ? { annotations: options.annotations } : {}),
    }],
  };
}

describe('run_program Host policy', () => {
  beforeEach(() => {
    connectorMocks.resolveVisibleConnectors.mockReset();
    connectorMocks.resolveVisibleConnectors.mockResolvedValue([]);
  });

  it('loads and executes the isolated runtime from the packaged dependency path', async () => {
    const runProgram = createRunProgramTool({
      listToolNames: () => [],
      invokeTool: async () => ({ status: 'completed', result: { content: 'unused' } }),
    });
    const result = await runProgram.execute({ code: "text('ready')" }, context());
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('ready');
  });

  it('lets model-authored code transform a persisted result beyond the model read budget', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-program-result-'));
    try {
      const records = Array.from({ length: 300 }, (_, index) => ({
        id: index,
        groups: [{ values: [index, index + 1] }],
        padding: `private-${index}-`.repeat(12),
      }));
      const ref = toolResultRefForPath(persistToolResult(
        dir,
        'call_connector_tool',
        JSON.stringify({ records }),
      ));
      const resultTool = createToolResultTools({
        toolResultsDir: dir,
        materializeDir: path.join(dir, 'analysis-inputs'),
        isProgrammaticToolCallContext,
      })[0];
      const directLedger = {
        epoch: 0,
        remainingTokens: 4_000,
        readKeys: new Set<string>(),
      };
      const runProgram = createRunProgramTool({
        listToolNames: () => ['tool_result'],
        invokeTool: async (name, input, parentCtx) => {
          expect(name).toBe('tool_result');
          return {
            status: 'completed',
            result: await resultTool.execute(input, {
              ...parentCtx,
              state: markProgrammaticToolCallState({
                ...parentCtx.state,
              }),
            }),
          };
        },
      });
      const result = await runProgram.execute({
        code: `let cursor = 0;
          let source = "";
          let reads = 0;
          while (reads < 50) {
            const chunk = await tools.tool_result({
              action: "read",
              requests: [{ ref: ${JSON.stringify(ref)}, cursor, max_tokens: 2000 }],
            });
            if (!chunk.ok) throw new Error(chunk.content);
            reads += 1;
            const next = /next_cursor="([^"]+)"/.exec(chunk.content)?.[1];
            const bodyStart = chunk.content.indexOf("\\n") + 1;
            const bodyEnd = chunk.content.lastIndexOf("\\n</tool-result-chunk>");
            source += chunk.content.slice(bodyStart, bodyEnd);
            if (next === "done") break;
            cursor = Number(next);
          }
          const parsed = JSON.parse(source);
          const total = parsed.records.reduce((sum, record) => (
            sum + record.groups.reduce((groupSum, group) => (
              groupSum + group.values.reduce((valueSum, value) => valueSum + value, 0)
            ), 0)
          ), 0);
          json({ records: parsed.records.length, reads, total });`,
      }, { state: { toolResultReadLedger: directLedger } });

      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('"records":300');
      expect(result.content).toContain('"total":90000');
      expect(result.content).not.toContain('private-299');
      const summary = JSON.parse(result.content.slice(result.content.lastIndexOf('\n') + 1));
      expect(summary).toMatchObject({ records: 300, total: 90_000 });
      expect(summary.reads).toBeGreaterThan(2);
      expect(directLedger.remainingTokens).toBe(4_000);
      expect(directLedger.readKeys.size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins and authorizes the complete catalog-reviewed programmatic surface', async () => {
    const policy = createProgrammaticToolPolicy({ userId: 'u1' });
    const expected = [...EXPECTED_PROGRAMMATIC_TOOL_NAMES].sort();
    const catalogProgrammatic = TOOL_CATALOG
      .filter((entry) => entry.programmatic)
      .map((entry) => entry.name)
      .sort();

    expect(catalogProgrammatic).toEqual(expected);
    for (const entry of TOOL_CATALOG) {
      expect(policy.isEligible(entry.name), entry.name)
        .toBe(expected.includes(entry.name as ProgrammaticToolName));
    }
    connectorMocks.resolveVisibleConnectors.mockResolvedValue([
      visibleConnector({ annotations: { readOnlyHint: true, destructiveHint: false } }),
    ]);
    for (const name of EXPECTED_PROGRAMMATIC_TOOL_NAMES) {
      await expect(policy.authorize(name, VALID_PROGRAMMATIC_INPUTS[name], context()), name)
        .resolves.toEqual({ allowed: true });
    }
    await expect(policy.authorize('unknown_tool', {}, context())).resolves.toMatchObject({
      allowed: false,
      code: 'E_PROGRAM_CALLER_NOT_ALLOWED',
      directCallAllowed: true,
    });
  });

  it('routes every catalog-reviewed callable tool through one isolated program', async () => {
    const policy = createProgrammaticToolPolicy({ userId: 'u1' });
    connectorMocks.resolveVisibleConnectors.mockResolvedValue([
      visibleConnector({ annotations: { readOnlyHint: true, destructiveHint: false } }),
    ]);
    const callable = TOOL_CATALOG
      .map((entry) => entry.name)
      .filter((name) => policy.isEligible(name))
      .sort();
    expect(callable).toEqual([...EXPECTED_PROGRAMMATIC_TOOL_NAMES].sort());
    const specs = callable.map((name) => ({
      name,
      input: VALID_PROGRAMMATIC_INPUTS[name as ProgrammaticToolName],
    }));
    const calls: string[] = [];
    const runProgram = createRunProgramTool({
      listToolNames: () => callable,
      invokeTool: async (name, input, parentCtx) => {
        const authorization = await policy.authorize(name, input, parentCtx);
        if (authorization.allowed === false) return { status: 'denied', ...authorization };
        calls.push(name);
        return {
          status: 'completed',
          result: { content: JSON.stringify({ name }) },
        };
      },
    });

    const result = await runProgram.execute({
      code: `const specs = ${JSON.stringify(specs)};
        const seen = [];
        for (const spec of specs) {
          const child = await tools[spec.name](spec.input);
          if (!child.ok) throw new Error(child.content);
          seen.push(JSON.parse(child.content).name);
        }
        json({ keys: Object.keys(tools), seen });`,
    }, context());

    expect(result.isError).not.toBe(true);
    const summary = JSON.parse(result.content.slice(result.content.lastIndexOf('\n') + 1));
    expect(summary.keys).toEqual(callable);
    expect(summary.seen).toEqual(callable);
    expect(calls).toEqual(callable);
    expect(summary.keys).not.toEqual(expect.arrayContaining([
      'publish_outputs',
      'library_save',
      'process_session',
      'interactive_cli',
      'tool_load',
      'run_program',
    ]));
  });

  it('completes one deterministic write-execute-validate stage without exposing publication', async () => {
    const policy = createProgrammaticToolPolicy({ userId: 'u1' });
    const candidates = ['write_file', 'bash', 'read_files', 'publish_outputs'];
    const callable = candidates.filter((name) => policy.isEligible(name));
    const calls: string[] = [];
    const runProgram = createRunProgramTool({
      listToolNames: () => callable,
      invokeTool: async (name, input, parentCtx) => {
        const authorization = await policy.authorize(name, input, parentCtx);
        if (authorization.allowed === false) return { status: 'denied', ...authorization };
        calls.push(name);
        if (name === 'write_file') {
          return { status: 'completed', result: { content: '<file path="process.js"/>' } };
        }
        if (name === 'bash') {
          return { status: 'completed', result: { content: JSON.stringify({ exit_code: 0 }) } };
        }
        return {
          status: 'completed',
          result: { content: '<read-files count="1" errors="0">validated</read-files>' },
        };
      },
    });

    expect(runProgram.description).toContain('Bounded QuickJS for in-memory logic');
    expect(runProgram.description).toContain('combine/branch/batch/reduce Host-tool results');
    expect(runProgram.description).toContain('Call one Host operation directly');
    expect(runProgram.description).toContain('Use bash for local files, shell/CLI, Python, Node');
    expect(runProgram.description).toContain('tool_load reveals schemas, not permission');
    expect(runProgram.description).toContain('child policy/concurrency apply');
    expect(runProgram.description).not.toContain('deterministic compute/data work');
    expect(TOOL_CATALOG.find((entry) => entry.name === 'run_program')?.summary)
      .toBe('Run bounded QuickJS for custom in-memory logic or for combining Host-tool results when direct tools are insufficient.');
    const codeDescription = (runProgram.inputSchema.properties as Record<string, { description: string }>).code.description;
    expect(codeDescription).toContain('tools.<exact_snake_case_name>(direct args)');
    expect(codeDescription).toContain('QuickJS with top-level await');
    expect(codeDescription).toContain('text(value) or json(value)');
    const result = await runProgram.execute({
      code: `const written = await tools.write_file({ path: "process.js", content: "source" });
        if (!written.ok) throw new Error(written.content);
        const executed = await tools.bash({ command: "node process.js" });
        if (!executed.ok) throw new Error(executed.content);
        const verified = await tools.read_files({ files: [{ path: "result.json" }] });
        if (!verified.ok) throw new Error(verified.content);
        json({ written: true, executed: true, verified: verified.content.includes("validated") });`,
    }, context());

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('{"written":true,"executed":true,"verified":true}');
    expect(calls).toEqual(['write_file', 'bash', 'read_files']);
  });

  it('lets one program build a dependent manifest from Host-observed file identities', async () => {
    const workspace = path.join(os.tmpdir(), 'orkas-program-artifacts');
    const reportPath = path.join(workspace, 'outputs', 'report.json');
    const manifestPath = path.join(workspace, 'manifest.json');
    const reportHash = `sha256:${'a'.repeat(64)}`;
    const manifestHash = `sha256:${'b'.repeat(64)}`;
    const reportToolResult = {
      content: '<file written="true"/>',
      observations: {
        fileChanges: [{
          operation: 'create' as const,
          sourcePath: reportPath,
          beforeExists: false,
          afterExists: true,
          afterBytes: 37,
          afterHash: reportHash,
          coverage: 'exact' as const,
        }],
      },
    };
    let manifestInput: Record<string, unknown> | undefined;
    const runProgram = createRunProgramTool({
      listToolNames: () => ['write_file'],
      invokeTool: async (_name, input) => {
        if (input.path === 'outputs/report.json') {
          return { status: 'completed', result: reportToolResult };
        }
        manifestInput = input;
        return {
          status: 'completed',
          result: {
            content: '<file written="true"/>',
            observations: {
              fileChanges: [{
                operation: 'create',
                sourcePath: manifestPath,
                beforeExists: false,
                afterExists: true,
                afterBytes: 151,
                afterHash: manifestHash,
                coverage: 'exact',
              }],
            },
          },
        };
      },
    });

    const result = await runProgram.execute({
      code: `const report = await tools.write_file({ path: "outputs/report.json", content: "{}" });
        if (!report.ok) throw new Error(report.content);
        if (!report.artifacts?.length) throw new Error("missing artifact identity");
        const manifest = await tools.write_file({
          path: "manifest.json",
          content: JSON.stringify({ files: report.artifacts }),
        });
        if (!manifest.ok) throw new Error(manifest.content);
        json({ report: report.artifacts[0], manifest: manifest.artifacts[0] });`,
    }, context(workspace));

    expect(result.isError).not.toBe(true);
    expect(manifestInput).toEqual({
      path: 'manifest.json',
      content: JSON.stringify({
        files: [{
          path: 'outputs/report.json',
          operation: 'create',
          exists: true,
          bytes: 37,
          hash: reportHash,
        }],
      }),
    });
    const summary = JSON.parse(result.content.slice(result.content.lastIndexOf('\n') + 1));
    expect(summary).toEqual({
      report: {
        path: 'outputs/report.json',
        operation: 'create',
        exists: true,
        bytes: 37,
        hash: reportHash,
      },
      manifest: {
        path: 'manifest.json',
        operation: 'create',
        exists: true,
        bytes: 151,
        hash: manifestHash,
      },
    });
    expect(reportToolResult).not.toHaveProperty('artifacts');
  });

  it('allows only visible catalog connector actions explicitly annotated read-only', async () => {
    const policy = createProgrammaticToolPolicy({ userId: 'u1' });
    const input = { connector_id: 'github', tool_name: 'get_items', args: {} };

    connectorMocks.resolveVisibleConnectors.mockResolvedValue([
      visibleConnector({ annotations: { readOnlyHint: true, destructiveHint: false } }),
    ]);
    await expect(policy.authorize('call_connector_tool', input, context()))
      .resolves.toEqual({ allowed: true });

    connectorMocks.resolveVisibleConnectors.mockResolvedValue([visibleConnector()]);
    await expect(policy.authorize('call_connector_tool', input, context()))
      .resolves.toMatchObject({ allowed: false, code: 'E_PROGRAM_CONNECTOR_NOT_READ_ONLY' });

    connectorMocks.resolveVisibleConnectors.mockResolvedValue([
      visibleConnector({ annotations: { readOnlyHint: true, destructiveHint: true } }),
    ]);
    await expect(policy.authorize('call_connector_tool', input, context()))
      .resolves.toMatchObject({ allowed: false, code: 'E_PROGRAM_CONNECTOR_NOT_READ_ONLY' });

    connectorMocks.resolveVisibleConnectors.mockResolvedValue([
      visibleConnector({ id: 'custom-github', origin: 'custom', annotations: { readOnlyHint: true } }),
    ]);
    await expect(policy.authorize('call_connector_tool', {
      ...input,
      connector_id: 'custom-github',
    }, context())).resolves.toMatchObject({
      allowed: false,
      code: 'E_PROGRAM_CONNECTOR_UNTRUSTED',
    });
  });

  it('preserves only standardized MCP tool annotations used by authorization', () => {
    expect(normalizeMcpToolSchema({
      name: 'list_items',
      description: 'List items',
      inputSchema: { type: 'object' },
      annotations: {
        title: 'List',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        vendorSecret: 'discard-me',
      },
    })).toEqual({
      name: 'list_items',
      description: 'List items',
      input_schema: { type: 'object' },
      annotations: {
        title: 'List',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    });
  });

  it('fails closed for missing connector scope, bad input, invisible actions, and policy lookup errors', async () => {
    const unscoped = createProgrammaticToolPolicy();
    await expect(unscoped.authorize('call_connector_tool', {
      connector_id: 'github', tool_name: 'get_items', args: {},
    }, context())).resolves.toMatchObject({ allowed: false, code: 'E_PROGRAM_CONNECTOR_SCOPE' });

    const policy = createProgrammaticToolPolicy({ userId: 'u1' });
    await expect(policy.authorize('call_connector_tool', {}, context()))
      .resolves.toMatchObject({ allowed: false, code: 'E_PROGRAM_BAD_TOOL_INPUT' });
    await expect(policy.authorize('call_connector_tool', {
      connector_id: 'missing', tool_name: 'get_items', args: {},
    }, context())).resolves.toMatchObject({ allowed: false, code: 'E_PROGRAM_CONNECTOR_NOT_VISIBLE' });

    connectorMocks.resolveVisibleConnectors.mockRejectedValueOnce(new Error('private backend detail'));
    await expect(policy.authorize('call_connector_tool', {
      connector_id: 'github', tool_name: 'get_items', args: {},
    }, context())).rejects.toThrow('private backend detail');
  });

  it('restricts conditional web, workspace, and catalog reads without weakening target-tool gates', async () => {
    const policy = createProgrammaticToolPolicy({ userId: 'u1' });

    await expect(policy.authorize('web_fetch', { url: 'https://example.com/a' }, context()))
      .resolves.toEqual({ allowed: true });
    for (const url of [
      'file:///tmp/a',
      'http://localhost/a',
      'http://127.0.0.1/a',
      'http://192.168.1.2/a',
      'https://user:pass@example.com/a',
    ]) {
      await expect(policy.authorize('web_fetch', { url }, context()))
        .resolves.toMatchObject({ allowed: false, code: 'E_PROGRAM_NETWORK_SCOPE' });
    }

    await expect(policy.authorize('office_read', { path: 'report.docx' }, { state: {} }))
      .resolves.toMatchObject({ allowed: false, code: 'E_PROGRAM_WORKSPACE_SCOPE' });
    await expect(policy.authorize('office_read', {
      path: 'report.docx', output_path: 'copy.docx',
    }, context())).resolves.toMatchObject({
      allowed: false,
      code: 'E_PROGRAM_WORKSPACE_WRITE_NOT_ALLOWED',
    });
    await expect(policy.authorize('office_read', { path: 'report.docx' }, context()))
      .resolves.toEqual({ allowed: true });

    await expect(policy.authorize('marketplace_search', { query: 'pdf' }, context()))
      .resolves.toEqual({ allowed: true });
    await expect(policy.authorize('marketplace_search', { query: 'pdf', install: true }, context()))
      .resolves.toMatchObject({ allowed: false, code: 'E_PROGRAM_CATALOG_MUTATION_NOT_ALLOWED' });
  });

  it('exposes run_program only in normal task runtimes', () => {
    expect(programmaticExecutionExposureFromSessionId('gconv-1')).toBe(true);
    expect(programmaticExecutionExposureFromSessionId('gmember-1')).toBe(true);
    expect(programmaticExecutionExposureFromSessionId('gworker-1')).toBe(true);
    for (const sessionId of ['reflect-1', 'agent-1', 'skill-1', 'anon-1', 'cli-1']) {
      expect(programmaticExecutionExposureFromSessionId(sessionId)).toBe(false);
    }
  });
});
