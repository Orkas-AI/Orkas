import { defineTool, type AgentTool } from "../tools/base.js";
import type { MemorySearchManager } from "./types.js";

/**
 * Create a memory search tool that can be used by the agent.
 * This allows the agent to search its memory during conversations.
 */
export function createMemorySearchTool(manager: MemorySearchManager): AgentTool {
  return defineTool({
    name: "memory_search",
    description:
      "Search your memory for relevant information. Use this when you need to recall " +
      "previous conversations, stored knowledge, or context about the user's projects.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query — describe what you're looking for.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 5).",
        },
      },
      required: ["query"],
    },
    async execute(input) {
      const query = input.query as string;
      const maxResults = (input.maxResults as number) ?? 5;

      try {
        const results = await manager.search(query, { maxResults });

        if (results.length === 0) {
          return { content: "No relevant memories found." };
        }

        const formatted = results
          .map(
            (r, i) =>
              `[${i + 1}] ${r.path} (lines ${r.startLine}-${r.endLine}, score: ${r.score.toFixed(2)})\n${r.snippet}`,
          )
          .join("\n\n");

        return { content: formatted };
      } catch (err) {
        return { content: `Memory search error: ${(err as Error).message}`, isError: true };
      }
    },
  });
}

/**
 * Create a memory read tool for reading specific files from memory.
 */
export function createMemoryReadTool(manager: MemorySearchManager): AgentTool {
  return defineTool({
    name: "memory_read",
    description: "Read a specific file from memory by its path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the memory file." },
        from: { type: "number", description: "Starting line number (1-based)." },
        lines: { type: "number", description: "Number of lines to read." },
      },
      required: ["path"],
    },
    async execute(input) {
      try {
        const result = await manager.readFile({
          relPath: input.path as string,
          from: input.from as number | undefined,
          lines: input.lines as number | undefined,
        });
        return { content: result.text };
      } catch (err) {
        return { content: `Memory read error: ${(err as Error).message}`, isError: true };
      }
    },
  });
}
