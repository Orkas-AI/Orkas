/**
 * Tool-result size cap + oversized-output persistence (mirrors Claude Code's
 * `maxResultSizeChars` + `<persisted-output>` mechanism).
 *
 * Every AgentTool is wrapped by `wrapToolWithCap` as the last step of tool
 * assembly in runner.ts. Three-tier handling:
 *   len ≤ maxChars            → pass through unchanged
 *   maxChars < len ≤ PERSIST  → in-place truncation + trailing marker
 *   len > PERSIST             → spill to tool-results/<sid>/<name>.<id>.txt,
 *                                rewrite tool_result into a <persisted-output>
 *                                wrapper (preview + reference); the model can
 *                                pull the original back via read_file(path)
 *
 * Read-class tools (`read_file` / `kb_read`) have a cap of Infinity and the
 * decorator returns the original tool untouched — the model may re-inspect
 * file content repeatedly, so it must not be wiped.
 *
 * Pure-function util: Node stdlib only, never imports features/ or model/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { AgentTool, ToolResult, ToolContext } from '#core-agent';
import { createLogger } from '../logger';

const log = createLogger('util/tool-result-cap');

// ── Config ───────────────────────────────────────────────────────────────

/** Per-tool maximum characters allowed back into the context. Tools not in the
 *  table use DEFAULT_MAX_RESULT_CHARS.
 *  Infinity = decorator exempt, pass-through. Constants copied from Claude Code:
 *    src/tools/BashTool/BashTool.tsx:424 = 30_000
 *    src/tools/GrepTool/GrepTool.ts:164  = 20_000
 *    src/tools/FileReadTool/FileReadTool.ts:342 = Infinity
 *    others = 100_000
 *  PDF / write_file get small values because they only return path/status
 *  strings — no point giving them 100K headroom.
 */
export const MAX_RESULT_CHARS_BY_TOOL: Record<string, number> = {
  read_file: Infinity,
  kb_read: Infinity,
  bash: 30_000,
  search_file: 20_000,
  kb_search: 20_000,
  chat_search: 20_000,
  web_fetch: 100_000,
  web_search: 100_000,
  markdown_to_pdf: 4_000,
  html_to_pdf: 4_000,
  write_file: 4_000,
  edit_file: 4_000,
  generate_image: 4_000,
};

export const DEFAULT_MAX_RESULT_CHARS = 100_000;

/** Threshold above which we spill to disk (mirrors Claude Code
 *  src/constants/toolLimits.ts:13 = 50_000).
 *  Tools whose maxChars < threshold (bash 30K / grep 20K) never reach the
 *  spill branch — they get truncated at maxChars. Only tools with
 *  maxChars ≥ 50K (web_fetch 100K etc.) can ever spill. */
export const PERSIST_THRESHOLD = 50_000;

/** Preview returned to the model after a spill: head + tail (with
 *  `[N chars omitted]` placeholder in the middle). The 2000 / 500 ratio
 *  favors the head — tool outputs usually have higher information density
 *  near the start. */
const PREVIEW_HEAD = 2000;
const PREVIEW_TAIL = 500;

// ── Wrapping ─────────────────────────────────────────────────────────────

export interface WrapOpts {
  /** maxChars cap for this tool. Infinity → decorator returns the original
   *  tool directly. */
  maxChars: number;
  /** Spill directory (typically `sessionToolResultsDir(uid, sessionId)`).
   *  The decorator does not care about uid / sessionId; the caller assembles
   *  the path and passes it in. The directory is mkdir'd on demand, not
   *  required to exist beforehand. */
  toolResultsDir: string;
}

export function wrapToolWithCap(tool: AgentTool, opts: WrapOpts): AgentTool {
  // Infinity = exempt (read_file / kb_read): the model may repeatedly
  // re-check the same file contents, so they must not be truncated / spilled.
  if (!Number.isFinite(opts.maxChars)) return tool;

  // The per-session directory's basename IS the session_id — keeping the
  // decorator interface minimal (no extra sessionId parameter) while still
  // letting the logs identify the source.
  const sid = path.basename(opts.toolResultsDir);

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const result = await tool.execute(input, ctx);
      const content = result.content || '';
      const len = content.length;
      if (len <= opts.maxChars) return result;

      // Error result: truncate only, never spill — error stderr is worth
      // feeding back a slice for the model to triage, but spilling huge
      // error text as orphan files has no value.
      if (result.isError) {
        log.info(`truncated (error) tool=${tool.name} session=${sid} len=${len} cap=${opts.maxChars} removed=${len - opts.maxChars}`);
        return { ...result, content: truncate(content, opts.maxChars, tool.name) };
      }

      // Normal result over cap but below the spill threshold: in-place
      // truncation + trailing marker.
      if (len <= PERSIST_THRESHOLD) {
        log.info(`truncated tool=${tool.name} session=${sid} len=${len} cap=${opts.maxChars} removed=${len - opts.maxChars}`);
        return { ...result, content: truncate(content, opts.maxChars, tool.name) };
      }

      // Normal result over the spill threshold: spill the full text and
      // return a <persisted-output> reference.
      try {
        const absPath = persistToolResult(opts.toolResultsDir, tool.name, content);
        log.info(`persisted tool=${tool.name} session=${sid} size=${len} path=${absPath}`);
        return { ...result, content: buildPersistedOutputMarker(absPath, tool.name, content) };
      } catch (err) {
        // Disk-write failure degrades to in-place truncation — the model
        // at least gets the first maxChars characters, which is more useful
        // than a hard cut. warn level because this is a real I/O exception
        // (disk full / permission lost) and the user can trace it from logs.
        log.warn(`persist failed, falling back to truncate tool=${tool.name} session=${sid} size=${len}: ${(err as Error).message}`);
        return {
          ...result,
          content:
            truncate(content, opts.maxChars, tool.name) +
            `\n\n[note: oversized output persist failed: ${(err as Error).message}]`,
        };
      }
    },
  };
}

// ── Core helpers ─────────────────────────────────────────────────────────

function truncate(content: string, maxChars: number, toolName: string): string {
  const kept = content.slice(0, maxChars);
  const removed = content.length - maxChars;
  return `${kept}\n\n[truncated by ${toolName}: ${removed} chars removed]`;
}

export function persistToolResult(
  toolResultsDir: string,
  toolName: string,
  content: string,
): string {
  fs.mkdirSync(toolResultsDir, { recursive: true });
  const id = sha1(`${toolName}:${Date.now()}:${content.slice(0, 64)}`).slice(0, 12);
  const abs = path.join(toolResultsDir, `${toolName}.${id}.txt`);
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

/** Spill a CLI tool-event's full output to disk when it exceeds the
 *  50 KB persistence threshold. Mirrors the in-process tool spill
 *  policy above so an oversized bash output looks the same to the
 *  renderer regardless of whether it came from `wrapToolWithCap`
 *  (in-process tools) or a CLI subprocess's tool-event.
 *
 *  Used by `local_agents/runner.ts` to wrap each `tool-event
 *  phase:'result'` before forwarding to the renderer. Backends stay
 *  unaware of the spill mechanism — they always emit the full output.
 *
 *  Returns the rewritten `{output, outputPath}`. When below threshold,
 *  `outputPath` is undefined and `output` is the original content
 *  unchanged. */
export function maybeSpillToolResult(opts: {
  toolResultsDir: string;
  toolName: string;
  callId: string;
  output: string;
}): { output: string; outputPath?: string } {
  const { toolResultsDir, toolName, output } = opts;
  if (!output || output.length < PERSIST_THRESHOLD) {
    return { output };
  }
  try {
    const abs = persistToolResult(toolResultsDir, toolName, output);
    log.info(`cli tool spill tool=${toolName} session=${path.basename(toolResultsDir)} size=${output.length} path=${abs}`);
    // Same preview shape as the in-process path so the renderer's
    // click-to-expand logic works identically.
    return {
      output: buildPersistedOutputMarker(abs, toolName, output),
      outputPath: abs,
    };
  } catch (err) {
    // Disk-write failure: surface a truncated preview rather than the
    // full payload so we don't blow up the event stream.
    log.warn(`cli tool spill failed, falling back to truncated preview tool=${toolName}: ${(err as Error).message}`);
    const head = output.slice(0, PREVIEW_HEAD);
    return {
      output: `${head}\n\n[note: oversized output spill failed: ${(err as Error).message}]`,
    };
  }
}

export function buildPersistedOutputMarker(
  absPath: string,
  toolName: string,
  content: string,
): string {
  const head = content.slice(0, PREVIEW_HEAD);
  const tail = content.length > PREVIEW_HEAD + PREVIEW_TAIL
    ? content.slice(-PREVIEW_TAIL)
    : '';
  const omittedChars = content.length - head.length - tail.length;
  const omittedBlock = omittedChars > 0 ? `\n\n... [${omittedChars} chars omitted] ...\n\n` : '';
  const body = tail ? `${head}${omittedBlock}${tail}` : head;
  return (
    `<persisted-output tool="${toolName}" size="${content.length}" path="${absPath}">\n` +
    `${body}\n` +
    `[Full content saved to: ${absPath}. Use read_file(path) to retrieve verbatim.]\n` +
    `</persisted-output>`
  );
}

// ── Sweep ────────────────────────────────────────────────────────────────

/** Startup sweep: deletes sub-directories / files whose mtime is older than
 *  `maxAgeDays`. Best-effort (nothrow): missing directory or unstattable
 *  entries are silently skipped. Called once per uid activation
 *  (users.ts::activateUser). */
export function sweepToolResults(userToolResultsDir: string, maxAgeDays = 7): void {
  if (!fs.existsSync(userToolResultsDir)) return;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(userToolResultsDir, { withFileTypes: true });
  } catch { return; }
  let removed = 0;
  for (const ent of entries) {
    const abs = path.join(userToolResultsDir, ent.name);
    try {
      const st = fs.statSync(abs);
      if (st.mtimeMs < cutoffMs) {
        if (ent.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
        else fs.unlinkSync(abs);
        removed++;
      }
    } catch { /* per-entry best-effort */ }
  }
  if (removed) log.info(`swept ${removed} stale entries dir=${userToolResultsDir} maxAgeDays=${maxAgeDays}`);
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
