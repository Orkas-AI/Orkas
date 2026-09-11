import { describe, expect, it } from "vitest";

import {
  createRunProgramTool,
  type ProgrammaticToolInvokeOutcome,
} from "../src/tools/run-program.js";
import type { ToolContext } from "../src/tools/base.js";

const context: ToolContext = {
  workingDir: "/tmp/orkas-run-program-scenarios",
  state: {},
};

function scenarioTool(
  invokeTool: (
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ProgrammaticToolInvokeOutcome>,
) {
  return createRunProgramTool({
    listToolNames: () => ["call_connector_tool"],
    invokeTool,
    limits: { maxConcurrentToolCalls: 3 },
  });
}

function successfulContent(result: { content: string; isError?: boolean }): string {
  expect(result.isError).not.toBe(true);
  return result.content;
}

describe("run_program realistic model-program simulations", () => {
  it("follows an observed cursor protocol until exhaustion and returns only an aggregate", async () => {
    const requestedCursors: Array<string | null> = [];
    const pages = new Map<string, { items: Array<{ id: number; spend: number }>; next_cursor: string | null }>([
      ["start", { items: [{ id: 1, spend: 10 }, { id: 2, spend: 15 }], next_cursor: "page-2" }],
      ["page-2", { items: [{ id: 3, spend: 20 }, { id: 4, spend: 25 }], next_cursor: "page-3" }],
      ["page-3", { items: [{ id: 5, spend: 30 }], next_cursor: null }],
    ]);
    const runProgram = scenarioTool(async (name, input) => {
      expect(name).toBe("call_connector_tool");
      expect(input).toMatchObject({ connector_id: "demo", tool_name: "list_campaigns" });
      const args = input.args as Record<string, unknown>;
      const cursor = typeof args.cursor === "string" ? args.cursor : null;
      requestedCursors.push(cursor);
      const page = pages.get(cursor ?? "start");
      expect(page).toBeDefined();
      return {
        status: "completed",
        result: {
          content: JSON.stringify({
            ...page,
            provider_debug_blob: `raw-page-${cursor ?? "start"}`,
          }),
        },
      };
    });

    // This is representative model-authored code: it learns the continuation
    // shape from tool results, owns the loop, and emits one compact aggregate.
    const result = await runProgram.execute({
      code: `const campaigns = [];
        let cursor = null;
        while (true) {
          const pageResult = await tools.call_connector_tool({
            connector_id: "demo",
            tool_name: "list_campaigns",
            args: cursor ? { cursor } : {},
          });
          if (!pageResult.ok) throw new Error(pageResult.content);
          const page = JSON.parse(pageResult.content);
          campaigns.push(...page.items);
          if (!page.next_cursor) break;
          cursor = page.next_cursor;
        }
        json({
          count: campaigns.length,
          ids: campaigns.map((item) => item.id),
          total_spend: campaigns.reduce((sum, item) => sum + item.spend, 0),
        });`,
    }, context);

    const content = successfulContent(result);
    expect(requestedCursors).toEqual([null, "page-2", "page-3"]);
    expect(content).toContain('{"count":5,"ids":[1,2,3,4,5],"total_spend":100}');
    expect(content).not.toContain("provider_debug_blob");
    expect(content).not.toContain("raw-page-");
  });

  it("loads IDs once, fetches details in model-chosen batches, filters, and aggregates", async () => {
    const detailIds: number[] = [];
    let active = 0;
    let peak = 0;
    const details = new Map([
      [1, { id: 1, enabled: true, spend: 11 }],
      [2, { id: 2, enabled: false, spend: 12 }],
      [3, { id: 3, enabled: true, spend: 13 }],
      [4, { id: 4, enabled: true, spend: 14 }],
      [5, { id: 5, enabled: false, spend: 15 }],
    ]);
    const runProgram = scenarioTool(async (_name, input) => {
      const toolName = String(input.tool_name);
      if (toolName === "list_campaign_ids") {
        return {
          status: "completed",
          result: { content: JSON.stringify({ ids: [1, 2, 3, 4, 5] }) },
        };
      }
      expect(toolName).toBe("get_campaign_detail");
      const id = Number((input.args as Record<string, unknown>).id);
      detailIds.push(id);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        status: "completed",
        result: { content: JSON.stringify({ ...details.get(id), internal_trace: `trace-${id}` }) },
      };
    });

    const result = await runProgram.execute({
      code: `const listed = await tools.call_connector_tool({
          connector_id: "demo",
          tool_name: "list_campaign_ids",
          args: {},
        });
        if (!listed.ok) throw new Error(listed.content);
        const ids = JSON.parse(listed.content).ids;
        const details = [];
        const batchSize = 2;
        for (let offset = 0; offset < ids.length; offset += batchSize) {
          const batch = ids.slice(offset, offset + batchSize);
          const results = await Promise.all(batch.map((id) => tools.call_connector_tool({
            connector_id: "demo",
            tool_name: "get_campaign_detail",
            args: { id },
          })));
          for (const item of results) {
            if (item.ok) details.push(JSON.parse(item.content));
          }
        }
        const enabled = details.filter((item) => item.enabled);
        json({
          requested: ids.length,
          resolved: details.length,
          enabled_ids: enabled.map((item) => item.id),
          enabled_spend: enabled.reduce((sum, item) => sum + item.spend, 0),
        });`,
    }, context);

    const content = successfulContent(result);
    expect(detailIds.sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(content).toContain(
      '{"requested":5,"resolved":5,"enabled_ids":[1,3,4],"enabled_spend":38}',
    );
    expect(content).not.toContain("internal_trace");
  });

  it("uses program-defined duplicate-cursor protection instead of looping forever", async () => {
    let calls = 0;
    const runProgram = scenarioTool(async () => {
      calls += 1;
      return {
        status: "completed",
        result: {
          content: JSON.stringify({
            items: [{ id: calls }],
            next_cursor: "stuck-cursor",
          }),
        },
      };
    });

    const result = await runProgram.execute({
      code: `const seenCursors = new Set();
        const items = [];
        let cursor = null;
        let stopReason = "exhausted";
        for (let pageNo = 0; pageNo < 20; pageNo++) {
          const response = await tools.call_connector_tool({
            connector_id: "demo",
            tool_name: "list_campaigns",
            args: cursor ? { cursor } : {},
          });
          if (!response.ok) {
            stopReason = "tool_error";
            break;
          }
          const page = JSON.parse(response.content);
          items.push(...page.items);
          if (!page.next_cursor) break;
          if (seenCursors.has(page.next_cursor)) {
            stopReason = "duplicate_cursor";
            break;
          }
          seenCursors.add(page.next_cursor);
          cursor = page.next_cursor;
        }
        json({ status: "partial", stop_reason: stopReason, item_count: items.length });`,
    }, context);

    const content = successfulContent(result);
    expect(calls).toBe(2);
    expect(content).toContain(
      '{"status":"partial","stop_reason":"duplicate_cursor","item_count":2}',
    );
  });

  it("detects a result-schema change and returns evidence for the next model decision", async () => {
    let calls = 0;
    const runProgram = scenarioTool(async () => {
      calls += 1;
      return {
        status: "completed",
        result: {
          content: calls === 1
            ? JSON.stringify({ items: [{ id: 1 }], next_cursor: "page-2" })
            : JSON.stringify({ records: [{ id: 2 }], continuation: "page-3" }),
        },
      };
    });

    const result = await runProgram.execute({
      code: `const accepted = [];
        let cursor = null;
        let structuralChange = null;
        while (true) {
          const response = await tools.call_connector_tool({
            connector_id: "demo",
            tool_name: "list_campaigns",
            args: cursor ? { cursor } : {},
          });
          if (!response.ok) throw new Error(response.content);
          const page = JSON.parse(response.content);
          if (!Array.isArray(page.items)) {
            structuralChange = Object.keys(page).sort();
            break;
          }
          accepted.push(...page.items);
          if (!page.next_cursor) break;
          cursor = page.next_cursor;
        }
        json({
          status: structuralChange ? "needs_model" : "complete",
          reason: structuralChange ? "result_schema_changed" : null,
          accepted_count: accepted.length,
          observed_keys: structuralChange,
        });`,
    }, context);

    const content = successfulContent(result);
    expect(calls).toBe(2);
    expect(content).toContain(
      '{"status":"needs_model","reason":"result_schema_changed","accepted_count":1,"observed_keys":["continuation","records"]}',
    );
  });

  it("retries an ordinary transient child error within a model-defined attempt budget", async () => {
    let calls = 0;
    const runProgram = scenarioTool(async () => {
      calls += 1;
      return calls < 3
        ? { status: "completed", result: { content: `temporary-${calls}`, isError: true } }
        : { status: "completed", result: { content: JSON.stringify({ value: 42 }) } };
    });

    const result = await runProgram.execute({
      code: `let finalResult = null;
        const errors = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
          const response = await tools.call_connector_tool({
            connector_id: "demo",
            tool_name: "get_summary",
            args: {},
          });
          if (response.ok) {
            finalResult = JSON.parse(response.content);
            break;
          }
          errors.push(response.content);
        }
        json({
          status: finalResult ? "complete" : "needs_model",
          attempts: errors.length + (finalResult ? 1 : 0),
          value: finalResult?.value ?? null,
          transient_errors: errors.length,
        });`,
    }, context);

    const content = successfulContent(result);
    expect(calls).toBe(3);
    expect(content).toContain(
      '{"status":"complete","attempts":3,"value":42,"transient_errors":2}',
    );
    const emittedOutput = content.split("\n\n").slice(1).join("\n\n");
    expect(emittedOutput).not.toContain("temporary-1");
    expect(emittedOutput).not.toContain("temporary-2");
    expect(content).not.toContain("temporary-1");
    expect(content).toContain('"failed_tool":{"tool":"call_connector_tool","call":2,"message":"temporary-2"}');
  });
});
