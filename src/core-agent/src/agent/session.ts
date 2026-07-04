import type { ImageContent, Message, MessageContent, Usage } from "../shared/types.js";
import type { ToolResultImage } from "../tools/base.js";

export type ToolResultCompactionOptions = {
  /** Minimum content length before an old tool_result is compacted. */
  minChars?: number;
  /** Total tool_result characters before old smaller results are compacted. */
  aggregateMinChars?: number;
  /** Minimum individual result length for aggregate-mode compaction. */
  aggregateMinResultChars?: number;
  /** Preview characters kept for aggregate-mode compacted results. */
  aggregatePreviewChars?: number;
  /** Keep tool results from the latest N assistant steps verbatim. */
  keepRecentAssistantSteps?: number;
  /** Always keep the newest N tool_result blocks verbatim. */
  keepRecentToolResults?: number;
  /** Preview characters from the beginning of a compacted result. */
  previewHeadChars?: number;
  /** Preview characters from the end of a compacted result. */
  previewTailChars?: number;
  /** Minimum serialized input length before an old tool_use input is compacted. */
  toolUseInputMinChars?: number;
  /** Total tool_use input characters before old smaller inputs are compacted. */
  toolUseInputAggregateMinChars?: number;
  /** Minimum individual input length for aggregate-mode tool_use compaction. */
  toolUseInputAggregateMinInputChars?: number;
  /** Long string fields above this size are replaced with a head/tail preview. */
  toolUseInputStringMinChars?: number;
  /** Total preview characters kept inside each compacted long string field. */
  toolUseInputPreviewChars?: number;
  /** Always keep the newest N tool_use blocks verbatim. */
  keepRecentToolUses?: number;
  /** Optional sync persistence hook. Returning a path makes the compacted view re-readable. */
  persistToolResult?: (info: {
    toolName: string;
    toolUseId: string;
    content: string;
    isError?: boolean;
  }) => string | undefined;
};

type NormalizedToolResultCompactionOptions = Required<
  Omit<ToolResultCompactionOptions, "persistToolResult">
> & Pick<ToolResultCompactionOptions, "persistToolResult">;

const DEFAULT_TOOL_RESULT_COMPACTION: NormalizedToolResultCompactionOptions = {
  minChars: 8 * 1024,
  aggregateMinChars: 16 * 1024,
  aggregateMinResultChars: 768,
  aggregatePreviewChars: 80,
  keepRecentAssistantSteps: 1,
  keepRecentToolResults: 2,
  previewHeadChars: 800,
  previewTailChars: 400,
  toolUseInputMinChars: 8 * 1024,
  toolUseInputAggregateMinChars: 16 * 1024,
  toolUseInputAggregateMinInputChars: 768,
  toolUseInputStringMinChars: 240,
  toolUseInputPreviewChars: 160,
  keepRecentToolUses: 2,
};

type ToolResultCompactionMode = "full-preview" | "aggregate-ref";
type ToolUseInputCompactionMode = "full-preview" | "aggregate-ref";

export const COMPACTED_TOOL_USE_INPUT_KEY = "__orkas_compacted_tool_use";

/**
 * Session manages the conversation history for an agent run.
 *
 * Inspired by OpenClaw's SessionManager (via @mariozechner/pi-coding-agent)
 * but simplified to be standalone — no external SDK dependency.
 */
export class Session {
  private messages: Message[] = [];
  private readonly maxHistoryTurns: number;
  private readonly toolResultCompaction: NormalizedToolResultCompactionOptions | null;
  private readonly compactedToolResultRefs = new Map<string, string>();

  constructor(opts?: {
    maxHistoryTurns?: number;
    toolResultCompaction?: ToolResultCompactionOptions | false;
  }) {
    this.maxHistoryTurns = opts?.maxHistoryTurns ?? 50;
    this.toolResultCompaction = opts?.toolResultCompaction
      ? { ...DEFAULT_TOOL_RESULT_COMPACTION, ...opts.toolResultCompaction }
      : null;
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
    return this.buildMessagesForModel();
  }

  /**
   * Get the summarizer-facing view of the session.
   *
   * This is intentionally built from raw session messages, not by reusing a
   * previously materialized model view. Old tool inputs are represented as
   * inert metadata so compaction summaries cannot learn executable-looking
   * preview arguments from historical tool calls.
   */
  getMessagesForSummary(): Message[] {
    return this.buildMessagesForModel();
  }

  private buildMessagesForModel(): Message[] {
    let lastAssistantIndex = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") {
        lastAssistantIndex = i;
        break;
      }
    }

    const assistantStepsAfter = this.computeAssistantStepsAfter();
    const toolNameById = this.computeToolNameById();
    const toolResultStats = this.computeToolResultStats();
    const totalToolResults = toolResultStats.count;
    const toolUseInputStats = this.computeToolUseInputStats();
    const totalToolUses = toolUseInputStats.count;
    let toolResultOrdinal = 0;
    let toolUseOrdinal = 0;

    const result: Message[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const includeImages = i > lastAssistantIndex;
      const content: MessageContent[] = [];
      for (const c of msg.content) {
        if (!includeImages && c.type === "image") continue;
        if (c.type === "tool_use") {
          const rawInputJson = stringifyToolInput(c.input);
          const ordinal = toolUseOrdinal++;
          const mode = this.toolUseInputCompactionMode(
            c,
            i,
            ordinal,
            totalToolUses,
            rawInputJson.length,
            toolUseInputStats.chars,
            assistantStepsAfter,
          );
          if (mode) {
            const compactedInput = this.compactToolUseInput(
              c.name,
              c.input,
              rawInputJson,
              mode,
            );
            content.push({
              ...c,
              input: stringifyToolInput(compactedInput).length < rawInputJson.length
                ? compactedInput
                : c.input,
            });
          } else {
            content.push(c);
          }
          continue;
        }
        if (c.type !== "tool_result") {
          content.push(c);
          continue;
        }
        const ordinal = toolResultOrdinal++;
        const mode = this.toolResultCompactionMode(
          c,
          i,
          ordinal,
          totalToolResults,
          toolResultStats.chars,
          assistantStepsAfter,
        );
        if (mode) {
          const compactedContent = this.compactToolResultContent(
            c.toolUseId,
            toolNameById.get(c.toolUseId) || "tool_result",
            c.content,
            c.isError,
            mode,
          );
          content.push({
            ...c,
            content: compactedContent.length < c.content.length ? compactedContent : c.content,
          });
        } else {
          content.push(c);
        }
      }
      if (content.length > 0) result.push({ role: msg.role, content });
    }
    return result;
  }

  /** Estimate the token count for the same compacted view sent to providers. */
  estimateModelTokens(): number {
    return sumMessageTokens(this.getMessagesForModel());
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

  private computeAssistantStepsAfter(): number[] {
    const out = new Array<number>(this.messages.length);
    let count = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      out[i] = count;
      if (this.messages[i].role === "assistant") count++;
    }
    return out;
  }

  private computeToolNameById(): Map<string, string> {
    const out = new Map<string, string>();
    for (const msg of this.messages) {
      if (msg.role !== "assistant") continue;
      for (const c of msg.content) {
        if (c.type === "tool_use" && c.id) out.set(c.id, c.name);
      }
    }
    return out;
  }

  private computeToolResultStats(): { count: number; chars: number } {
    let count = 0;
    let chars = 0;
    for (const msg of this.messages) {
      for (const c of msg.content) {
        if (c.type === "tool_result") {
          count++;
          chars += c.content.length;
        }
      }
    }
    return { count, chars };
  }

  private computeToolUseInputStats(): { count: number; chars: number } {
    let count = 0;
    let chars = 0;
    for (const msg of this.messages) {
      for (const c of msg.content) {
        if (c.type === "tool_use") {
          count++;
          chars += stringifyToolInput(c.input).length;
        }
      }
    }
    return { count, chars };
  }

  private toolResultCompactionMode(
    content: Extract<MessageContent, { type: "tool_result" }>,
    messageIndex: number,
    ordinal: number,
    totalToolResults: number,
    totalToolResultChars: number,
    assistantStepsAfter: number[],
  ): ToolResultCompactionMode | null {
    const opts = this.toolResultCompaction;
    if (!opts) return null;
    const newerToolResults = totalToolResults - ordinal - 1;
    if (newerToolResults < opts.keepRecentToolResults) return null;
    if ((assistantStepsAfter[messageIndex] ?? 0) <= opts.keepRecentAssistantSteps) return null;
    if (content.content.length >= opts.minChars) return "full-preview";
    if (
      totalToolResultChars > opts.aggregateMinChars
      && content.content.length >= opts.aggregateMinResultChars
    ) {
      return "aggregate-ref";
    }
    return null;
  }

  private toolUseInputCompactionMode(
    _content: Extract<MessageContent, { type: "tool_use" }>,
    messageIndex: number,
    ordinal: number,
    totalToolUses: number,
    inputChars: number,
    totalToolUseInputChars: number,
    assistantStepsAfter: number[],
  ): ToolUseInputCompactionMode | null {
    const opts = this.toolResultCompaction;
    if (!opts) return null;
    const newerToolUses = totalToolUses - ordinal - 1;
    if (newerToolUses < opts.keepRecentToolUses) return null;
    if ((assistantStepsAfter[messageIndex] ?? 0) <= opts.keepRecentAssistantSteps) return null;
    if (inputChars >= opts.toolUseInputMinChars) return "full-preview";
    if (
      totalToolUseInputChars > opts.toolUseInputAggregateMinChars
      && inputChars >= opts.toolUseInputAggregateMinInputChars
    ) {
      return "aggregate-ref";
    }
    return null;
  }

  private compactToolUseInput(
    toolName: string,
    input: Record<string, unknown>,
    rawInputJson: string,
    mode: ToolUseInputCompactionMode,
  ): Record<string, unknown> {
    return {
      [COMPACTED_TOOL_USE_INPUT_KEY]: {
        tool: toolName,
        mode,
        original_json_chars: rawInputJson.length,
        input_keys: Object.keys(input).slice(0, 20),
        note:
          "Historical tool input omitted from model context. This call already executed; inspect the paired tool_result or current files instead of reusing this object as tool input.",
      },
    };
  }

  private compactToolResultContent(
    toolUseId: string,
    toolName: string,
    content: string,
    isError?: boolean,
    mode: ToolResultCompactionMode = "full-preview",
  ): string {
    const opts = this.toolResultCompaction;
    if (!opts) return content;

    const refPath = this.getToolResultRef(toolUseId, toolName, content, isError);
    if (mode === "aggregate-ref") {
      const preview = content.slice(0, opts.aggregatePreviewChars).replace(/\s+/g, " ").trim();
      const previewLine = preview ? `\npreview: ${preview}` : "";
      const refLine = refPath
        ? "Use read_file(path) with the path attribute to retrieve the full content."
        : "Full content remains in session history but was omitted from this model call.";
      return (
        `<compacted-tool-result tool="${escapeAttr(toolName)}" call_id="${escapeAttr(toolUseId)}" ` +
        `status="${isError ? "error" : "success"}" original_size="${content.length}" mode="aggregate"` +
        `${refPath ? ` path="${escapeAttr(refPath)}"` : ""}>\n` +
        `[old tool result omitted after total tool_result context exceeded ${opts.aggregateMinChars} chars]` +
        previewLine +
        `\n${refLine}\n` +
        `</compacted-tool-result>`
      );
    }

    const head = content.slice(0, opts.previewHeadChars);
    const tail = content.length > opts.previewHeadChars + opts.previewTailChars
      ? content.slice(-opts.previewTailChars)
      : "";
    const omitted = Math.max(0, content.length - head.length - tail.length);
    const tailBlock = tail
      ? `\n\n[... ${omitted} chars omitted ...]\n\npreview_tail:\n${tail}`
      : "";
    const refLine = refPath
      ? `[Full content saved to: ${refPath}. Use read_file(path) to retrieve verbatim.]`
      : "[Full content remains in session history but was omitted from this model call.]";

    return (
      `<compacted-tool-result tool="${escapeAttr(toolName)}" call_id="${escapeAttr(toolUseId)}" ` +
      `status="${isError ? "error" : "success"}" original_size="${content.length}"` +
      `${refPath ? ` path="${escapeAttr(refPath)}"` : ""}>\n` +
      `[tool result compacted for repeated context]\n` +
      `preview_head:\n${head}` +
      tailBlock +
      `\n${refLine}\n` +
      `</compacted-tool-result>`
    );
  }

  private getToolResultRef(
    toolUseId: string,
    toolName: string,
    content: string,
    isError?: boolean,
  ): string | undefined {
    const existing = extractPersistedPath(content);
    if (existing) return existing;

    const cacheKey = `${toolUseId}:${content.length}:${content.slice(0, 64)}:${content.slice(-64)}`;
    const cached = this.compactedToolResultRefs.get(cacheKey);
    if (cached) return cached;

    try {
      const ref = this.toolResultCompaction?.persistToolResult?.({
        toolName,
        toolUseId,
        content,
        isError,
      });
      if (ref) this.compactedToolResultRefs.set(cacheKey, ref);
      return ref;
    } catch {
      return undefined;
    }
  }

  private trimHistory(): void {
    // Each user+assistant pair = 1 turn
    const turns = Math.floor(this.messages.length / 2);
    if (turns <= this.maxHistoryTurns) return;

    const excess = turns - this.maxHistoryTurns;
    const start = this.findSafeTrimStart(excess * 2);
    this.messages = this.messages.slice(start);
  }

  private findSafeTrimStart(start: number): number {
    let i = start;
    while (i < this.messages.length) {
      const msg = this.messages[i];
      if (isToolResultOnlyMessage(msg) || isImageOnlyMessage(msg)) {
        i++;
        continue;
      }
      break;
    }
    return i;
  }
}

function extractPersistedPath(content: string): string | undefined {
  const attr = /<persisted-output\b[^>]*\bpath="([^"]+)"/.exec(content);
  if (attr?.[1]) return unescapeAttr(attr[1]);
  const line = /\[Full content saved to:\s*([^\]]+?)\.\s*Use read_file\(path\)/.exec(content);
  return line?.[1];
}

function isToolResultOnlyMessage(msg: Message): boolean {
  return msg.role === "user" && msg.content.length > 0 && msg.content.every((c) => c.type === "tool_result");
}

function isImageOnlyMessage(msg: Message): boolean {
  return msg.role === "user" && msg.content.length > 0 && msg.content.every((c) => c.type === "image");
}

function stringifyToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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
