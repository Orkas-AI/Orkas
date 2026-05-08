import type { ImageContent, Message, MessageContent, Usage } from "../shared/types.js";
import type { ToolResultImage } from "../tools/base.js";

/**
 * Session manages the conversation history for an agent run.
 *
 * Inspired by OpenClaw's SessionManager (via @mariozechner/pi-coding-agent)
 * but simplified to be standalone — no external SDK dependency.
 */
export class Session {
  private messages: Message[] = [];
  private readonly maxHistoryTurns: number;

  constructor(opts?: { maxHistoryTurns?: number }) {
    this.maxHistoryTurns = opts?.maxHistoryTurns ?? 100;
  }

  /** Add a message to the session. */
  addMessage(role: Message["role"], content: MessageContent[]): void {
    this.messages.push({ role, content });
    this.trimHistory();
  }

  /** Add a user text message. */
  addUserMessage(text: string): void {
    this.addMessage("user", [{ type: "text", text }]);
  }

  /** Add an assistant message from LLM response content. */
  addAssistantMessage(content: MessageContent[]): void {
    this.addMessage("assistant", content);
  }

  /** Add a tool result message.
   *
   * If `images` is non-empty, an additional user message carrying the image
   * content blocks is appended *after* the tool_result message. This fallback
   * shape works across providers whose native tool_result channel does not
   * accept images (OpenAI, Gemini) — the model sees "tool returned text,
   * then the very next user turn is the associated image(s)". */
  addToolResult(
    toolUseId: string,
    result: string,
    images?: ToolResultImage[],
    isError?: boolean,
  ): void {
    this.addMessage("user", [{ type: "tool_result", toolUseId, content: result, isError }]);
    if (images && images.length) {
      const imageBlocks: ImageContent[] = images.map((img) => ({
        type: "image",
        data: img.data,
        mediaType: img.mediaType as ImageContent["mediaType"],
      }));
      this.addMessage("user", imageBlocks);
    }
  }

  /** Get all messages in the session. */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Stable session identifier used as `prompt_cache_key`. The base `Session`
   * is anonymous (returns undefined); `PersistentSession` overrides this to
   * return its jsonl basename. A transient in-memory session (e.g. reflection)
   * has no caller-meaningful id, so the provider falls back to anonymous
   * prefix matching. */
  getSessionId(): string | undefined {
    return undefined;
  }

  /** Get the number of messages. */
  get length(): number {
    return this.messages.length;
  }

  /** Clear all messages. */
  clear(): void {
    this.messages = [];
  }

  /**
   * Compact the session by summarizing older messages.
   * Returns a summary of the compacted context.
   *
   * Pairing invariant: the kept tail must NOT begin with a tool_result-only
   * user message — its corresponding tool_use is in the older slice that's
   * about to be replaced by the summary, leaving it orphaned. The next
   * provider call after compaction would then send a function_call_output
   * with no matching function_call and the API rejects with
   * "No tool call found for function call output with call_id ...". Drop
   * leading tool_result-only user messages from `kept` until the first
   * message is either a non-tool-result user message or an assistant
   * message — that point is a safe cut boundary.
   */
  compact(summary: string): void {
    if (this.messages.length <= 2) return;

    // Keep the last few messages and replace older ones with a summary
    const keepCount = Math.min(4, this.messages.length);
    const kept = this.messages.slice(-keepCount);

    while (kept.length > 0) {
      const head = kept[0];
      if (head.role !== "user") break;
      const allToolResults = head.content.every(
        (c) => (c as { type?: string }).type === "tool_result",
      );
      if (!allToolResults) break;
      kept.shift();
    }

    this.messages = [
      { role: "user", content: [{ type: "text", text: `[Previous conversation summary]\n${summary}` }] },
      { role: "assistant", content: [{ type: "text", text: "Understood. I have context from our previous conversation." }] },
      ...kept,
    ];
  }

  /** Estimate token count without a real tokenizer.
   *
   * Splits by Unicode range: CJK characters (common+ext A, hiragana, katakana,
   * CJK symbols/punctuation, fullwidth forms) count ~1.5 token each; everything
   * else (ASCII/latin/whitespace/punct) follows the classic ~4 char/token ratio.
   *
   * This fixes a latent bug where pure-Chinese sessions under-estimated their
   * size by 2.5-3x, meaning the `tokensBefore > contextWindow * 0.6` compaction
   * guard in the runner effectively never fired for CJK users. Still heuristic
   * — real token count comes from provider `usage` at response time. */
  estimateTokens(): number {
    let total = 0;
    for (const msg of this.messages) {
      for (const c of msg.content) {
        if (c.type === "text") total += estimateStringTokens(c.text);
        else if (c.type === "tool_result") total += estimateStringTokens(c.content);
        else if (c.type === "tool_use") total += estimateStringTokens(JSON.stringify(c.input));
      }
    }
    return total;
  }

  private trimHistory(): void {
    // Each user+assistant pair = 1 turn
    const turns = Math.floor(this.messages.length / 2);
    if (turns <= this.maxHistoryTurns) return;

    const excess = turns - this.maxHistoryTurns;
    this.messages = this.messages.slice(excess * 2);
  }
}

/** CJK-aware token estimator. CJK chars count as 1.5 tokens, other chars as 0.25. */
function estimateStringTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // CJK Unified Ideographs (U+4E00-U+9FFF), Extension A (U+3400-U+4DBF),
    // CJK Symbols & Punctuation (U+3000-U+303F), Hiragana (U+3040-U+309F),
    // Katakana (U+30A0-U+30FF), Halfwidth/Fullwidth Forms (U+FF00-U+FFEF),
    // Hangul Syllables (U+AC00-U+D7AF).
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 1.5 + other / 4);
}
