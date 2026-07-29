import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/runner.js";
import {
  REPOSITORY_INSTRUCTION_MAX_FILE_BYTES,
  discoverRepositoryInstructions,
  repositoryInstructionsText,
} from "../src/agent/repository-instructions.js";
import { createConfig } from "../src/config/loader.js";
import type { CompletionParams, CompletionResult, LLMProvider } from "../src/providers/base.js";
import { ProviderRegistry } from "../src/providers/registry.js";

const tempDirs: string[] = [];

function tempRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-agent-repository-instructions-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("repository instructions", () => {
  it("loads AGENTS.md from repository root to the nearest working directory", async () => {
    const root = tempRepository();
    const nested = path.join(root, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "root rule");
    fs.writeFileSync(path.join(root, "packages", "AGENTS.md"), "package rule");
    fs.writeFileSync(path.join(nested, "AGENTS.md"), "nearest rule");
    fs.mkdirSync(path.join(nested, "src"));
    fs.writeFileSync(path.join(nested, "src", "AGENTS.md"), "source subtree rule");
    fs.mkdirSync(path.join(nested, "node_modules", "ignored"), { recursive: true });
    fs.writeFileSync(path.join(nested, "node_modules", "ignored", "AGENTS.md"), "ignored rule");

    const discovered = await discoverRepositoryInstructions(nested);

    expect(discovered?.repositoryRoot).toBe(root);
    expect(discovered?.files.map((file) => file.content)).toEqual([
      "root rule",
      "package rule",
      "nearest rule",
      "source subtree rule",
    ]);
    const rendered = repositoryInstructionsText(discovered);
    expect(rendered.indexOf("root rule")).toBeLessThan(rendered.indexOf("nearest rule"));
    expect(rendered).toContain("source subtree rule");
    expect(rendered).not.toContain("ignored rule");
    expect(rendered).toContain(`scope: ${path.join(nested, "src")}`);
    expect(rendered).toContain(`Working directory: ${nested}`);
  });

  it("supports non-Git workspaces and bounds oversized instruction files", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "core-agent-no-repository-"));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, "AGENTS.md"), "standalone workspace rule");
    const standalone = await discoverRepositoryInstructions(outside);
    expect(standalone?.repositoryRoot).toBe(outside);
    expect(standalone?.files.map((file) => file.content)).toEqual([
      "standalone workspace rule",
    ]);

    const root = tempRepository();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(REPOSITORY_INSTRUCTION_MAX_FILE_BYTES + 100));
    const discovered = await discoverRepositoryInstructions(root);
    expect(discovered?.files[0].truncated).toBe(true);
    expect(Buffer.byteLength(discovered?.files[0].content ?? "", "utf8"))
      .toBeLessThanOrEqual(REPOSITORY_INSTRUCTION_MAX_FILE_BYTES);
  });

  it("adds repository facts and instructions to the model request without changing agent identity", async () => {
    const root = tempRepository();
    const nested = path.join(root, "src");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Use the repository formatter.");
    fs.mkdirSync(path.join(nested, "components"));
    fs.writeFileSync(
      path.join(nested, "components", "AGENTS.md"),
      "Component files must preserve stable ids.",
    );
    let capturedPrompt = "";
    const response: CompletionResult = {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: "mock-model",
    };
    const provider: LLMProvider = {
      id: "mock",
      name: "Mock Provider",
      async complete(): Promise<CompletionResult> { return response; },
      async *stream(params: CompletionParams) {
        capturedPrompt = params.systemPrompt ?? "";
        yield { type: "message_start" as const };
        yield { type: "text_delta" as const, text: "done" };
        yield {
          type: "message_end" as const,
          stopReason: response.stopReason,
          usage: response.usage,
          content: response.content,
          model: response.model,
        };
      },
      async validateAuth() { return true; },
    };
    const providers = new ProviderRegistry();
    providers.registerFactory("mock", () => provider);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model" } }),
      providers,
      tools: [],
    });

    await runner.run({
      message: "Handle the task",
      workingDir: nested,
      systemPrompt: "You are a helpful general assistant.",
    });

    expect(capturedPrompt).toContain("You are a helpful general assistant.");
    expect(capturedPrompt).toContain("Use the repository formatter.");
    expect(capturedPrompt).toContain("Component files must preserve stable ids.");
    expect(capturedPrompt).not.toContain("coding agent");
  });
});
