import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryIndexManager } from "../src/memory/manager.js";
import { cosineSimilarity, normalizeVector } from "../src/memory/embeddings.js";
import { chunkText, truncateSnippet } from "../src/memory/text-chunking.js";
import { bm25Score, mergeHybridResults, extractKeywords } from "../src/memory/hybrid.js";
import { createConfig } from "../src/config/loader.js";

describe("Memory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-memory-"));

    // Create test memory files
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

  describe("MemoryIndexManager", () => {
    it("syncs and indexes files from directory", async () => {
      const config = createConfig();
      const manager = new MemoryIndexManager({
        memoryDir: tmpDir,
        config: config.memory,
      });

      await manager.sync();
      const status = manager.status();

      expect(status.files).toBe(3);
      expect(status.chunks).toBeGreaterThan(0);
      expect(status.provider).toBe("none");
    });

    it("searches with keyword matching", async () => {
      const config = createConfig();
      const manager = new MemoryIndexManager({
        memoryDir: tmpDir,
        config: config.memory,
      });

      await manager.sync();
      const results = await manager.search("database migration PostgreSQL");

      expect(results.length).toBeGreaterThan(0);
      // The meeting notes should rank high
      const meetingResult = results.find((r) => r.path.includes("meeting"));
      expect(meetingResult).toBeDefined();
    });

    it("reads a specific file", async () => {
      const config = createConfig();
      const manager = new MemoryIndexManager({
        memoryDir: tmpDir,
        config: config.memory,
      });

      const result = await manager.readFile({ relPath: "project-notes.md" });
      expect(result.text).toContain("core-agent");
      expect(result.path).toContain("project-notes.md");
    });

    it("reads a file with line range", async () => {
      const config = createConfig();
      const manager = new MemoryIndexManager({
        memoryDir: tmpDir,
        config: config.memory,
      });

      const result = await manager.readFile({ relPath: "project-notes.md", from: 1, lines: 3 });
      const lines = result.text.split("\n");
      expect(lines.length).toBeLessThanOrEqual(3);
    });

    it("indexes files in subdirectories", async () => {
      const config = createConfig();
      const manager = new MemoryIndexManager({
        memoryDir: tmpDir,
        config: config.memory,
      });

      await manager.sync();
      const results = await manager.search("TypeScript best practices");
      expect(results.length).toBeGreaterThan(0);
    });

    it("handles non-existent memory directory", async () => {
      const config = createConfig();
      const manager = new MemoryIndexManager({
        memoryDir: path.join(tmpDir, "nonexistent"),
        config: config.memory,
      });

      // Should not throw
      await manager.sync();
      const status = manager.status();
      expect(status.files).toBe(0);
    });

    it("closes and resets state", async () => {
      const config = createConfig();
      const manager = new MemoryIndexManager({
        memoryDir: tmpDir,
        config: config.memory,
      });

      await manager.sync();
      expect(manager.status().files).toBeGreaterThan(0);

      await manager.close();
      expect(manager.status().files).toBe(0);
    });

    it("force re-syncs on demand", async () => {
      const config = createConfig();
      const manager = new MemoryIndexManager({
        memoryDir: tmpDir,
        config: config.memory,
      });

      await manager.sync();
      const initialFiles = manager.status().files;

      // Add a new file
      await fs.writeFile(path.join(tmpDir, "new-note.md"), "A brand new note");

      // Without force, should not re-index
      await manager.sync();
      expect(manager.status().files).toBe(initialFiles);

      // With force, should re-index
      await manager.sync({ force: true });
      expect(manager.status().files).toBe(initialFiles + 1);
    });
  });

  describe("Embeddings utilities", () => {
    it("normalizeVector produces unit vector", () => {
      const vec = [3, 4]; // magnitude = 5
      const norm = normalizeVector(vec);
      const magnitude = Math.sqrt(norm.reduce((s, v) => s + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 5);
    });

    it("normalizeVector handles zero vector", () => {
      const vec = [0, 0, 0];
      const norm = normalizeVector(vec);
      expect(norm).toEqual([0, 0, 0]);
    });

    it("cosineSimilarity of identical vectors is 1", () => {
      const vec = [1, 0, 0];
      expect(cosineSimilarity(vec, vec)).toBeCloseTo(1, 5);
    });

    it("cosineSimilarity of orthogonal vectors is 0", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });

    it("cosineSimilarity of opposite vectors is -1", () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
    });
  });

  describe("Text chunking", () => {
    it("chunks text into pieces", () => {
      const text = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n");
      const chunks = chunkText(text, { chunkSize: 200 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].text).toContain("Line 1");
    });

    it("handles empty text", () => {
      expect(chunkText("")).toEqual([]);
    });

    it("produces single chunk for small text", () => {
      const chunks = chunkText("Hello world");
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("Hello world");
    });

    it("truncateSnippet respects maxChars", () => {
      const long = "a".repeat(1000);
      const truncated = truncateSnippet(long, 100);
      expect(truncated.length).toBeLessThanOrEqual(103); // 100 + "..."
    });

    it("truncateSnippet keeps short text unchanged", () => {
      expect(truncateSnippet("short", 100)).toBe("short");
    });
  });

  describe("Hybrid search", () => {
    it("bm25Score returns positive score for matching terms", () => {
      const score = bm25Score("database migration", "Discussed the database migration timeline.");
      expect(score).toBeGreaterThan(0);
    });

    it("bm25Score returns 0 for non-matching terms", () => {
      const score = bm25Score("quantum physics", "Discussed the database migration timeline.");
      expect(score).toBe(0);
    });

    it("extractKeywords removes stop words", () => {
      const keywords = extractKeywords("What is the database migration timeline?");
      expect(keywords).toContain("database");
      expect(keywords).toContain("migration");
      expect(keywords).toContain("timeline");
      expect(keywords).not.toContain("what");
      expect(keywords).not.toContain("is");
      expect(keywords).not.toContain("the");
    });

    it("mergeHybridResults combines and deduplicates", () => {
      const vectorResults = [
        { path: "a.md", startLine: 1, endLine: 5, score: 0.9, snippet: "text a", source: "memory" as const },
        { path: "b.md", startLine: 1, endLine: 5, score: 0.7, snippet: "text b", source: "memory" as const },
      ];
      const keywordResults = [
        { path: "b.md", startLine: 1, endLine: 5, score: 0.8, snippet: "text b", source: "memory" as const },
        { path: "c.md", startLine: 1, endLine: 5, score: 0.6, snippet: "text c", source: "memory" as const },
      ];

      const merged = mergeHybridResults(vectorResults, keywordResults);

      expect(merged.length).toBe(3); // a, b, c (b deduplicated)
      const paths = merged.map((r) => r.path);
      expect(paths).toContain("a.md");
      expect(paths).toContain("b.md");
      expect(paths).toContain("c.md");
    });
  });
});
