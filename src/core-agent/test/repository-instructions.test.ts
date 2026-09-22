import fs from "node:fs";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "../src/agent/session.js";
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
  vi.restoreAllMocks();
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

    const scan = vi.spyOn(fsp, "readdir");
    const discovered = await discoverRepositoryInstructions(nested);
    expect(scan).not.toHaveBeenCalled();

    expect(discovered?.repositoryRoot).toBe(root);
    expect(discovered?.files.map((file) => file.content)).toEqual([
      "root rule",
      "package rule",
      "nearest rule",
    ]);
    const rendered = repositoryInstructionsText(discovered);
    expect(rendered.indexOf("root rule")).toBeLessThan(rendered.indexOf("nearest rule"));
    expect(rendered).not.toContain("source subtree rule");
    expect(rendered).not.toContain("ignored rule");
    expect(rendered).toContain(`scope: ${nested}`);
    expect(rendered).toContain("Before modifying files in a deeper or other authorized directory");
    expect(rendered).toContain("a deeper applicable file takes precedence");
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

  it("reuses unchanged bodies but sees edited, newly created, and deleted ancestor rules", async () => {
    const root = tempRepository();
    const nested = path.join(root, "src");
    fs.mkdirSync(nested);
    const rootFile = path.join(root, "AGENTS.md");
    const localFile = path.join(nested, "AGENTS.md");
    fs.writeFileSync(rootFile, "first root rule");
    const session = new Session();
    const open = vi.spyOn(fsp, "open");
    const read = () => discoverRepositoryInstructions(nested, session);
    const first = await read();
    expect(first?.files.map(file => file.content)).toEqual(["first root rule"]);
    expect(await read()).toEqual(first);
    expect(open).toHaveBeenCalledTimes(1);
    // Mutating a returned context must not corrupt the reusable snapshot.
    first!.files[0].content = "caller mutation";
    expect((await read())?.files[0].content).toBe("first root rule");
    fs.writeFileSync(rootFile, "a changed root rule");
    expect((await read())?.files.map(file => file.content)).toEqual(["a changed root rule"]);
    fs.writeFileSync(localFile, "new local rule");
    expect((await read())?.files.map(file => file.content)).toEqual(["a changed root rule", "new local rule"]);
    fs.unlinkSync(rootFile);
    expect((await read())?.files.map(file => file.content)).toEqual(["new local rule"]);
    fs.unlinkSync(localFile);
    expect((await read())?.files).toEqual([]);
    fs.writeFileSync(localFile, "restored local rule");
    expect((await read())?.files.map(file => file.content)).toEqual(["restored local rule"]);
  });

  it("keeps snapshots session-local and refreshes scope after cwd and repository-root changes", async () => {
    const root = tempRepository();
    const nested = path.join(root, "package");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "outer rule");
    fs.writeFileSync(path.join(nested, "AGENTS.md"), "inner rule");
    const session = new Session();
    const open = vi.spyOn(fsp, "open");
    const first = await discoverRepositoryInstructions(root, session);
    expect(first?.files.map(file => file.content)).toEqual(["outer rule"]);
    // A new Session must reload rather than inherit another owner's cache.
    await discoverRepositoryInstructions(root, new Session());
    expect(open).toHaveBeenCalledTimes(2);
    expect((await discoverRepositoryInstructions(nested, session))?.files.map(file => file.content))
      .toEqual(["outer rule", "inner rule"]);
    fs.writeFileSync(path.join(nested, ".git"), "gitdir: ../worktree-metadata");
    const innerRepo = await discoverRepositoryInstructions(nested, session);
    expect(innerRepo?.repositoryRoot).toBe(nested);
    expect(innerRepo?.files.map(file => file.content)).toEqual(["inner rule"]);
    expect(await discoverRepositoryInstructions(undefined, session)).toBeUndefined();
    expect(repositoryInstructionsText(undefined)).toBe("");
    expect(await discoverRepositoryInstructions(path.join(root, "missing"), session)).toBeUndefined();
    expect((await discoverRepositoryInstructions(root, session))?.files.map(file => file.content)).toEqual(["outer rule"]);
  });

  it("drops inaccessible cached content and retries transient reads without a metadata change", async () => {
    const root = tempRepository();
    const file = path.join(root, "AGENTS.md");
    fs.writeFileSync(file, "recoverable rule");
    const session = new Session();
    await discoverRepositoryInstructions(root, session);
    const realStat = fsp.stat;
    const stat = vi.spyOn(fsp, "stat").mockImplementation(async (...args) => {
      if (String(args[0]) === file) throw Object.assign(new Error("permission fixture"), { code: "EACCES" });
      return realStat(...args);
    });
    const unavailable = await discoverRepositoryInstructions(root, session);
    expect(unavailable?.files).toEqual([]);
    expect(unavailable?.discoveryTruncated).toBe(true);
    expect(repositoryInstructionsText(unavailable)).toContain("Read missing or truncated applicable instructions");
    stat.mockRestore();
    const open = vi.spyOn(fsp, "open").mockRejectedValueOnce(Object.assign(new Error("read fixture"), { code: "EIO" }));
    expect((await discoverRepositoryInstructions(root, session))?.files).toEqual([]);
    expect((await discoverRepositoryInstructions(root, session))?.files.map(file => file.content)).toEqual(["recoverable rule"]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("keeps file-count and total-byte bounds on a deep chain and signals omitted instructions", async () => {
    const root = tempRepository();
    let nested = root;
    for (let index = 0; index < 18; index++) {
      fs.writeFileSync(path.join(nested, "AGENTS.md"), `rule ${index}`);
      nested = path.join(nested, "child");
      fs.mkdirSync(nested);
    }
    const session = new Session();
    const limited = await discoverRepositoryInstructions(nested, session);
    expect(limited?.files).toHaveLength(16);
    expect(limited?.discoveryTruncated).toBe(true);
    expect(await discoverRepositoryInstructions(nested, session)).toEqual(limited);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(32 * 1024));
    fs.writeFileSync(path.join(root, "child", "AGENTS.md"), "y".repeat(32 * 1024));
    const large = await discoverRepositoryInstructions(nested, session);
    expect(large?.files).toHaveLength(2);
    expect(large?.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)).toBe(64 * 1024);
    expect(large?.discoveryTruncated).toBe(true);
  });

  it("keeps ancestor instructions across rebuilt runners and delivers a requested deeper rule through the real file tool", async () => {
    const root = tempRepository();
    const nested = path.join(root, "src");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Use the repository formatter.");
    fs.mkdirSync(path.join(nested, "components"));
    fs.writeFileSync(
      path.join(nested, "components", "AGENTS.md"),
      "Component files must preserve stable ids.",
    );
    const captured: { prompt: string; messages: string }[] = [];
    const session = new Session();
    const open = vi.spyOn(fsp, "open");
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
        captured.push({ prompt: params.systemPrompt ?? "", messages: JSON.stringify(params.messages) });
        // This scripts a model decision; the real file tool must supply the
        // rule before the next model request. It is not a model-quality test.
        if (captured.length === 1) {
          yield { type: "message_start" as const };
          yield {
            type: "message_end" as const,
            stopReason: "tool_use" as const,
            usage: response.usage,
            model: response.model,
            content: [{ type: "tool_use" as const, id: "read-scope", name: "read_file", input: { path: path.join(nested, "components", "AGENTS.md") } }],
          };
          return;
        }
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
    const makeRunner = () => new AgentRunner({
      config: createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model" } }),
      providers,
      session,
      tools: [],
    });

    await makeRunner().run({
      message: "Handle the task",
      workingDir: nested,
      systemPrompt: "You are a helpful general assistant.",
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].prompt).toContain("You are a helpful general assistant.");
    expect(captured[0].prompt).toContain("Use the repository formatter.");
    expect(captured[0].prompt).toContain("Before modifying files in a deeper or other authorized directory");
    expect(captured[0].prompt).not.toContain("Component files must preserve stable ids.");
    expect(captured[0].prompt).not.toContain("coding agent");
    expect(captured[1].prompt).toBe(captured[0].prompt);
    expect(captured[1].messages).toContain("Component files must preserve stable ids.");
    const rootReads = () => open.mock.calls.filter(([file]) => String(file) === path.join(root, "AGENTS.md")).length;
    expect(rootReads()).toBe(1);
    await makeRunner().run({ message: "Continue the task", workingDir: nested, systemPrompt: "You are a helpful general assistant." });
    expect(captured).toHaveLength(3);
    expect(captured[2].prompt).toBe(captured[0].prompt);
    expect(rootReads()).toBe(1);
  });
});
