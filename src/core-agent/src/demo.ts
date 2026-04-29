/**
 * Demo: shows how to use core-agent to run an AI agent with tool use.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/demo.ts
 *   OPENAI_API_KEY=sk-... npx tsx src/demo.ts --provider openai --model gpt-4o
 */
import { createConfig } from "./config/index.js";
import { AgentRunner } from "./agent/index.js";
import { defineTool } from "./tools/index.js";

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const provider = getArg("provider", "anthropic");
const model = getArg("model", provider === "openai" ? "gpt-4o" : "claude-sonnet-4-20250514");
const message = getArg("message", "What is 2 + 2? Then use the calculator tool to verify.");

// Create a custom calculator tool
const calculatorTool = defineTool({
  name: "calculator",
  description: "Evaluate a mathematical expression and return the result.",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Mathematical expression to evaluate (e.g., '2 + 2')." },
    },
    required: ["expression"],
  },
  async execute(input) {
    const expr = input.expression as string;
    try {
      // Simple safe evaluation for basic math
      const sanitized = expr.replace(/[^0-9+\-*/().%\s]/g, "");
      if (sanitized !== expr) {
        return { content: `Invalid expression: contains unsupported characters`, isError: true };
      }
      const result = Function(`"use strict"; return (${sanitized})`)();
      return { content: `${expr} = ${result}` };
    } catch (err) {
      return { content: `Calculator error: ${(err as Error).message}`, isError: true };
    }
  },
});

async function main() {
  console.log("=== Core Agent Demo ===\n");
  console.log(`Provider: ${provider}`);
  console.log(`Model: ${model}`);
  console.log(`Message: ${message}\n`);

  const config = createConfig({
    agent: {
      defaultProvider: provider,
      defaultModel: model,
    },
  });

  const runner = new AgentRunner({
    config,
    tools: [calculatorTool],
  });

  console.log("Running agent...\n");

  const result = await runner.run({ message });

  console.log("--- Response ---");
  console.log(result.text);
  console.log("\n--- Meta ---");
  console.log(`Duration: ${result.meta.durationMs}ms`);
  console.log(`Model: ${result.meta.model}`);
  console.log(`Provider: ${result.meta.provider}`);
  console.log(`Tool loops: ${result.meta.toolLoops}`);
  console.log(`Usage: ${JSON.stringify(result.meta.usage)}`);

  if (result.meta.error) {
    console.log(`Error: ${result.meta.error.kind} - ${result.meta.error.message}`);
  }
}

main().catch(console.error);
