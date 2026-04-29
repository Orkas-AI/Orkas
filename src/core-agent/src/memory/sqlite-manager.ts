/**
 * SQLite-backed memory manager.
 *
 * Uses better-sqlite3 for persistent storage with FTS5 for full-text search
 * and optional vector similarity via stored embeddings.
 *
 * Inspired by OpenClaw's original MemoryIndexManager that used SQLite/sqlite-vec.
 */
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import type { MemoryConfig } from "../config/schema.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { cosineSimilarity } from "./embeddings.js";
import { chunkText, truncateSnippet } from "./text-chunking.js";
import { mergeHybridResults } from "./hybrid.js";
import type { MemorySearchManager, MemorySearchResult, MemoryProviderStatus } from "./types.js";

const log = createLogger("sqlite-memory");
const SNIPPET_MAX_CHARS = 700;

/**
 * SqliteMemoryManager provides persistent hybrid (vector + FTS5 keyword) search
 * over a directory of markdown/text memory files.
 *
 * Data is stored in a SQLite database, surviving process restarts.
 */
export class SqliteMemoryManager implements MemorySearchManager {
  private readonly memoryDir: string;
  private readonly config: MemoryConfig;
  private embeddingProvider: EmbeddingProvider | null;
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private initialized = false;

  constructor(opts: {
    memoryDir: string;
    config: MemoryConfig;
    embeddingProvider?: EmbeddingProvider | null;
    /** Path to the SQLite database file. Defaults to <memoryDir>/.memory.db */
    dbPath?: string;
  }) {
    this.memoryDir = path.resolve(opts.memoryDir);
    this.config = opts.config;
    this.embeddingProvider = opts.embeddingProvider ?? null;
    this.dbPath = opts.dbPath ?? path.join(this.memoryDir, ".memory.db");
  }

  /** Initialize the database and index all memory files. */
  async sync(params?: { force?: boolean }): Promise<void> {
    if (this.initialized && !params?.force) return;

    log.info(`Syncing memory from: ${this.memoryDir} (SQLite: ${this.dbPath})`);

    // Ensure memory directory exists
    try {
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    } catch {
      // ignore
    }

    this.openDatabase();

    if (params?.force) {
      // Drop and recreate tables
      this.db!.exec("DELETE FROM chunks");
      this.db!.exec("DELETE FROM files");
      this.db!.exec("DELETE FROM chunks_fts");
    }

    try {
      await this.indexDirectory(this.memoryDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log.warn(`Memory directory not found: ${this.memoryDir}`);
      } else {
        throw err;
      }
    }

    // Generate embeddings for chunks that don't have them
    if (this.embeddingProvider && this.config.vector.enabled) {
      await this.embedMissingChunks();
    }

    this.initialized = true;

    const stats = this.getStats();
    log.info(`Indexed ${stats.chunks} chunks from ${stats.files} files`);
  }

  /** Search memory using hybrid vector + FTS5 keyword search. */
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
    const keywordResults = this.searchFTS(query, maxResults * 2);

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
    const stats = this.getStats();
    return {
      provider: this.embeddingProvider?.id ?? "none",
      model: this.embeddingProvider?.model,
      files: stats.files,
      chunks: stats.chunks,
      fts: { enabled: this.config.fts.enabled },
      vector: {
        enabled: this.config.vector.enabled,
        dims: stats.embeddingDims,
      },
    };
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  /** Set or replace the embedding provider. */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private openDatabase(): void {
    if (this.db) return;

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        rel_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        text TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        embedding BLOB,
        FOREIGN KEY (file_path) REFERENCES files(rel_path) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);

      -- FTS5 virtual table for full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        content=chunks,
        content_rowid=id,
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  }

  private getStats(): { files: number; chunks: number; embeddingDims: number | undefined } {
    if (!this.db) return { files: 0, chunks: 0, embeddingDims: undefined };

    const fileCount = (this.db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
    const chunkCount = (this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;

    // Check embedding dimensions from first chunk that has one
    let embeddingDims: number | undefined;
    const row = this.db.prepare("SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1").get() as { embedding: Buffer } | undefined;
    if (row?.embedding) {
      embeddingDims = row.embedding.length / 4; // float32 = 4 bytes
    }

    return { files: fileCount, chunks: chunkCount, embeddingDims };
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
          const contentHash = this.hashContent(content);

          // Check if file already indexed with same hash
          const existing = this.db!.prepare(
            "SELECT content_hash FROM files WHERE rel_path = ?",
          ).get(relPath) as { content_hash: string } | undefined;

          if (existing?.content_hash === contentHash) {
            continue; // Already up to date
          }

          // Remove old data
          this.db!.prepare("DELETE FROM chunks WHERE file_path = ?").run(relPath);
          this.db!.prepare("DELETE FROM files WHERE rel_path = ?").run(relPath);

          // Insert file record
          this.db!.prepare(
            "INSERT INTO files (rel_path, content_hash, indexed_at) VALUES (?, ?, ?)",
          ).run(relPath, contentHash, Date.now());

          // Chunk and insert
          const chunks = chunkText(content);
          const insert = this.db!.prepare(
            "INSERT INTO chunks (file_path, text, start_line, end_line) VALUES (?, ?, ?, ?)",
          );

          for (const chunk of chunks) {
            insert.run(relPath, chunk.text, chunk.startLine, chunk.endLine);
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

  private hashContent(content: string): string {
    // Simple hash for change detection
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const chr = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  private async embedMissingChunks(): Promise<void> {
    if (!this.embeddingProvider) return;

    const rows = this.db!.prepare(
      "SELECT id, text FROM chunks WHERE embedding IS NULL",
    ).all() as Array<{ id: number; text: string }>;

    if (rows.length === 0) return;

    log.info(`Generating embeddings for ${rows.length} chunks...`);

    const batchSize = 100;
    const updateStmt = this.db!.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const texts = batch.map((r) => r.text);

      try {
        const embeddings = await this.embeddingProvider.embedBatch(texts);
        const transaction = this.db!.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            // Store as float32 buffer
            const buf = Buffer.alloc(embeddings[j].length * 4);
            for (let k = 0; k < embeddings[j].length; k++) {
              buf.writeFloatLE(embeddings[j][k], k * 4);
            }
            updateStmt.run(buf, batch[j].id);
          }
        });
        transaction();
      } catch (err) {
        log.warn(`Embedding batch failed: ${(err as Error).message}`);
      }
    }
  }

  private async searchVector(query: string, limit: number): Promise<MemorySearchResult[]> {
    if (!this.embeddingProvider || !this.config.vector.enabled || !this.db) return [];

    // Check if any chunks have embeddings
    const hasEmbeddings = this.db.prepare(
      "SELECT 1 FROM chunks WHERE embedding IS NOT NULL LIMIT 1",
    ).get();
    if (!hasEmbeddings) return [];

    try {
      const queryVec = await this.embeddingProvider.embedQuery(query);

      // Load all chunks with embeddings and compute similarity
      const rows = this.db.prepare(
        "SELECT id, file_path, text, start_line, end_line, embedding FROM chunks WHERE embedding IS NOT NULL",
      ).all() as Array<{
        id: number;
        file_path: string;
        text: string;
        start_line: number;
        end_line: number;
        embedding: Buffer;
      }>;

      const scored = rows.map((row) => {
        // Decode float32 buffer
        const vec: number[] = [];
        for (let i = 0; i < row.embedding.length; i += 4) {
          vec.push(row.embedding.readFloatLE(i));
        }
        return {
          path: row.file_path,
          startLine: row.start_line,
          endLine: row.end_line,
          score: cosineSimilarity(queryVec, vec),
          snippet: truncateSnippet(row.text, SNIPPET_MAX_CHARS),
          source: "memory" as const,
        };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    } catch (err) {
      log.warn(`Vector search failed: ${(err as Error).message}`);
      return [];
    }
  }

  private searchFTS(query: string, limit: number): MemorySearchResult[] {
    if (!this.config.fts.enabled || !this.db) return [];

    try {
      // Use FTS5 MATCH for keyword search
      const ftsQuery = query
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1)
        .join(" OR ");

      if (!ftsQuery) return [];

      const rows = this.db.prepare(`
        SELECT c.file_path, c.text, c.start_line, c.end_line,
               rank * -1 as score
        FROM chunks_fts fts
        JOIN chunks c ON c.id = fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{
        file_path: string;
        text: string;
        start_line: number;
        end_line: number;
        score: number;
      }>;

      // Normalize scores to 0-1 range
      const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.score)) : 1;

      return rows.map((row) => ({
        path: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: maxScore > 0 ? row.score / maxScore : 0,
        snippet: truncateSnippet(row.text, SNIPPET_MAX_CHARS),
        source: "memory" as const,
      }));
    } catch (err) {
      log.warn(`FTS search failed: ${(err as Error).message}`);
      return [];
    }
  }
}
