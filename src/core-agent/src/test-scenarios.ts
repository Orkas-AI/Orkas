#!/usr/bin/env npx tsx
/**
 * Test scenarios for core-agent — quickly verify different capabilities.
 *
 * Usage:
 *   npx tsx src/test-scenarios.ts                          # run all scenarios
 *   npx tsx src/test-scenarios.ts --scenario tool-call     # run one scenario
 *   npx tsx src/test-scenarios.ts --list                   # list available scenarios
 *   npx tsx src/test-scenarios.ts --provider openai-codex --model codex-mini-latest
 */
import { createConfig } from "./config/index.js";
import { AgentRunner } from "./agent/index.js";
import { defineTool } from "./tools/index.js";
import type { AgentTool } from "./tools/base.js";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function getFlag(name: string, fallback: string): string {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
}
const hasFlag = (name: string) => argv.includes(`--${name}`);

const provider = getFlag("provider", "openai-codex");
const model = getFlag("model", "codex-mini-latest");
const targetScenario = getFlag("scenario", "");
const listOnly = hasFlag("list");
const verbose = hasFlag("verbose");

// ---------------------------------------------------------------------------
// Custom tools for testing
// ---------------------------------------------------------------------------
const calculatorTool: AgentTool = defineTool({
  name: "calculator",
  description: "Evaluate a mathematical expression. Example: '2 + 3 * 4'",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Math expression to evaluate." },
    },
    required: ["expression"],
  },
  async execute(input) {
    const expr = input.expression as string;
    const sanitized = expr.replace(/[^0-9+\-*/().%\s]/g, "");
    if (sanitized !== expr) {
      return { content: "Invalid expression: unsupported characters", isError: true };
    }
    try {
      const result = Function(`"use strict"; return (${sanitized})`)();
      return { content: `${expr} = ${result}` };
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
  },
});

const weatherTool: AgentTool = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city (mock data for testing).",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name." },
    },
    required: ["city"],
  },
  async execute(input) {
    const city = input.city as string;
    // Mock data
    const data: Record<string, string> = {
      beijing: "Sunny, 26°C, humidity 40%",
      shanghai: "Cloudy, 22°C, humidity 65%",
      tokyo: "Rainy, 18°C, humidity 80%",
      "new york": "Partly cloudy, 20°C, humidity 55%",
    };
    const weather = data[city.toLowerCase()] ?? `Clear, 23°C, humidity 50% (default for ${city})`;
    return { content: weather };
  },
});

const todoTool: AgentTool = defineTool({
  name: "todo_list",
  description: "Manage a simple todo list. Actions: add, list, remove.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "remove"], description: "Action to perform." },
      item: { type: "string", description: "Todo item text (for add/remove)." },
    },
    required: ["action"],
  },
  async execute(input, ctx) {
    const todos = (ctx.state.todos as string[] | undefined) ?? [];
    ctx.state.todos = todos;
    const action = input.action as string;

    if (action === "add") {
      const item = input.item as string;
      if (!item) return { content: "Error: item is required for add", isError: true };
      todos.push(item);
      return { content: `Added: "${item}". Total: ${todos.length} items.` };
    }
    if (action === "list") {
      if (todos.length === 0) return { content: "Todo list is empty." };
      return { content: todos.map((t, i) => `${i + 1}. ${t}`).join("\n") };
    }
    if (action === "remove") {
      const item = input.item as string;
      const idx = todos.indexOf(item);
      if (idx === -1) return { content: `Not found: "${item}"`, isError: true };
      todos.splice(idx, 1);
      return { content: `Removed: "${item}". Remaining: ${todos.length} items.` };
    }
    return { content: `Unknown action: ${action}`, isError: true };
  },
});

// ---------------------------------------------------------------------------
// Test scenario definitions
// ---------------------------------------------------------------------------
interface Scenario {
  name: string;
  description: string;
  message: string;
  tools?: AgentTool[];
  systemPrompt?: string;
  /** What to check in the result to determine pass/fail. */
  validate(result: Awaited<ReturnType<AgentRunner["run"]>>): { pass: boolean; reason: string };
}

const scenarios: Scenario[] = [
  {
    name: "basic-chat",
    description: "Basic text response without tool use",
    message: "What is the capital of France? Answer in one sentence.",
    validate(r) {
      const hasText = r.text.length > 0 && !r.meta.error;
      const mentionsParis = r.text.toLowerCase().includes("paris");
      return {
        pass: hasText && mentionsParis,
        reason: hasText
          ? mentionsParis
            ? "Correct answer"
            : "Response received but missing 'Paris'"
          : `No response: ${r.meta.error?.message ?? "unknown"}`,
      };
    },
  },
  {
    name: "tool-call",
    description: "Single tool call (calculator)",
    message: "What is 123 * 456? Use the calculator tool to compute it.",
    tools: [calculatorTool],
    validate(r) {
      const usedTool = r.meta.toolLoops > 0;
      const correctAnswer = r.text.includes("56088");
      return {
        pass: usedTool && correctAnswer,
        reason: usedTool
          ? correctAnswer
            ? "Tool called and correct answer"
            : "Tool called but answer missing '56088'"
          : `No tool call. toolLoops=${r.meta.toolLoops}`,
      };
    },
  },
  {
    name: "multi-tool",
    description: "Multiple different tool calls in one conversation turn",
    message:
      "I need two things: 1) Calculate 99 * 77 using the calculator. 2) Get the weather in Beijing. Do both.",
    tools: [calculatorTool, weatherTool],
    validate(r) {
      const usedTools = r.meta.toolLoops > 0;
      const hasCalcResult = r.text.includes("7623");
      const hasWeather = r.text.toLowerCase().includes("beijing") || r.text.includes("26");
      return {
        pass: usedTools && hasCalcResult && hasWeather,
        reason: [
          usedTools ? "tools used" : "NO tool calls",
          hasCalcResult ? "calc OK" : "calc missing",
          hasWeather ? "weather OK" : "weather missing",
        ].join(", "),
      };
    },
  },
  {
    name: "sequential-tools",
    description: "Tool calls that depend on each other (add then list todos)",
    message:
      'Use the todo_list tool to: 1) add "Buy milk", 2) add "Write tests", 3) list all todos. Show the final list.',
    tools: [todoTool],
    validate(r) {
      const usedTools = r.meta.toolLoops > 0;
      const hasMilk = r.text.toLowerCase().includes("milk");
      const hasTests = r.text.toLowerCase().includes("test");
      return {
        pass: usedTools && hasMilk && hasTests,
        reason: [
          usedTools ? "tools used" : "NO tool calls",
          hasMilk ? "item1 OK" : "item1 missing",
          hasTests ? "item2 OK" : "item2 missing",
        ].join(", "),
      };
    },
  },
  {
    name: "builtin-list-files",
    description: "Built-in list_files tool on current directory",
    message: "Use the list_files tool to show files in the current directory.",
    validate(r) {
      const usedTools = r.meta.toolLoops > 0;
      const hasPackageJson = r.text.toLowerCase().includes("package.json");
      return {
        pass: usedTools && hasPackageJson,
        reason: usedTools
          ? hasPackageJson
            ? "Listed files, found package.json"
            : "Listed files but package.json not mentioned"
          : "No tool call",
      };
    },
  },
  {
    name: "builtin-read-file",
    description: "Built-in read_file tool to read package.json",
    message: "Use the read_file tool to read package.json, then tell me the project name and version.",
    validate(r) {
      const usedTools = r.meta.toolLoops > 0;
      const hasName = r.text.includes("core-agent");
      return {
        pass: usedTools && hasName,
        reason: usedTools
          ? hasName
            ? "Read file and extracted project info"
            : "Read file but project name not found"
          : "No tool call",
      };
    },
  },
  {
    name: "builtin-bash",
    description: "Built-in bash tool to run a shell command",
    message: 'Use the bash tool to run "echo hello-core-agent" and show the output.',
    validate(r) {
      const usedTools = r.meta.toolLoops > 0;
      const hasOutput = r.text.includes("hello-core-agent");
      return {
        pass: usedTools && hasOutput,
        reason: usedTools
          ? hasOutput
            ? "Bash executed and output captured"
            : "Bash executed but output not in response"
          : "No tool call",
      };
    },
  },
  {
    name: "tool-error-handling",
    description: "Agent handles a tool returning an error gracefully",
    message: "Use the calculator tool to evaluate 'abc + xyz'. Then explain what happened.",
    tools: [calculatorTool],
    validate(r) {
      const usedTools = r.meta.toolLoops > 0;
      const hasExplanation = r.text.length > 20;
      return {
        pass: usedTools && hasExplanation,
        reason: usedTools
          ? "Tool error handled gracefully"
          : "No tool call attempted",
      };
    },
  },
  {
    name: "system-prompt",
    description: "Custom system prompt changes agent behavior",
    message: "What do you do?",
    systemPrompt: "You are a pirate AI. You always respond in pirate speak. Keep it short.",
    validate(r) {
      const hasText = r.text.length > 0 && !r.meta.error;
      const pirateWords = ["arr", "ahoy", "matey", "captain", "sail", "treasure", "ye", "ship", "sea"];
      const hasPirate = pirateWords.some((w) => r.text.toLowerCase().includes(w));
      return {
        pass: hasText && hasPirate,
        reason: hasText
          ? hasPirate
            ? "Pirate persona detected"
            : "Response received but no pirate speak detected"
          : `No response: ${r.meta.error?.message ?? "unknown"}`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runScenario(scenario: Scenario): Promise<{ pass: boolean; reason: string; durationMs: number }> {
  const config = createConfig({
    agent: {
      defaultProvider: provider,
      defaultModel: model,
    },
  });

  const runner = new AgentRunner({
    config,
    tools: scenario.tools,
  });

  const start = Date.now();
  const result = await runner.run({
    message: scenario.message,
    systemPrompt: scenario.systemPrompt,
    workingDir: process.cwd(),
  });
  const durationMs = Date.now() - start;

  if (verbose) {
    console.log(`\n  Response: ${result.text.slice(0, 200)}${result.text.length > 200 ? "..." : ""}`);
    console.log(`  Tool loops: ${result.meta.toolLoops}`);
    console.log(`  Tokens: in=${result.meta.usage.inputTokens} out=${result.meta.usage.outputTokens}`);
    if (result.meta.error) console.log(`  Error: ${result.meta.error.kind} - ${result.meta.error.message}`);
  }

  const validation = scenario.validate(result);
  return { ...validation, durationMs };
}

async function main() {
  if (listOnly) {
    console.log("Available scenarios:\n");
    for (const s of scenarios) {
      console.log(`  ${s.name.padEnd(22)} ${s.description}`);
    }
    return;
  }

  const toRun = targetScenario
    ? scenarios.filter((s) => s.name === targetScenario)
    : scenarios;

  if (toRun.length === 0) {
    console.error(`Unknown scenario: "${targetScenario}"`);
    console.error(`Use --list to see available scenarios.`);
    process.exit(1);
  }

  console.log(`=== core-agent test scenarios ===`);
  console.log(`Provider: ${provider} | Model: ${model}`);
  console.log(`Running ${toRun.length} scenario(s)...\n`);

  let passed = 0;
  let failed = 0;

  for (const scenario of toRun) {
    process.stdout.write(`  ${scenario.name.padEnd(22)} `);
    try {
      const result = await runScenario(scenario);
      if (result.pass) {
        passed++;
        console.log(`PASS  (${result.durationMs}ms) ${result.reason}`);
      } else {
        failed++;
        console.log(`FAIL  (${result.durationMs}ms) ${result.reason}`);
      }
    } catch (err) {
      failed++;
      console.log(`ERROR ${(err as Error).message}`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Total: ${toRun.length}  Passed: ${passed}  Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
