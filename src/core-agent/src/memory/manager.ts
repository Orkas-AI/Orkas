import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import type { MemoryConfig } from "../config/schema.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { cosineSimilarity } from "./embeddings.js";
import { bm25Score, mergeHybridResults, extractKeywords } from "./hybrid.js";
import { chunkText, truncateSnippet, type TextChunk } from "./text-chunking.js";
import type { MemorySearchManager, MemorySearchResult, MemoryProviderStatus } from "./types.js";

const log = createLogger("memory");
const SNIPPET_MAX_CHARS = 700;

type IndexedChunk = TextChunk & {
  filePath: string;
  embedding?: number[];
};

/**
 * MemoryIndexManager provides hybrid (vector + keyword) search over
 * a directory of markdown/text memory files.
 *
 * Inspired by OpenClaw's MemoryIndexManager (`src/memory/manager.ts`)
 * but simplified to use in-memory storage instead of SQLite/sqlite-vec.
 */
export class MemoryIndexManager implements MemorySearchManager {
  private readonly memoryDir: string;
  private readonly config: MemoryConfig;
  private embeddingProvider: EmbeddingProvider | null;
  private chunks: IndexedChunk[] = [];
  private fileIndex: Map<string, string> = new Map(); // relPath -> content
  private initialized = false;

  constructor(opts: {
    memoryDir: string;
    config: MemoryConfig;
    embeddingProvider?: EmbeddingProvider | null;
  }) {
    this.memoryDir = path.resolve(opts.memoryDir);
    this.config = opts.config;
    this.embeddingProvider = opts.embeddingProvider ?? null;
  }

  /** Initialize and index all memory files. */
  async sync(params?: { force?: boolean }): Promise<void> {
    if (this.initialized && !params?.force) return;

    log.info(`Syncing memory from: ${this.memoryDir}`);
    this.chunks = [];
    this.fileIndex.clear();

    try {
      await this.indexDirectory(this.memoryDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log.warn(`Memory directory not found: ${this.memoryDir}`);
      } else {
        throw err;
      }
    }

    // Generate embeddings for all chunks if provider is available
    if (this.embeddingProvider && this.config.vector.enabled) {
      await this.embedAllChunks();
    }

    this.initialized = true;
    log.info(`Indexed ${this.chunks.length} chunks from ${this.fileIndex.size} files`);
  }

  /** Search memory using hybrid vector + keyword search. */
  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]> {
    if (!this.initialized) {
      await this.sync();
    }

    const maxResults = opts?.maxResults ?? this.config.maxResults;
    const minScore = opts?.minScore ?? this.config.minScore;

    const vectorResults = await this.searchVector(query, maxResults * 2);
    const keywordResults = this.searchKeyword(query, maxResults * 2);

    let results: MemorySearchResult[];

    if (vectorResults.length > 0 && keywordResults.length > 0) {
      results = mergeHybridResults(vectorResults, keywordResults);
    } else if (vectorResults.length > 0) {
      results = vectorResults;
    } else {
      results = keywordResults;
    }

    return results
      .filter((r) => r.score >= minScore)
      .slice(0, maxResults);
  }

  /** Read a file from the memory directory. */
  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const fullPath = path.join(this.memoryDir, params.relPath);
    const content = await fs.readFile(fullPath, "utf-8");

    if (params.from !== undefined || params.lines !== undefined) {
      const allLines = content.split("\n");
      const start = (params.from ?? 1) - 1;
      const count = params.lines ?? allLines.length;
      const text = allLines.slice(start, start + count).join("\n");
      return { text, path: fullPath };
    }

    return { text: content, path: fullPath };
  }

  /** Get status information about the memory subsystem. */
  status(): MemoryProviderStatus {
    return {
      provider: this.embeddingProvider?.id ?? "none",
      model: this.embeddingProvider?.model,
      files: this.fileIndex.size,
      chunks: this.chunks.length,
      fts: { enabled: this.config.fts.enabled },
      vector: {
        enabled: this.config.vector.enabled,
        dims: this.chunks[0]?.embedding?.length,
      },
    };
  }

  /** Close the memory manager and free resources. */
  async close(): Promise<void> {
    this.chunks = [];
    this.fileIndex.clear();
    this.initialized = false;
  }

  /** Set or replace the embedding provider. */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
  }

  private async indexDirectory(dir: string, prefix = ""): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await this.indexDirectory(fullPath, relPath);
      } else if (this.isIndexableFile(entry.name)) {
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          this.fileIndex.set(relPath, content);

          const textChunks = chunkText(content);
          for (const chunk of textChunks) {
            this.chunks.push({ ...chunk, filePath: relPath });
          }
        } catch (err) {
          log.warn(`Failed to index file: ${relPath}: ${(err as Error).message}`);
        }
      }
    }
  }

  private isIndexableFile(name: string): boolean {
    const ext = path.extname(name).toLowerCase();
    return [".md", ".txt", ".mdx", ".markdown", ".rst", ".org"].includes(ext);
  }

  private async embedAllChunks(): Promise<void> {
    if (!this.embeddingProvider || this.chunks.length === 0) return;

    log.info(`Generating embeddings for ${this.chunks.length} chunks...`);

    // Batch embed in groups of 100
    const batchSize = 100;
    for (let i = 0; i < this.chunks.length; i += batchSize) {
      const batch = this.chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.text);

      try {
        const embeddings = await this.embeddingProvider.embedBatch(texts);
        for (let j = 0; j < batch.length; j++) {
          batch[j].embedding = embeddings[j];
        }
      } catch (err) {
        log.warn(`Embedding batch failed: ${(err as Error).message}`);
      }
    }
  }

  private async searchVector(
    query: string,
    limit: number,
  ): Promise<MemorySearchResult[]> {
    if (!this.embeddingProvider || !this.config.vector.enabled) return [];

    const chunksWithEmbeddings = this.chunks.filter((c) => c.embedding);
    if (chunksWithEmbeddings.length === 0) return [];

    try {
      const queryVec = await this.embeddingProvider.embedQuery(query);

      const scored = chunksWithEmbeddings.map((chunk) => ({
        chunk,
        score: cosineSimilarity(queryVec, chunk.embedding!),
      }));

      scored.sort((a, b) => b.score - a.score);

      return scored.slice(0, limit).map(({ chunk, score }) => ({
        path: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score,
        snippet: truncateSnippet(chunk.text, SNIPPET_MAX_CHARS),
        source: "memory" as const,
      }));
    } catch (err) {
      log.warn(`Vector search failed: ${(err as Error).message}`);
      return [];
    }
  }

  private searchKeyword(query: string, limit: number): MemorySearchResult[] {
    if (!this.config.fts.enabled || this.chunks.length === 0) return [];

    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];

    const avgDocLen =
      this.chunks.reduce((sum, c) => sum + c.text.length, 0) / this.chunks.length;

    const scored = this.chunks.map((chunk) => ({
      chunk,
      score: bm25Score(query, chunk.text, { avgDocLen }),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored
      .filter((s) => s.score > 0)
      .slice(0, limit)
      .map(({ chunk, score }) => ({
        path: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score,
        snippet: truncateSnippet(chunk.text, SNIPPET_MAX_CHARS),
        source: "memory" as const,
      }));
  }
}
