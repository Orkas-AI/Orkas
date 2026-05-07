/**
 * Tool-result size cap + oversized-output persistence (仿 Claude Code 的
 * `maxResultSizeChars` + `<persisted-output>` 机制)。
 *
 * 每个 AgentTool 在 runner.ts 工具组装的最后一步统一过 `wrapToolWithCap`。
 * 三级处理：
 *   len ≤ maxChars            → 原样透传
 *   maxChars < len ≤ PERSIST  → 就地截断 + 尾标
 *   len > PERSIST             → 落盘到 tool-results/<sid>/<name>.<id>.txt，
 *                                tool_result 改写成 <persisted-output> 包
 *                                的 preview + 引用；模型真要看原文调
 *                                read_file(path) 拉回
 *
 * Read-类工具（`read_file` / `kb_read`）上限 = Infinity，装饰器直接返回原工具
 * 不介入 —— 这些输出的文件内容模型可能反复核对，不能被清掉。
 *
 * 纯函数 util：只用 Node stdlib，不 import features/ / model/。
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { AgentTool, ToolResult, ToolContext } from '#core-agent';
import { createLogger } from '../logger';

const log = createLogger('util/tool-result-cap');

// ── Config ───────────────────────────────────────────────────────────────

/** 每工具允许回灌上下文的最大字符数。表外走 DEFAULT_MAX_RESULT_CHARS。
 *  Infinity = 豁免装饰器，直接透传。常量照抄 Claude Code 源码：
 *    src/tools/BashTool/BashTool.tsx:424 = 30_000
 *    src/tools/GrepTool/GrepTool.ts:164  = 20_000
 *    src/tools/FileReadTool/FileReadTool.ts:342 = Infinity
 *    其它 = 100_000
 *  PDF / write_file 设小值因为它们只返回路径/状态字符串，没必要给 100K 余量。
 */
export const MAX_RESULT_CHARS_BY_TOOL: Record<string, number> = {
  read_file: Infinity,
  kb_read: Infinity,
  bash: 30_000,
  search_file: 20_000,
  kb_search: 20_000,
  web_fetch: 100_000,
  web_search: 100_000,
  markdown_to_pdf: 4_000,
  html_to_pdf: 4_000,
  write_file: 4_000,
  edit_file: 4_000,
  generate_image: 4_000,
};

export const DEFAULT_MAX_RESULT_CHARS = 100_000;

/** 超过此阈值触发落盘（仿 Claude Code src/constants/toolLimits.ts:13 = 50_000）。
 *  阈值 < maxChars 的工具（bash 30K / grep 20K）永远不会走落盘分支——
 *  它们在 maxChars 就截断了。只有 maxChars ≥ 50K 的工具（web_fetch 100K 等）
 *  才有机会落盘。 */
export const PERSIST_THRESHOLD = 50_000;

/** 落盘后回灌给模型的 preview：开头 + 结尾（中间用 `[N chars omitted]` 占位）。
 *  2000 / 500 的比例偏向头部——tool 输出大多前缀信息量密度高。 */
const PREVIEW_HEAD = 2000;
const PREVIEW_TAIL = 500;

// ── Wrapping ─────────────────────────────────────────────────────────────

export interface WrapOpts {
  /** 该工具的 maxChars 上限。Infinity → 装饰器直接返回原工具。 */
  maxChars: number;
  /** 落盘目录（一般是 `sessionToolResultsDir(uid, sessionId)`）。
   *  装饰器不关心 uid / sessionId，调用方组装好传进来。
   *  目录按需 mkdir，不预先强制存在。 */
  toolResultsDir: string;
}

export function wrapToolWithCap(tool: AgentTool, opts: WrapOpts): AgentTool {
  // Infinity = 豁免（read_file / kb_read）：模型可能对同一文件内容反复核对，
  // 不能被截 / 落盘。
  if (!Number.isFinite(opts.maxChars)) return tool;

  // per-session 目录的 basename 正好是 session_id —— 不额外传 sessionId
  // 参数保持装饰器接口最小，日志里又能标明来源。
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

      // 错误结果：只截断不落盘 —— 错误 stderr 值得回灌一段给模型定位，但整条
      // 大文本落盘成孤儿文件没价值。
      if (result.isError) {
        log.info(`truncated (error) tool=${tool.name} session=${sid} len=${len} cap=${opts.maxChars} removed=${len - opts.maxChars}`);
        return { ...result, content: truncate(content, opts.maxChars, tool.name) };
      }

      // 正常结果但超阈值未到落盘线：就地截断 + 尾标。
      if (len <= PERSIST_THRESHOLD) {
        log.info(`truncated tool=${tool.name} session=${sid} len=${len} cap=${opts.maxChars} removed=${len - opts.maxChars}`);
        return { ...result, content: truncate(content, opts.maxChars, tool.name) };
      }

      // 正常结果超过落盘线：原文落盘，返回 <persisted-output> 引用。
      try {
        const absPath = persistToolResult(opts.toolResultsDir, tool.name, content);
        log.info(`persisted tool=${tool.name} session=${sid} size=${len} path=${absPath}`);
        return { ...result, content: buildPersistedOutputMarker(absPath, tool.name, content) };
      } catch (err) {
        // 磁盘写入失败降级为就地截断 —— 模型至少拿到前 maxChars 字符，
        // 比彻底截断更有用。warn 级别是因为这是实际的 I/O 异常（磁盘满 /
        // 权限丢），用户能从日志里追根溯源。
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

/** 启动期清扫：删除 mtime 超过 `maxAgeDays` 的子目录 / 文件。Best-effort
 *  (nothrow)：目录不存在、某个文件读不到 stat，都安静跳过。每个 uid
 *  激活时调一次（users.ts::activateUser）。 */
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
