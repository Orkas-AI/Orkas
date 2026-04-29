import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SqliteMemoryManager } from "../src/memory/sqlite-manager.js";
import { createConfig } from "../src/config/loader.js";

describe("SqliteMemoryManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-sqlite-mem-"));

    await fs.writeFile(
      path.join(tmpDir, "project-notes.md"),
      [
        "# Project Notes",
        "",
        "The core-agent project is a simplified extraction from OpenClaw.",
        "It provides LLM interaction, agent harness, and memory system.",
        "",
        "## Architecture",
        "",
        "The project has three main modules:",
        "1. Providers - LLM API interaction (Anthropic, OpenAI)",
        "2. Agent Runner - execution loop with tool use",
        "3. Memory - hybrid vector + keyword search",
      ].join("\n"),
    );

    await fs.writeFile(
      path.join(tmpDir, "meeting-notes.md"),
      [
        "# Meeting Notes 2024-01-15",
        "",
        "Discussed the database migration timeline.",
        "Decided to use PostgreSQL instead of SQLite for production.",
        "Alice will handle the schema changes.",
        "Bob is working on the API endpoints.",
      ].join("\n"),
    );

    await fs.mkdir(path.join(tmpDir, "subdir"));
    await fs.writeFile(
      path.join(tmpDir, "subdir", "deep-note.txt"),
      "This is a deeply nested note about TypeScript best practices.",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it("syncs and indexes files into SQLite", async () => {
    const config = createConfig();
    const manager = new SqliteMemoryManager({
      memoryDir: tmpDir,
      config: config.memory,
      dbPath: path.join(tmpDir, ".test.db"),
    });

    await manager.sync();
    const status = manager.status();

    expect(status.files).toBe(3);
    expect(status.chunks).toBeGreaterThan(0);
    expect(status.provider).toBe("none");

    await manager.close();
  });

  it("searches with FTS5 keyword matching", async () => {
    const config = createConfig();
    const manager = new SqliteMemoryManager({
      memoryDir: tmpDir,
      config: config.memory,
      dbPath: path.join(tmpDir, ".test.db"),
    });

    await manager.sync();
    const results = await manager.search("database migration PostgreSQL");

    expect(results.length).toBeGreaterThan(0);
    const meetingResult = results.find((r) => r.path.includes("meeting"));
    expect(meetingResult).toBeDefined();

    await manager.close();
  });

  it("reads a specific file", async () => {
    const config = createConfig();
    const manager = new SqliteMemoryManager({
      memoryDir: tmpDir,
      config: config.memory,
      dbPath: path.join(tmpDir, ".test.db"),
    });

    const result = await manager.readFile({ relPath: "project-notes.md" });
    expect(result.text).toContain("core-agent");
    expect(result.path).toContain("project-notes.md");

    await manager.close();
  });

  it("reads a file with line range", async () => {
    const config = createConfig();
    const manager = new SqliteMemoryManager({
      memoryDir: tmpDir,
      config: config.memory,
      dbPath: path.join(tmpDir, ".test.db"),
    });

    const result = await manager.readFile({ relPath: "project-notes.md", from: 1, lines: 3 });
    const lines = result.text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);

    await manager.close();
  });

  it("persists data across close/reopen", async () => {
    const config = createConfig();
    const dbPath = path.join(tmpDir, ".test.db");

    // First session
    const manager1 = new SqliteMemoryManager({
      memoryDir: tmpDir,
      config: config.memory,
      dbPath,
    });
    await manager1.sync();
    expect(manager1.status().files).toBe(3);
    await manager1.close();

    // Second session — should already have data
    const manager2 = new SqliteMemoryManager({
      memoryDir: tmpDir,
      config: config.memory,
      dbPath,
    });
    await manager2.sync(); // Should skip unchanged files
    expect(manager2.status().files).toBe(3);

    await manager2.close();
  });

  it("force re-syncs and picks up new files", async () => {
    const config = createConfig();
    const dbPath = path.join(tmpDir, ".test.db");

    const manager = new SqliteMemoryManager({
      memoryDir: tmpDir,
      config: config.memory,
      dbPath,
    });

    await manager.sync();
    expect(manager.status().files).toBe(3);

    // Add a new file
    await fs.writeFile(path.join(tmpDir, "new-note.md"), "A brand new note");

    // Normal sync picks up new file (since it wasn't indexed before)
    await manager.sync({ force: true });
    expect(manager.status().files).toBe(4);

    await manager.close();
  });

  it("handles non-existent memory directory", async () => {
    const config = createConfig();
    const manager = new SqliteMemoryManager({
      memoryDir: path.join(tmpDir, "nonexistent"),
      config: config.memory,
      dbPath: path.join(tmpDir, ".test.db"),
    });

    await manager.sync();
    expect(manager.status().files).toBe(0);

    await manager.close();
  });

  it("indexes files in subdirectories", async () => {
    const config = createConfig();
    const manager = new SqliteMemoryManager({
      memoryDir: tmpDir,
      config: config.memory,
      dbPath: path.join(tmpDir, ".test.db"),
    });

    await manager.sync();
    const results = await manager.search("TypeScript best practices");
    expect(results.length).toBeGreaterThan(0);

    await manager.close();
  });
});
