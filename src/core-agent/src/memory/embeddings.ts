import { createLogger } from "../shared/logger.js";

const log = createLogger("embeddings");

/** An embedding provider that can embed text into vector space. */
export type EmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  /** Embed a single query text. */
  embedQuery(text: string): Promise<number[]>;
  /** Embed a batch of texts. */
  embedBatch(texts: string[]): Promise<number[][]>;
};

export type EmbeddingProviderType = "openai" | "gemini" | "voyage" | "mistral";

/** Normalize a vector to unit length. */
export function normalizeVector(vec: number[]): number[] {
  const sanitized = vec.map((v) => (Number.isFinite(v) ? v : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, v) => sum + v * v, 0));
  if (magnitude < 1e-10) return sanitized;
  return sanitized.map((v) => v / magnitude);
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom < 1e-10 ? 0 : dot / denom;
}

/** Create an OpenAI-compatible embedding provider. */
export function createOpenAIEmbeddingProvider(config: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): EmbeddingProvider {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = config.model ?? "text-embedding-3-small";

  async function embed(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: texts }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Embedding API error (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map((d) => normalizeVector(d.embedding));
  }

  return {
    id: "openai",
    model,
    maxInputTokens: 8191,
    async embedQuery(text: string): Promise<number[]> {
      const [vec] = await embed([text]);
      return vec;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return embed(texts);
    },
  };
}

/** Create a Gemini embedding provider. */
export function createGeminiEmbeddingProvider(config: {
  apiKey?: string;
  model?: string;
}): EmbeddingProvider {
  const apiKey = config.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  const model = config.model ?? "text-embedding-004";

  async function embed(texts: string[]): Promise<number[][]> {
    const requests = texts.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    }));

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests }),
      },
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Gemini embedding error (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as {
      embeddings: Array<{ values: number[] }>;
    };

    return data.embeddings.map((e) => normalizeVector(e.values));
  }

  return {
    id: "gemini",
    model,
    maxInputTokens: 2048,
    async embedQuery(text: string): Promise<number[]> {
      const [vec] = await embed([text]);
      return vec;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return embed(texts);
    },
  };
}
