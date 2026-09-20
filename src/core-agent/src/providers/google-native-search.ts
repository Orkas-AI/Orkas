/** Google tool-context circulation for the existing pi-provider boundary.
 * Reuses pi-ai's Google message/schema/finish helpers and the installed
 * Google SDK. Ordinary Google requests remain on pi-ai. No global SDK patch,
 * secondary tool loop, or host-tool execution occurs here.
 */
import { FunctionCallingConfigMode, GoogleGenAI, type GenerateContentParameters, type Part, type ThinkingLevel } from '@google/genai';
import { convertMessages, convertTools, mapStopReason, resolveGoogleThinkingLevel } from '@earendil-works/pi-ai/api/google-shared';
import { sanitizeSurrogates } from '@earendil-works/pi-ai/utils/sanitize-unicode';
import type { Model, Api, Context, AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai/compat';
import type { GoogleNativeReplay } from '../shared/types.js';

export type GoogleReplayMessage = AssistantMessage & { googleNativeReplay?: GoogleNativeReplay };
type GoogleModel = Model<'google-generative-ai'>;
const MAX_REPLAY_CHARS = 2_000_000;
const MAX_REPLAY_PARTS = 16_384;

export function googleReplayForModel(replay: GoogleNativeReplay | undefined, model: { api: string; provider: string; id: string }): boolean {
  return !!replay && replay.api === model.api && replay.provider === model.provider && replay.model === model.id;
}

function replayParts(message: GoogleReplayMessage, model: GoogleModel): Part[] | undefined {
  const replay = message.googleNativeReplay;
  if (!googleReplayForModel(replay, model)) return undefined;
  if (typeof replay!.partsJson !== 'string' || replay!.partsJson.length > MAX_REPLAY_CHARS) throw new Error('Invalid Google tool context');
  let parts: Part[];
  try { parts = JSON.parse(replay!.partsJson); } catch { throw new Error('Invalid Google tool context'); }
  if (!Array.isArray(parts) || parts.length > MAX_REPLAY_PARTS || parts.some(p => !p || typeof p !== 'object')) throw new Error('Invalid Google tool context');
  // A projected/compacted message may have removed tool calls. Never restore
  // them from opaque metadata after the session removed their protocol pair.
  const calls = parts.flatMap(p => p.functionCall ? [p.functionCall] : []);
  const portable = message.content.filter(c => c.type === 'toolCall');
  if (calls.length !== portable.length || calls.some((c, i) => c.id !== portable[i].id || c.name !== portable[i].name
    || JSON.stringify(c.args ?? {}) !== JSON.stringify(portable[i].arguments))) return undefined;
  return parts;
}

export function hasGoogleNativeReplay(context: Context, model: Model<Api>): boolean {
  return context.messages.some(m => m.role === 'assistant' && googleReplayForModel((m as GoogleReplayMessage).googleNativeReplay, model));
}

function contentsWithReplay(model: GoogleModel, context: Context) {
  const contents = convertMessages(model, context);
  const assistants = context.messages.filter(m => m.role === 'assistant');
  // The canonical serializer may omit empty assistant messages. Mirror that
  // selection through its exported converter instead of indexing raw history.
  const rendered = assistants.filter(m => convertMessages(model, { messages: [m] }).some(c => c.role === 'model'));
  const nativeModels = contents.filter(c => c.role === 'model');
  if (nativeModels.length !== rendered.length) throw new Error('Google history projection mismatch');
  const originalIds = new Map<string, string>();
  for (let i = 0; i < rendered.length; i++) {
    const parts = replayParts(rendered[i] as GoogleReplayMessage, model);
    if (!parts) continue;
    nativeModels[i].parts = parts;
    for (const part of parts) {
      const id = part.functionCall?.id;
      if (!id) continue;
      // pi-ai normalizes IDs in both portable call/response messages. Native
      // signed parts must retain the server ID, including in the response.
      const normalized = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      if (originalIds.has(normalized) && originalIds.get(normalized) !== id) throw new Error('Ambiguous Google tool id');
      originalIds.set(normalized, id);
    }
  }
  for (const content of contents) for (const part of content.parts ?? []) {
    const response = part.functionResponse;
    if (response?.id && originalIds.has(response.id)) response.id = originalIds.get(response.id);
  }
  return contents;
}

function googleClient(model: GoogleModel, apiKey: string | undefined, headers?: Record<string, string>) {
  if (!apiKey) throw new Error('Google API key unavailable');
  return new GoogleGenAI({ apiKey, httpOptions: {
    ...(model.baseUrl ? { baseUrl: model.baseUrl, apiVersion: '' } : {}),
    headers: { ...model.headers, ...headers },
    // The host owns retry and cancellation; do not repeat billable searches
    // invisibly inside the SDK or after streamed content.
    retryOptions: { attempts: 1 }, timeout: 3_600_000,
  } });
}

export async function* streamGoogleNativeSearch(modelInput: Model<Api>, context: Context, options: {
  apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal;
  maxTokens?: number; temperature?: number; reasoning?: "minimal" | "low" | "medium" | "high";
  onPayload: (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>;
}): AsyncGenerator<AssistantMessageEvent> {
  const model = modelInput as GoogleModel;
  options.signal?.throwIfAborted();
  const config: NonNullable<GenerateContentParameters['config']> = {
    ...(context.systemPrompt ? { systemInstruction: sanitizeSurrogates(context.systemPrompt) } : {}),
    ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(context.tools?.length ? { tools: convertTools(context.tools) } : {}),
    abortSignal: options.signal,
    ...(hasGoogleNativeReplay(context, model) ? { toolConfig: { includeServerSideToolInvocations: true, functionCallingConfig: { mode: FunctionCallingConfigMode.VALIDATED } } } : {}),
  };
  if (options.reasoning) {
    const level = resolveGoogleThinkingLevel(model, options.reasoning);
    const pro = /gemini-3(?:\.\d+)?-pro/.test(model.id);
    config.thinkingConfig = { includeThoughts: true,
      thinkingLevel: (pro ? (['minimal', 'low'].includes(level) ? 'LOW' : 'HIGH') : level.toUpperCase()) as ThinkingLevel };
  }
  const original: GenerateContentParameters = { model: model.id, contents: contentsWithReplay(model, context), config };
  const transformed = await options.onPayload(original, model);
  const params = (transformed === undefined ? original : transformed) as GenerateContentParameters;
  options.signal?.throwIfAborted();
  const client = googleClient(model, options.apiKey, options.headers);
  const incoming = await client.models.generateContentStream(params);
  const output: GoogleReplayMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [], stopReason: 'pending', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  yield { type: 'start', partial: output };
  const parts: Part[] = [];
  const callIds = new Set<string>();
  let chars = 2;
  let hasServerContext = false;
  for await (const chunk of incoming) {
    options.signal?.throwIfAborted();
    const candidate = chunk.candidates?.[0];
    output.responseId ||= chunk.responseId;
    if (chunk.promptFeedback?.blockReason) {
      output.rawStopReason = chunk.promptFeedback.blockReason;
      output.stopReason = 'error';
    }
    for (const part of candidate?.content?.parts ?? []) {
      chars += JSON.stringify(part).length + 1;
      if (chars > MAX_REPLAY_CHARS || parts.length >= MAX_REPLAY_PARTS) throw new Error('Google tool context exceeds replay limit');
      parts.push(part);
      hasServerContext ||= !!(part.toolCall || part.toolResponse || part.thoughtSignature);
      if (part.text !== undefined) {
        const contentIndex = output.content.length;
        if (part.thought) {
          output.content.push({ type: 'thinking', thinking: part.text, ...(part.thoughtSignature ? { thinkingSignature: part.thoughtSignature } : {}) });
          yield { type: 'thinking_start', contentIndex, partial: output };
          yield { type: 'thinking_delta', contentIndex, delta: part.text, partial: output };
          yield { type: 'thinking_end', contentIndex, content: part.text, partial: output };
        } else {
          output.content.push({ type: 'text', text: part.text, ...(part.thoughtSignature ? { textSignature: part.thoughtSignature } : {}) });
          yield { type: 'text_start', contentIndex, partial: output };
          yield { type: 'text_delta', contentIndex, delta: part.text, partial: output };
          yield { type: 'text_end', contentIndex, content: part.text, partial: output };
        }
      }
      if (part.functionCall) {
        const call = part.functionCall;
        // Gemini 3 tool combination requires server-provided IDs. Inventing
        // one would break the signed native context circulated next round.
        if (!call.id || !call.name || callIds.has(call.id)) throw new Error('Invalid Google function call');
        callIds.add(call.id);
        const toolCall = { type: 'toolCall' as const, id: call.id, name: call.name, arguments: call.args ?? {},
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
        const contentIndex = output.content.length;
        output.content.push(toolCall);
        yield { type: 'toolcall_start', contentIndex, partial: output };
        yield { type: 'toolcall_delta', contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output };
        yield { type: 'toolcall_end', contentIndex, toolCall, partial: output };
      }
    }
    if (candidate?.finishReason) {
      output.rawStopReason = candidate.finishReason;
      output.stopReason = mapStopReason(candidate.finishReason);
      if (output.stopReason === 'stop' && output.content.some(c => c.type === 'toolCall')) output.stopReason = 'toolUse';
    }
    if (chunk.usageMetadata) {
      const u = chunk.usageMetadata;
      output.usage = { ...output.usage, input: (u.promptTokenCount ?? 0) - (u.cachedContentTokenCount ?? 0),
        output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cacheRead: u.cachedContentTokenCount ?? 0,
        totalTokens: u.totalTokenCount ?? 0 };
    }
  }
  options.signal?.throwIfAborted();
  if (output.stopReason === 'pending') throw new Error('Google stream ended without a finish reason');
  if (output.stopReason === 'error' || output.stopReason === 'aborted') {
    output.errorMessage = 'Google generation did not complete';
    yield { type: 'error', reason: output.stopReason, error: output };
    return;
  }
  if (hasServerContext) output.googleNativeReplay = { api: model.api, provider: model.provider, model: model.id, partsJson: JSON.stringify(parts) };
  yield { type: 'done', reason: output.stopReason, message: output };
}
