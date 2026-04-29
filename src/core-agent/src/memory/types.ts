/** Result from a memory search. */
export type MemorySearchResult = {
  /** File path of the matching document. */
  path: string;
  /** Starting line number of the match. */
  startLine: number;
  /** Ending line number of the match. */
  endLine: number;
  /** Relevance score (0-1). */
  score: number;
  /** Text snippet of the match. */
  snippet: string;
  /** Source type. */
  source: MemorySource;
};

export type MemorySource = "memory" | "sessions";

/** Status information for the memory subsystem. */
export type MemoryProviderStatus = {
  provider: string;
  model?: string;
  files: number;
  chunks: number;
  fts: { enabled: boolean };
  vector: { enabled: boolean; dims?: number };
};

/** Interface for memory search backends. */
export interface MemorySearchManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]>;

  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }>;

  status(): MemoryProviderStatus;

  sync?(params?: { force?: boolean }): Promise<void>;

  close?(): Promise<void>;
}
