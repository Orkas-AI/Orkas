import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillStore, parseFrontmatter, serializeFrontmatter } from "../src/evolution/skill-store.js";
import { createSkillManageTool } from "../src/evolution/skill-tools.js";
import type { EvolutionConfig } from "../src/evolution/types.js";
import type { AgentRunResult } from "../src/agent/types.js";
import type { ToolContext } from "../src/tools/base.js";
import { AgentRunner } from "../src/agent/runner.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { createConfig } from "../src/config/loader.js";
import { defineTool } from "../src/tools/base.js";
import type { LLMProvider, CompletionResult } from "../src/providers/base.js";

// ���─ Helpers ──

const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  skillsDir: "", // overridden per test
  maxSkills: 200,
  maxSkillContentLength: 100_000,
  metacognition: {
    enabled: false,
    reflectThreshold: 0.7,
    competenceCharLimit: 3000,
    strategiesCharLimit: 2500,
  },
};

let tmpDir: string;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-evo-test-"));
  return tmpDir;
}

async function cleanTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function makeConfig(skillsDir: string): EvolutionConfig {
  return { ...DEFAULT_EVOLUTION_CONFIG, skillsDir };
}

function makeRunResult(overrides: Partial<AgentRunResult["meta"]> = {}): AgentRunResult {
  return {
    text: "Task completed",
    content: [{ type: "text", text: "Task completed" }],
    meta: {
      durationMs: 1000,
      model: "test-model",
      provider: "test",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      toolLoops: 0,
      compactionCount: 0,
      ...overrides,
    },
  };
}

function createMockProvider(responses: CompletionResult[]): LLMProvider {
  let callIdx = 0;
  const pick = () =>
    callIdx >= responses.length ? responses[responses.length - 1] : responses[callIdx++];
  return {
    id: "mock",
    name: "Mock Provider",
    async complete(): Promise<CompletionResult> {
      return pick();
    },
    async *stream() {
      const r = pick();
      yield { type: "message_start" as const };
      for (const c of r.content) {
        if (c.type === "text") {
          yield { type: "text_delta" as const, text: c.text };
        } else if (c.type === "tool_use") {
          yield { type: "tool_use_start" as const, id: c.id, name: c.name };
          yield { type: "tool_use_delta" as const, id: c.id, input: JSON.stringify(c.input) };
          yield { type: "tool_use_end" as const, id: c.id };
        }
      }
      yield {
        type: "message_end" as const,
        stopReason: r.stopReason,
        usage: r.usage,
        content: r.content,
        model: r.model,
      };
    },
    async validateAuth() { return true; },
  };
}

// ── Tests ──

describe("Evolution: parseFrontmatter / serializeFrontmatter", () => {
  it("round-trips frontmatter correctly", () => {
    const fm = {
      name: "test-skill",
      description: "A test skill",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      patchCount: 3,
      tags: ["devops", "docker"],
    };

    const serialized = serializeFrontmatter(fm);
    const body = "## Steps\n1. Do this\n2. Do that\n";
    const raw = serialized + body;

    const parsed = parseFrontmatter(raw);
    expect(parsed.frontmatter.name).toBe("test-skill");
    expect(parsed.frontmatter.description).toBe("A test skill");
    expect(parsed.frontmatter.patchCount).toBe(3);
    expect(parsed.frontmatter.tags).toEqual(["devops", "docker"]);
    expect(parsed.body).toBe(body);
  });

  it("parses frontmatter without tags", () => {
    const raw = [
      "---",
      'name: "no-tags"',
      'description: "No tags here"',
      'createdAt: "2025-01-01T00:00:00.000Z"',
      'updatedAt: "2025-01-01T00:00:00.000Z"',
      "patchCount: 0",
      "---",
      "Body content here.",
    ].join("\n");

    const parsed = parseFrontmatter(raw);
    expect(parsed.frontmatter.name).toBe("no-tags");
    expect(parsed.frontmatter.tags).toBeUndefined();
    expect(parsed.body).toBe("Body content here.");
  });

  it("throws on missing frontmatter", () => {
    expect(() => parseFrontmatter("Just some text")).toThrow("missing YAML frontmatter");
  });
});

describe("Evolution: SkillStore", () => {
  let store: SkillStore;
  let skillsDir: string;

  beforeEach(async () => {
    const dir = await makeTmpDir();
    skillsDir = path.join(dir, "skills");
    store = new SkillStore(skillsDir, makeConfig(skillsDir));
    await store.init();
  });

  afterEach(cleanTmpDir);

  it("starts with no skills", async () => {
    const skills = await store.list();
    expect(skills).toEqual([]);
  });

  it("creates and reads a skill", async () => {
    const skill = await store.create({
      id: "docker-deploy",
      name: "Docker Deploy",
      description: "Deploy services via Docker Compose",
      body: "## Steps\n1. Build images\n2. Push to registry\n3. Deploy\n",
      tags: ["devops"],
    });

    expect(skill.id).toBe("docker-deploy");
    expect(skill.frontmatter.name).toBe("Docker Deploy");
    expect(skill.frontmatter.patchCount).toBe(0);

    const read = await store.read("docker-deploy");
    expect(read).not.toBeNull();
    expect(read!.body).toContain("Build images");
  });

  it("lists created skills", async () => {
    await store.create({
      id: "alpha-skill",
      name: "Alpha",
      description: "First skill",
      body: "Body A",
    });
    await store.create({
      id: "beta-skill",
      name: "Beta",
      description: "Second skill",
      body: "Body B",
    });

    const skills = await store.list();
    expect(skills).toHaveLength(2);
    expect(skills[0].id).toBe("alpha-skill");
    expect(skills[1].id).toBe("beta-skill");
  });

  it("patches a skill body", async () => {
    await store.create({
      id: "patchable",
      name: "Patchable",
      description: "A patchable skill",
      body: "Step 1: Run `npm install`\nStep 2: Run `npm test`\n",
    });

    const patched = await store.patch(
      "patchable",
      "npm install",
      "npm ci",
    );

    expect(patched.body).toContain("npm ci");
    expect(patched.body).not.toContain("npm install");
    expect(patched.frontmatter.patchCount).toBe(1);
  });

  it("patch replaceAll works", async () => {
    await store.create({
      id: "multi-replace",
      name: "Multi Replace",
      description: "Test replace all",
      body: "Use foo. Then foo again. And foo once more.",
    });

    const patched = await store.patch("multi-replace", "foo", "bar", true);
    expect(patched.body).toBe("Use bar. Then bar again. And bar once more.");
  });

  it("patch throws when old_string not found", async () => {
    await store.create({
      id: "no-match",
      name: "No Match",
      description: "Test no match",
      body: "Some content here",
    });

    await expect(
      store.patch("no-match", "nonexistent text", "replacement"),
    ).rejects.toThrow("old_string not found");
  });

  it("patch throws when old_string equals new_string", async () => {
    await store.create({
      id: "same-str",
      name: "Same Str",
      description: "Test same strings",
      body: "Some content",
    });

    await expect(
      store.patch("same-str", "content", "content"),
    ).rejects.toThrow("identical");
  });

  it("deletes a skill", async () => {
    await store.create({
      id: "deletable",
      name: "Deletable",
      description: "Will be deleted",
      body: "Body",
    });

    const deleted = await store.delete("deletable");
    expect(deleted).toBe(true);

    const read = await store.read("deletable");
    expect(read).toBeNull();
  });

  it("delete returns false for non-existent skill", async () => {
    const deleted = await store.delete("nonexistent");
    expect(deleted).toBe(false);
  });

  it("read returns null for non-existent skill", async () => {
    const result = await store.read("nope");
    expect(result).toBeNull();
  });

  it("rejects duplicate skill id", async () => {
    await store.create({
      id: "unique",
      name: "Unique",
      description: "First",
      body: "Body",
    });

    await expect(
      store.create({ id: "unique", name: "Unique 2", description: "Dup", body: "Body" }),
    ).rejects.toThrow("already exists");
  });

  it("rejects invalid skill id", async () => {
    await expect(
      store.create({ id: "UPPER CASE", name: "Bad", description: "Bad", body: "Body" }),
    ).rejects.toThrow("Invalid skill id");
  });

  it("rejects empty name", async () => {
    await expect(
      store.create({ id: "good-id", name: "", description: "Desc", body: "Body" }),
    ).rejects.toThrow("cannot be empty");
  });

  it("rejects content exceeding max length", async () => {
    const config = makeConfig(skillsDir);
    config.maxSkillContentLength = 50;
    const smallStore = new SkillStore(skillsDir, config);

    await expect(
      smallStore.create({
        id: "too-long",
        name: "Too Long",
        description: "Too long content",
        body: "x".repeat(100),
      }),
    ).rejects.toThrow("too long");
  });

  it("evicts LRU skill when maxSkills reached", async () => {
    const config = makeConfig(skillsDir);
    config.maxSkills = 2;
    const limitedStore = new SkillStore(skillsDir, config);
    await limitedStore.init();

    await limitedStore.create({ id: "s1", name: "S1", description: "D1", body: "B1" });
    await limitedStore.create({ id: "s2", name: "S2", description: "D2", body: "B2" });

    // Touch s2 so s1 becomes LRU
    await limitedStore.touch("s2");

    const s3 = await limitedStore.create({ id: "s3", name: "S3", description: "D3", body: "B3" });
    expect(s3.id).toBe("s3");

    // s1 should have been evicted (oldest, never used)
    const remaining = await limitedStore.list();
    expect(remaining.map((s) => s.id).sort()).toEqual(["s2", "s3"]);
  });

  it("buildIndex returns formatted markdown", async () => {
    await store.create({
      id: "my-skill",
      name: "My Skill",
      description: "Does something useful",
      body: "Instructions here",
    });

    const index = await store.buildIndex();
    expect(index).toContain("My Skill");
    expect(index).toContain("my-skill");
    expect(index).toContain("Does something useful");
  });

  it("buildIndex returns empty string when no skills", async () => {
    const index = await store.buildIndex();
    expect(index).toBe("");
  });

  it("buildIndex filters by allowlist", async () => {
    await store.create({ id: "alpha", name: "Alpha", description: "A skill", body: "A" });
    await store.create({ id: "beta", name: "Beta", description: "B skill", body: "B" });
    await store.create({ id: "gamma", name: "Gamma", description: "C skill", body: "C" });

    const filtered = await store.buildIndex(["alpha", "gamma"]);
    expect(filtered).toContain("alpha");
    expect(filtered).toContain("gamma");
    expect(filtered).not.toContain("beta");

    const all = await store.buildIndex();
    expect(all).toContain("alpha");
    expect(all).toContain("beta");
    expect(all).toContain("gamma");

    const empty = await store.buildIndex([]);
    expect(empty).toBe("");
  });
});

describe("Evolution: skill_manage tool", () => {
  let store: SkillStore;
  let tool: ReturnType<typeof createSkillManageTool>;
  const ctx: ToolContext = { state: {} };

  beforeEach(async () => {
    const dir = await makeTmpDir();
    const skillsDir = path.join(dir, "skills");
    store = new SkillStore(skillsDir, makeConfig(skillsDir));
    await store.init();
    tool = createSkillManageTool(store);
  });

  afterEach(cleanTmpDir);

  it("list returns empty message when no skills", async () => {
    const result = await tool.execute({ action: "list" }, ctx);
    expect(result.content).toContain("No skills found");
  });

  it("create + list + read round trip", async () => {
    const createResult = await tool.execute(
      {
        action: "create",
        id: "test-skill",
        name: "Test Skill",
        description: "A test",
        body: "Do things step by step",
        tags: ["testing"],
      },
      ctx,
    );
    expect(createResult.content).toContain("Skill created");
    expect(createResult.isError).toBeUndefined();

    const listResult = await tool.execute({ action: "list" }, ctx);
    expect(listResult.content).toContain("test-skill");

    const readResult = await tool.execute({ action: "read", id: "test-skill" }, ctx);
    expect(readResult.content).toContain("Do things step by step");
  });

  it("patch via tool", async () => {
    await tool.execute(
      {
        action: "create",
        id: "patchme",
        name: "PatchMe",
        description: "Will be patched",
        body: "Use npm install",
      },
      ctx,
    );

    const result = await tool.execute(
      {
        action: "patch",
        id: "patchme",
        old_string: "npm install",
        new_string: "npm ci",
      },
      ctx,
    );
    expect(result.content).toContain("patched");

    const readResult = await tool.execute({ action: "read", id: "patchme" }, ctx);
    expect(readResult.content).toContain("npm ci");
  });

  it("delete via tool", async () => {
    await tool.execute(
      { action: "create", id: "bye", name: "Bye", description: "Bye", body: "Gone" },
      ctx,
    );

    const result = await tool.execute({ action: "delete", id: "bye" }, ctx);
    expect(result.content).toContain("deleted");

    const readResult = await tool.execute({ action: "read", id: "bye" }, ctx);
    expect(readResult.isError).toBe(true);
  });

  it("returns error for missing required fields on create", async () => {
    const result = await tool.execute({ action: "create", id: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error for unknown action", async () => {
    const result = await tool.execute({ action: "unknown" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("fires onCreated callback after successful create", async () => {
    const created: string[] = [];
    const toolWithCb = createSkillManageTool(store, (id) => { created.push(id); });

    await toolWithCb.execute({
      action: "create",
      id: "hooked",
      name: "Hooked",
      description: "Test callback",
      body: "body",
    }, ctx);

    expect(created).toEqual(["hooked"]);
  });

  it("does not fire onCreated callback when create fails validation", async () => {
    const created: string[] = [];
    const toolWithCb = createSkillManageTool(store, (id) => { created.push(id); });

    // Missing required fields → error, no callback
    const result = await toolWithCb.execute({ action: "create", id: "incomplete" }, ctx);
    expect(result.isError).toBe(true);
    expect(created).toEqual([]);
  });
});

describe("Evolution: AgentRunner integration", () => {
  let skillsDir: string;

  beforeEach(async () => {
    const dir = await makeTmpDir();
    skillsDir = path.join(dir, "skills");
  });

  afterEach(cleanTmpDir);

  it("registers skill_manage tool when evolution is enabled", async () => {
    const mockProvider = createMockProvider([
      {
        content: [{ type: "text", text: "Hello" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
      evolution: { enabled: true, skillsDir },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [] });
    expect(runner.getSkillStore()).not.toBeNull();
  });

  it("does not register skill tools when evolution is disabled", () => {
    const registry = new ProviderRegistry();
    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
      evolution: { enabled: false },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [] });
    expect(runner.getSkillStore()).toBeNull();
  });

  // Per-turn `evaluateReflection` path removed in the reflection redesign
  // (`Common/docs/plans/reflection-redesign.md` §2.4). Reflection now runs only
  // from the orchestrator (`features/reflection-orchestrator.ts`); the
  // runner no longer owns reflection triggering.

  it("agent can create a skill via tool call", async () => {
    const mockProvider = createMockProvider([
      // LLM calls skill_manage to create a skill
      {
        content: [
          { type: "text", text: "Let me save this as a skill." },
          {
            type: "tool_use",
            id: "call_1",
            name: "skill_manage",
            input: {
              action: "create",
              id: "docker-cleanup",
              name: "Docker Cleanup",
              description: "Clean up Docker resources",
              body: "## Steps\n1. docker system prune -af\n2. docker volume prune -f\n",
            },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
        model: "mock-model",
      },
      // After tool result, LLM responds
      {
        content: [{ type: "text", text: "I've saved the Docker cleanup procedure as a skill." }],
        stopReason: "end_turn",
        usage: { inputTokens: 80, outputTokens: 15, totalTokens: 95 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const store = new SkillStore(skillsDir, makeConfig(skillsDir));
    await store.init();

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
      evolution: { enabled: true, skillsDir },
    });

    const runner = new AgentRunner({
      config,
      providers: registry,
      tools: [],
      skillStore: store,
    });

    const result = await runner.run({ message: "Save the Docker cleanup as a skill" });
    expect(result.text).toContain("Docker cleanup");

    // Verify skill was actually created on disk
    const skill = await store.read("docker-cleanup");
    expect(skill).not.toBeNull();
    expect(skill!.frontmatter.name).toBe("Docker Cleanup");
    expect(skill!.body).toContain("docker system prune");
  });
});
