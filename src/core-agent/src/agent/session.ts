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

  /**
   * Get the LLM-facing view of the session.
   *
   * Image blocks are large and force multimodal routing, so only images added
   * after the latest assistant message stay inline. That preserves the normal
   * flow for user attachments and read_file image results: the next model call
   * can inspect the image. Once the model has responded, later tool-loop calls
   * retain the surrounding text/tool_result path metadata but stop replaying
   * old image bytes. The image can still be reopened by calling read_file(path).
   */
  getMessagesForModel(): Message[] {
    let lastAssistantIndex = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") {
        lastAssistantIndex = i;
        break;
      }
    }

    const result: Message[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const includeImages = i > lastAssistantIndex;
      const content = includeImages
        ? [...msg.content]
        : msg.content.filter((c) => c.type !== "image");
      if (content.length > 0) result.push({ role: msg.role, content });
    }
    return result;
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
   */
  compact(summary: string): void {
    if (this.messages.length <= 2) return;

    const kept = this.computeKeptTail();

    this.messages = [
      { role: "user", content: [{ type: "text", text: `[Previous conversation summary]\n${summary}` }] },
      { role: "assistant", content: [{ type: "text", text: "Understood. I have context from our previous conversation." }] },
      ...kept,
    ];
  }

  /**
   * The recent tail compact() preserves verbatim: the last few messages, minus
   * any leading tool_result-only user message.
   *
   * Pairing invariant: the kept tail must NOT begin with a tool_result-only
   * user message — its corresponding tool_use is in the older slice that's
   * about to be replaced by the summary, leaving it orphaned. The next provider
   * call after compaction would then send a function_call_output with no
   * matching function_call and the API rejects with "No tool call found for
   * function call output with call_id ...". Drop leading tool_result-only user
   * messages until the first message is a non-tool-result user message or an
   * assistant message — that point is a safe cut boundary.
   *
   * Shared by compact() and estimateKeptTailTokens() so the "what survives a
   * compaction" definition can't drift between the two.
   */
  private computeKeptTail(): Message[] {
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
    return kept;
  }

  /**
   * Estimated tokens of the tail compact() keeps verbatim. If this alone already
   * exceeds the window threshold (e.g. a large cap-exempt read_file / kb_read
   * result is sitting in the recent tail), a compaction pass can only summarize
   * the smaller remainder and cannot get the session under the threshold — so
   * the runner uses this to skip a no-progress pass that would otherwise burn a
   * summary LLM call every turn and discard the prior summary's detail. As later
   * turns push that big result out of the kept window, real compaction resumes.
   */
  estimateKeptTailTokens(): number {
    if (this.messages.length <= 2) return this.estimateTokens();
    return sumMessageTokens(this.computeKeptTail());
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
    return sumMessageTokens(this.messages);
  }

  private trimHistory(): void {
    // Each user+assistant pair = 1 turn
    const turns = Math.floor(this.messages.length / 2);
    if (turns <= this.maxHistoryTurns) return;

    const excess = turns - this.maxHistoryTurns;
    this.messages = this.messages.slice(excess * 2);
  }
}

/** Sum the heuristic token estimate across a set of messages. Shared by
 *  Session.estimateTokens() (whole history) and estimateKeptTailTokens() (the
 *  tail a compaction would preserve). */
function sumMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const c of msg.content) {
      if (c.type === "text") total += estimateStringTokens(c.text);
      else if (c.type === "tool_result") total += estimateStringTokens(c.content);
      else if (c.type === "tool_use") total += estimateStringTokens(JSON.stringify(c.input));
    }
  }
  return total;
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
