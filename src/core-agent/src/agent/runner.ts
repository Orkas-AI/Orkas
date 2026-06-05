import type { MessageContent } from "../shared/types.js";
import {
  AuthError,
  ContextOverflowError,
  classifyRetryableError,
  isRetryableError,
  RateLimitError,
  TimeoutError,
  formatError,
} from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import type { CoreAgentConfig } from "../config/schema.js";
import type { EvolutionConfig } from "../evolution/types.js";
import type { LLMProvider, CompletionResult } from "../providers/base.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { AgentTool, ToolContext } from "../tools/base.js";
import { toToolDefinition } from "../tools/base.js";
import { getBuiltinTools } from "../tools/builtin.js";
import { SkillStore } from "../evolution/skill-store.js";
import { createSkillManageTool } from "../evolution/skill-tools.js";
import { Session } from "./session.js";
import type { AgentRunParams, AgentRunResult, AgentRunMeta, AgentRunEvent } from "./types.js";

const log = createLogger("agent-runner");
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_AFTER_MAX_DELAY_MS = 120_000;
const RETRY_JITTER_RATIO = 0.2;

function retryDelayMs(err: unknown, attempt: number): number {
  if (err instanceof RateLimitError && err.retryAfterMs) {
    return Math.min(Math.max(0, err.retryAfterMs), RETRY_AFTER_MAX_DELAY_MS);
  }
  const base = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(base * RETRY_JITTER_RATIO * Math.random());
  return base + jitter;
}

/**
 * AgentRunner is the core agent execution harness.
 *
 * It manages the LLM interaction loop: send messages, process tool calls,
 * feed results back, handle retries and failover, and manage context
 * window overflow via compaction.
 *
 * This is a simplified standalone equivalent of OpenClaw's
 * `pi-embedded-runner/run.ts` and `run/attempt.ts`.
 */
export class AgentRunner {
  private readonly config: CoreAgentConfig;
  private readonly providers: ProviderRegistry;
  private readonly tools: Map<string, AgentTool> = new Map();
  private readonly session: Session;
  private readonly skillStore: SkillStore | null;
  private readonly skillAllowlist: string[] | undefined;
  private readonly onCompact: ((summary: string) => void) | null;
  private readonly onLearnedSkillAdvertised: ((id: string) => void) | null;

  constructor(opts: {
    config: CoreAgentConfig;
    providers?: ProviderRegistry;
    tools?: AgentTool[];
    session?: Session;
    /** Provide a SkillStore to enable self-evolution features. */
    skillStore?: SkillStore;
    /** Restrict learned-skill index to this subset (undefined = all). */
    skillAllowlist?: string[];
    /** Fires after skill_manage(create) with the new skill id — Orkas
     * uses this to keep the bound agent's `skill_list` in sync. */
    onSkillCreated?: (id: string) => void;
    /** Fires once per turn for each learned-skill id rendered into the
     * system-prompt's `## Available Learned Skills` block (System B in
     * the host's signal-attribution vocabulary). Pure callback — exceptions
     * are swallowed; emission is best-effort. Orkas bridges this to its
     * `onSkillAdvertised` ChatOptions hook with `system: 'B'`. */
    onLearnedSkillAdvertised?: (id: string) => void;
    /** Called after session compaction with the generated summary text. */
    onCompact?: (summary: string) => void;
  }) {
    this.config = opts.config;
    this.providers = opts.providers ?? new ProviderRegistry(opts.config);
    this.session = opts.session ?? new Session();
    this.onCompact = opts.onCompact ?? null;
    this.skillAllowlist = opts.skillAllowlist;
    this.onLearnedSkillAdvertised = opts.onLearnedSkillAdvertised ?? null;

    // Set up evolution / skill store
    const evolutionConfig = this.config.evolution;
    if (opts.skillStore) {
      this.skillStore = opts.skillStore;
    } else if (evolutionConfig.enabled) {
      this.skillStore = new SkillStore(evolutionConfig.skillsDir, evolutionConfig as EvolutionConfig);
    } else {
      this.skillStore = null;
    }

    // Register tools (builtin + user-provided + evolution tools)
    const allTools = [...getBuiltinTools(), ...(opts.tools ?? [])];
    if (this.skillStore) {
      allTools.push(createSkillManageTool(this.skillStore, opts.onSkillCreated));
    }
    for (const tool of allTools) {
      this.tools.set(tool.name, tool);
    }
  }

  /** Get the current session. */
  getSession(): Session {
    return this.session;
  }

  /** Get the provider registry. */
  getProviders(): ProviderRegistry {
    return this.providers;
  }

  /**
   * Run the agent with a user message — blocking.
   * Delegates to the same generator that powers `runStream()`, consumes it,
   * and returns the final `AgentRunResult`. This keeps the two entry points
   * bit-for-bit equivalent and makes streaming callers see every internal
   * event (tool starts/ends, retries, compaction) in real time.
   */
  async run(params: AgentRunParams): Promise<AgentRunResult> {
    let final: AgentRunResult | null = null;
    for await (const ev of this.runStream(params)) {
      if (ev.type === "done") final = ev.result;
    }
    // runStream always emits a `done` — this is a safety net.
    if (!final) {
      throw new Error("AgentRunner.run: stream ended without `done` event");
    }
    return final;
  }

  /**
   * Run with streaming events.
   * Yields `text_delta` (per assistant turn), `tool_start` / `tool_end`
   * (per tool execution), `retry`, `compaction`, and a terminal `done`
   * carrying the full `AgentRunResult`.
   */
  async *runStream(params: AgentRunParams): AsyncIterable<AgentRunEvent> {
    const startTime = Date.now();
    const agentConfig = this.config.agent;
    const model = params.model ?? agentConfig.defaultModel;
    const providerId = params.provider ?? agentConfig.defaultProvider;
    const maxRetries = agentConfig.maxRetries;
    const maxToolLoops = agentConfig.maxToolLoops;

    // Resolve provider.
    let resolved = this.providers.resolveForModel(`${providerId}/${model}`);
    if (!resolved) {
      resolved = this.providers.resolveForModel(model) ?? undefined;
    }
    if (!resolved) {
      const err = this.errorResult(startTime, model, providerId, {
        kind: "auth",
        message: `No provider found for model: ${model}`,
      });
      yield { type: "done", result: err };
      return;
    }

    yield* this.runWithProvider(
      params,
      resolved.provider,
      resolved.modelId,
      startTime,
      maxRetries,
      maxToolLoops,
    );
  }

  private async *runWithProvider(
    params: AgentRunParams,
    provider: LLMProvider,
    modelId: string,
    startTime: number,
    maxRetries: number,
    maxToolLoops: number,
  ): AsyncIterable<AgentRunEvent> {
    // Build user message content
    const userContent: MessageContent[] = [{ type: "text", text: params.message }];
    if (params.images) {
      for (const img of params.images) {
        userContent.push({ type: "image", data: img.data, mediaType: img.mediaType });
      }
    }

    this.session.addMessage("user", userContent);

    const basePrompt = params.systemPrompt ?? this.config.agent.systemPrompt ?? this.buildDefaultSystemPrompt();
    const systemPrompt = await this.buildSystemPromptWithEvolution(basePrompt);

    let toolLoops = 0;
    let compactionCount = 0;
    let lastUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const toolNamesSet = new Set<string>();
    const skillsLoadedSet = new Set<string>();
    let transientToolErrors = 0;
    let permanentToolErrors = 0;

    // Main agent loop: call LLM, process tool calls, repeat.
    // Every exit point yields `{ type: "done", result }` then returns so the
    // consumer sees a terminal event no matter which branch wins.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const toolDefs = [...this.tools.values()].map(toToolDefinition);

        // Consume the provider stream token-by-token so callers (UI) can
        // paint partial text as it arrives. We still assemble a full
        // `CompletionResult`-shaped object at the end for the tool loop.
        const streamIter = provider.stream({
          model: modelId,
          messages: this.session.getMessages(),
          systemPrompt,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          maxTokens: 4096,
          signal: params.signal,
          cacheRetention: params.cacheRetention,
          sessionId: this.session.getSessionId(),
          // Forward thinking level so reasoner-required providers (e.g.
          // DeepSeek V4 Pro) can attach `reasoning_effort` to the request.
          // `undefined` lets the provider apply its `defaultReasoning`;
          // explicit `'off'` opts out per-call.
          ...(params.thinkingLevel !== undefined ? { reasoning: params.thinkingLevel } : {}),
        });

        let streamText = "";
        let streamContent: import("../shared/types.js").MessageContent[] | undefined;
        let streamStopReason: import("../shared/types.js").StopReason = "end_turn";
        let streamUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as import("../shared/types.js").Usage;
        let streamModel = modelId;
        for await (const ev of streamIter) {
          if (ev.type === "text_delta") {
            streamText += ev.text;
            // Forward to callers so UI can render incrementally.
            yield { type: "text_delta", text: ev.text };
          } else if (ev.type === "retry") {
            yield { type: "retry", attempt: ev.attempt, reason: ev.reason };
          } else if (ev.type === "message_end") {
            streamStopReason = ev.stopReason;
            if (ev.usage) {
              streamUsage = {
                inputTokens: ev.usage.inputTokens ?? streamUsage.inputTokens,
                outputTokens: ev.usage.outputTokens ?? streamUsage.outputTokens,
                cacheReadTokens: ev.usage.cacheReadTokens,
                cacheWriteTokens: ev.usage.cacheWriteTokens,
                totalTokens: ev.usage.totalTokens ?? streamUsage.totalTokens,
              };
            }
            if (ev.content) streamContent = ev.content;
            if (ev.model) streamModel = ev.model;
          } else if (ev.type === "error") {
            throw ev.error;
          }
        }

        // Fall back to a text-only content block if the provider didn't
        // include `content` in message_end (older providers / custom stream
        // implementations). Tool-using turns won't reach this branch from
        // those providers — we still require content for the tool loop.
        const finalContent: import("../shared/types.js").MessageContent[] =
          streamContent ?? (streamText ? [{ type: "text", text: streamText }] : []);

        const result: CompletionResult = {
          content: finalContent,
          stopReason: streamStopReason,
          usage: streamUsage,
          model: streamModel,
        };

        lastUsage = {
          inputTokens: lastUsage.inputTokens + result.usage.inputTokens,
          outputTokens: lastUsage.outputTokens + result.usage.outputTokens,
          totalTokens: lastUsage.totalTokens + result.usage.totalTokens,
        };

        // Add assistant response to session
        this.session.addAssistantMessage(result.content);

        // Turn text — used for the "final" snapshot if this turn ends the run.
        const turnText = result.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { text: string }).text)
          .join("");

        // Check for tool use
        const toolCalls = result.content.filter((c) => c.type === "tool_use");

        if (toolCalls.length === 0 || result.stopReason !== "tool_use") {
          // No tool calls — we're done
          const final: AgentRunResult = {
            text: turnText,
            content: result.content,
            meta: {
              durationMs: Date.now() - startTime,
              model: result.model,
              provider: provider.id,
              stopReason: result.stopReason,
              usage: lastUsage,
              toolLoops,
              compactionCount,
              toolNames: [...toolNamesSet],
              skillsLoaded: [...skillsLoadedSet],
              transientToolErrors: transientToolErrors || undefined,
              permanentToolErrors: permanentToolErrors || undefined,
            },
          };
          yield { type: "done", result: final };
          return;
        }

        // Process tool calls
        toolLoops++;
        if (toolLoops > maxToolLoops) {
          log.warn(`Tool loop limit reached (${maxToolLoops})`);
          const final: AgentRunResult = {
            text: turnText || "(Tool loop limit reached)",
            content: result.content,
            meta: {
              durationMs: Date.now() - startTime,
              model: result.model,
              provider: provider.id,
              stopReason: result.stopReason,
              usage: lastUsage,
              toolLoops,
              compactionCount,
              toolNames: [...toolNamesSet],
              skillsLoaded: [...skillsLoadedSet],
              transientToolErrors: transientToolErrors || undefined,
              permanentToolErrors: permanentToolErrors || undefined,
            },
          };
          yield { type: "done", result: final };
          return;
        }

        // Execute each tool call and add results
        const toolCtx: ToolContext = {
          workingDir: params.workingDir,
          signal: params.signal,
          state: params.sandboxEnv ? { sandboxEnv: params.sandboxEnv } : {},
        };

        for (const call of toolCalls) {
          if (call.type !== "tool_use") continue;

          const tool = this.tools.get(call.name);
          if (!tool) {
            yield { type: "tool_start", id: call.id, name: call.name, input: call.input };
            const msg = `Unknown tool: ${call.name}`;
            this.session.addToolResult(call.id, msg, undefined, true);
            yield { type: "tool_end", id: call.id, name: call.name, result: msg, isError: true };
            continue;
          }

          yield { type: "tool_start", id: call.id, name: call.name, input: call.input };
          toolNamesSet.add(call.name);
          // Track skill reads for metacognition metrics
          if (call.name === "skill_manage" && call.input && (call.input as any).action === "read" && (call.input as any).id) {
            skillsLoadedSet.add((call.input as any).id as string);
          }
          try {
            log.debug(`Executing tool: ${call.name}`);
            const toolResult = await tool.execute(call.input, toolCtx);
            this.session.addToolResult(call.id, toolResult.content, toolResult.images, toolResult.isError);
            yield {
              type: "tool_end",
              id: call.id,
              name: call.name,
              result: toolResult.content,
              isError: toolResult.isError,
            };
            if (toolResult.isError) {
              permanentToolErrors++;
              log.warn(`Tool ${call.name} returned error: ${toolResult.content.slice(0, 150)}`);
            }
          } catch (err) {
            const errMsg = formatError(err);
            const isTransient = isRetryableError(err);
            log.error(`Tool ${call.name} failed (${isTransient ? 'transient' : 'permanent'}): ${errMsg}`);
            const msg = `Tool execution error: ${errMsg}`;
            this.session.addToolResult(call.id, msg, undefined, true);
            yield { type: "tool_end", id: call.id, name: call.name, result: msg, isError: true };
            if (isTransient) transientToolErrors++;
            else permanentToolErrors++;
          }
        }

        // Check context window - attempt compaction if needed
        const tokensBefore = this.session.estimateTokens();
        const contextWindow = this.config.models.catalog[modelId]?.contextWindow ?? 200_000;
        if (tokensBefore > contextWindow * 0.6) {
          log.info(`Context nearing limit (${tokensBefore}/${contextWindow}), compacting...`);
          const compactSummary = await this.compactSession(provider, modelId, systemPrompt, params.cacheRetention);
          compactionCount++;
          yield {
            type: "compaction",
            tokensBefore,
            tokensAfter: this.session.estimateTokens(),
            summary: compactSummary || undefined,
          };
        }

        // Reset retry counter on successful tool loop iteration
        attempt = -1;
        continue;
      } catch (err) {
        if (params.signal?.aborted) {
          const e = this.errorResult(startTime, modelId, provider.id, {
            kind: "timeout",
            message: "Run aborted",
          }, lastUsage, toolLoops, compactionCount, true, [...toolNamesSet], [...skillsLoadedSet], transientToolErrors, permanentToolErrors);
          yield { type: "done", result: e };
          return;
        }

        if (err instanceof AuthError) {
          const e = this.errorResult(startTime, modelId, provider.id, {
            kind: "auth",
            message: err.message,
          }, lastUsage, toolLoops, compactionCount, false, [...toolNamesSet], [...skillsLoadedSet], transientToolErrors, permanentToolErrors);
          yield { type: "done", result: e };
          return;
        }

        if (err instanceof ContextOverflowError) {
          // Try compaction
          try {
            const tokensBefore = this.session.estimateTokens();
            const overflowSummary = await this.compactSession(provider, modelId, systemPrompt, params.cacheRetention);
            compactionCount++;
            yield {
              type: "compaction",
              tokensBefore,
              tokensAfter: this.session.estimateTokens(),
              summary: overflowSummary || undefined,
            };
            continue;
          } catch {
            const e = this.errorResult(startTime, modelId, provider.id, {
              kind: "context_overflow",
              message: err.message,
            }, lastUsage, toolLoops, compactionCount, false, [...toolNamesSet], [...skillsLoadedSet], transientToolErrors, permanentToolErrors);
            yield { type: "done", result: e };
            return;
          }
        }

        const retryKind = classifyRetryableError(err);
        if (retryKind && attempt < maxRetries) {
          const waitMs = retryDelayMs(err, attempt);
          const reason = formatError(err);
          log.warn(`Retryable ${retryKind} error (attempt ${attempt + 1}/${maxRetries}): ${reason}, waiting ${waitMs}ms`);
          yield { type: "retry", attempt: attempt + 1, reason };
          await sleep(waitMs);
          continue;
        }

        const e = this.errorResult(startTime, modelId, provider.id, {
          kind: "provider_error",
          message: formatError(err),
        }, lastUsage, toolLoops, compactionCount, false, [...toolNamesSet], [...skillsLoadedSet], transientToolErrors, permanentToolErrors);
        yield { type: "done", result: e };
        return;
      }
    }

    const exhausted = this.errorResult(startTime, modelId, provider.id, {
      kind: "provider_error",
      message: "Max retries exceeded",
    }, lastUsage, toolLoops, compactionCount, false, [...toolNamesSet], [...skillsLoadedSet], transientToolErrors, permanentToolErrors);
    yield { type: "done", result: exhausted };
  }

  private async compactSession(
    provider: LLMProvider,
    model: string,
    systemPrompt: string,
    cacheRetention?: "none" | "short" | "long",
  ): Promise<string> {
    const messages = this.session.getMessages();
    if (messages.length <= 4) return '';

    // Ask the LLM to summarize the conversation
    const summaryPrompt =
      "Summarize the conversation so far in a concise way that preserves all important context, " +
      "decisions made, code written, and any pending tasks. Be thorough but concise.";

    const summaryMessages = [
      ...messages,
      { role: "user" as const, content: [{ type: "text" as const, text: summaryPrompt }] },
    ];

    try {
      const result = await provider.complete({
        model,
        messages: summaryMessages,
        systemPrompt,
        maxTokens: 2048,
        cacheRetention,
        sessionId: this.session.getSessionId(),
      });

      const summary = result.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("");

      this.session.compact(summary);
      log.info("Session compacted successfully");
      try { this.onCompact?.(summary); } catch (e) { log.warn(`onCompact callback failed: ${formatError(e)}`); }
      return summary;
    } catch (err) {
      log.error(`Compaction failed: ${formatError(err)}`);
      throw err;
    }
  }

  /** Get the skill store (if evolution is enabled). */
  getSkillStore(): SkillStore | null {
    return this.skillStore;
  }

  private async buildSystemPromptWithEvolution(basePrompt: string): Promise<string> {
    if (!this.skillStore || !this.config.evolution.enabled) {
      return basePrompt;
    }

    try {
      const skillsIndex = await this.skillStore.buildIndex(this.skillAllowlist);
      // Signal-attribution hook: re-list to recover the rendered id set.
      // SkillStore.list() is mtime-cached so this is effectively free; not
      // worth changing buildIndex's signature. Mirror the same allowlist
      // filter so the emitted set matches what landed in the prompt.
      if (skillsIndex && this.onLearnedSkillAdvertised) {
        try {
          let advertised = await this.skillStore.list();
          if (this.skillAllowlist !== undefined) {
            const allow = new Set(this.skillAllowlist);
            advertised = advertised.filter((s) => allow.has(s.id));
          }
          for (const s of advertised) {
            try { this.onLearnedSkillAdvertised(s.id); }
            catch { /* best-effort */ }
          }
        } catch (err) {
          log.warn(`onLearnedSkillAdvertised replay failed: ${formatError(err)}`);
        }
      }
      const guidance = buildSkillsGuidance(skillsIndex);
      return basePrompt + "\n\n" + guidance;
    } catch (err) {
      log.warn(`Failed to build skills guidance: ${formatError(err)}`);
      return basePrompt;
    }
  }

  /**
   * Run a one-shot reflection turn: send the review prompt to the LLM
   * with access to skill_manage + any injected tools, then return the
   * text response. The reflection session is ephemeral (no persistence).
   */
  async runReflection(
    reviewPrompt: string,
    signal?: AbortSignal,
    sandboxEnv?: Record<string, string>,
  ): Promise<string> {
    const agentConfig = this.config.agent;
    const model = agentConfig.defaultModel;
    const providerId = agentConfig.defaultProvider;

    let resolved = this.providers.resolveForModel(`${providerId}/${model}`);
    if (!resolved) resolved = this.providers.resolveForModel(model) ?? undefined;
    if (!resolved) {
      log.warn('Reflection skipped: no provider');
      return '';
    }

    const provider = resolved.provider;
    const modelId = resolved.modelId;
    const toolDefs = [...this.tools.values()].map(toToolDefinition);
    const toolCtx: ToolContext = { state: sandboxEnv ? { sandboxEnv } : {} };

    // Single-turn reflection: send prompt, execute any tool calls, done.
    log.info(`Reflection starting: model=${modelId}`);
    const reflectSession = new Session();
    reflectSession.addMessage('user', [{ type: 'text', text: reviewPrompt }]);

    for (let loop = 0; loop < 5; loop++) {
      try {
        const result = await provider.complete({
          model: modelId,
          messages: reflectSession.getMessages(),
          systemPrompt: 'You are a self-improvement assistant. Reflect on the conversation summary and refine your skills and self-knowledge. Available tools: skill_manage (create / patch / delete skills) and metacognition (update COMPETENCE.md / LEARNING_STRATEGIES.md).',
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          maxTokens: 2048,
          signal,
        });

        reflectSession.addAssistantMessage(result.content);

        const toolCalls = result.content.filter(c => c.type === 'tool_use');
        if (toolCalls.length === 0 || result.stopReason !== 'tool_use') {
          const text = result.content
            .filter(c => c.type === 'text')
            .map(c => (c as { text: string }).text)
            .join('');
          log.info(`Reflection done: loops=${loop + 1} responseLen=${text.length}`);
          return text;
        }

        // Execute tool calls
        for (const call of toolCalls) {
          if (call.type !== 'tool_use') continue;
          const tool = this.tools.get(call.name);
          if (!tool) {
            log.warn(`Reflection: unknown tool "${call.name}"`);
            // addToolResult signature: (id, result, images?, isError?) — pass undefined for images.
            reflectSession.addToolResult(call.id, `Unknown tool: ${call.name}`, undefined, true);
            continue;
          }
          try {
            log.info(`Reflection tool: ${call.name}(${JSON.stringify(call.input).slice(0, 200)})`);
            const toolResult = await tool.execute(call.input, toolCtx);
            reflectSession.addToolResult(call.id, toolResult.content, toolResult.images, toolResult.isError);
            if (toolResult.isError) {
              log.warn(`Reflection tool ${call.name} returned error: ${toolResult.content.slice(0, 200)}`);
            }
          } catch (err) {
            log.error(`Reflection tool ${call.name} threw: ${formatError(err)}`);
            reflectSession.addToolResult(call.id, `Error: ${formatError(err)}`, undefined, true);
          }
        }
      } catch (err) {
        log.error(`Reflection LLM call failed: ${formatError(err)}`);
        return '';
      }
    }
    log.warn('Reflection: max loops (5) exhausted without completion');
    return '';
  }

  private buildDefaultSystemPrompt(): string {
    return [
      "You are a helpful AI assistant with access to tools.",
      "Use tools when needed to accomplish tasks.",
      "Be concise and accurate in your responses.",
    ].join("\n");
  }

  private errorResult(
    startTime: number,
    model: string,
    provider: string,
    error: AgentRunMeta["error"],
    usage?: Partial<AgentRunMeta["usage"]>,
    toolLoops = 0,
    compactionCount = 0,
    aborted = false,
    toolNames?: string[],
    skillsLoaded?: string[],
    transientToolErrs = 0,
    permanentToolErrs = 0,
  ): AgentRunResult {
    return {
      text: "",
      content: [],
      meta: {
        durationMs: Date.now() - startTime,
        model,
        provider,
        stopReason: "end_turn",
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
        },
        toolLoops,
        compactionCount,
        aborted: aborted || undefined,
        error,
        toolNames,
        skillsLoaded,
        transientToolErrors: transientToolErrs || undefined,
        permanentToolErrors: permanentToolErrs || undefined,
      },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the skills guidance block injected into the system prompt.
 * Tells the agent about skill_manage and metacognition tools.
 */
function buildSkillsGuidance(skillsIndex: string): string {
  const parts: string[] = [
    "## Self-improvement: skills & metacognition",
    "",
    "You have two tools — `skill_manage` and `metacognition` — for continuously improving yourself.",
    "",
    "### Skill management (skill_manage)",
    "- After finishing a complex task (5+ tool calls), fixing a tricky bug, or discovering a non-obvious workflow, save it as a skill",
    "- If you find a skill outdated or incomplete while using it, patch it immediately — don't wait for the user to ask",
    "- Simple one-off tasks don't need to be saved. Confirm with the user before creating or deleting a skill",
    "",
    "### Metacognition",
    "- COMPETENCE.md: record your strong areas and known weaknesses; update whenever you make an important discovery",
    "- LEARNING_STRATEGIES.md: record effective learning strategies and problem-solving methodologies",
    "- After being corrected by the user, update COMPETENCE.md to log the weakness",
    "- After successfully solving a problem in a previously weak area, update COMPETENCE.md to log the improvement",
  ];

  if (skillsIndex) {
    // `skillsIndex` already opens with its own `## Available Learned Skills`
    // H2 (see SkillStore.renderSkillsIndex). Don't wrap it in another header
    // — historically we used `### Available skills` here, which collided semantically
    // with the host's regular `## Available skills (skills)` block and led models to
    // confuse the two skill surfaces (using `skill_manage` for regular host
    // skills and getting "Skill not found").
    parts.push("", skillsIndex);
  }

  return parts.join("\n");
}
