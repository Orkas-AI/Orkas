/**
 * Library-scoped tools injected into every main-conv runner.
 *
 *   - `kb_list`   — list Library files and indexing status so the model can
 *                   discover what exists before choosing a search/read path.
 *   - `kb_search` — semantic search over the user's Library
 *                   (global, plus project-scoped Library when available).
 *   - `kb_read`   — read a Library file's chunk text back out of the
 *                   vector store (no re-parsing of the source; fast).
 *
 * These tools are read-only and need no localExec permission. They replace
 * the pre-kb-vector flow of `cat _INDEX.md` → drill into subdirs → cat files
 * (see the Library section of `prompts/chat_commander.md`
 * for the routing rule).
 *
 * Uses the currently-active user via `getActiveUserId()` — the tool's `uid` is
 * captured at runner build time and stays stable for the runner's lifetime
 * (per-invocation uid swap would require tearing down the runner anyway).
 */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import * as kb from '../../features/kb_vector';
import * as kbEmbed from '../../features/kb_embed';
import * as projectLibrary from '../../features/project_library_indexer';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('kb-tools');

export interface KbToolsOpts {
  userId: string;
  projectId?: string;
}

const PREVIEW_CHARS = 400;
const DEFAULT_LIST_LIMIT = 80;
const MAX_LIST_LIMIT = 300;
const KB_KIND_VALUES = ['text', 'pdf', 'docx', 'spreadsheet', 'presentation', 'image'] as const;

function previewOf(text: string): string {
  const s = (text || '').trim();
  if (s.length <= PREVIEW_CHARS) return s;
  return s.slice(0, PREVIEW_CHARS) + '…';
}

function parseKbKind(raw: unknown): kb.KbKind | undefined {
  return typeof raw === 'string' && (KB_KIND_VALUES as readonly string[]).includes(raw)
    ? raw as kb.KbKind
    : undefined;
}

type LibraryScope = 'global' | 'project';
type ScopeInput = LibraryScope | 'all';
type LibraryHit = kb.KbSearchHit & { scope: LibraryScope };

function parseSearchScope(raw: unknown, hasProject: boolean): ScopeInput {
  if (raw === 'global') return 'global';
  if (raw === 'project' && hasProject) return 'project';
  if (raw === 'all' && hasProject) return 'all';
  return hasProject ? 'all' : 'global';
}

function parseReadScope(raw: unknown, hasProject: boolean): ScopeInput {
  if (raw === 'global') return 'global';
  if (raw === 'project' && hasProject) return 'project';
  if (raw === 'all' && hasProject) return 'all';
  return hasProject ? 'all' : 'global';
}

function parseListScope(raw: unknown, hasProject: boolean): ScopeInput {
  if (raw === 'global') return 'global';
  if (raw === 'project' && hasProject) return 'project';
  if (raw === 'all' && hasProject) return 'all';
  return hasProject ? 'all' : 'global';
}

type LibraryFileEntry = {
  scope: LibraryScope;
  row: kb.KbFileRow;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kbSize = bytes / 1024;
  if (kbSize < 1024) return `${kbSize.toFixed(kbSize < 10 ? 1 : 0)} KB`;
  const mbSize = kbSize / 1024;
  return `${mbSize.toFixed(mbSize < 10 ? 1 : 0)} MB`;
}

function statusRank(status: kb.KbStatus): number {
  switch (status) {
    case 'failed': return 0;
    case 'processing': return 1;
    case 'pending': return 2;
    case 'ready': return 3;
    default: return 4;
  }
}

function createKbListTool(opts: KbToolsOpts): AgentTool {
  const hasProject = !!opts.projectId;
  return {
    name: 'kb_list',
    executionMode: 'parallel',
    description:
      'List files in the user Library before deciding what to search or read'
      + (hasProject ? ' (current project + global by default)' : '')
      + '. Use this when the user asks what is in the Library, asks about files\n'
      + 'without naming one, or when semantic search has no good hits. Returns\n'
      + 'relative paths, scope, kind, indexing status, chunk count, and size.\n'
      + 'After choosing a likely file, use `kb_search` for semantic retrieval or\n'
      + '`kb_read` when the user explicitly asks to inspect/read that file.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: hasProject ? ['all', 'project', 'global'] : ['global'],
          description: hasProject
            ? 'List scope. Default all = current project Library plus global Library.'
            : 'List scope. Only global is available outside a project.',
        },
        dir: {
          type: 'string',
          description: 'Optional: limit results to relative paths under this directory prefix.',
        },
        kind: {
          type: 'string',
          enum: [...KB_KIND_VALUES],
          description: 'Optional: restrict to one file kind.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'processing', 'ready', 'failed'],
          description: 'Optional: restrict to one indexing status.',
        },
        limit: {
          type: 'number',
          description: `Maximum files to return. Default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}.`,
        },
      },
    },
    async execute(input) {
      const scope = parseListScope(input.scope, hasProject);
      const rawDir = typeof input.dir === 'string' ? input.dir.trim().replace(/^\/+|\/+$/g, '') : '';
      const dir = rawDir ? `${rawDir}/` : '';
      const kind = parseKbKind(input.kind);
      const rawStatus = typeof input.status === 'string' ? input.status : '';
      const status = ['pending', 'processing', 'ready', 'failed'].includes(rawStatus) ? rawStatus as kb.KbStatus : undefined;
      const limit = Math.min(
        MAX_LIST_LIMIT,
        Math.max(1, Math.floor(Number(input.limit ?? DEFAULT_LIST_LIMIT))),
      );

      const files: LibraryFileEntry[] = [];
      if (scope === 'global' || scope === 'all') {
        files.push(...kb.listFiles(opts.userId).map((row) => ({ scope: 'global' as const, row })));
      }
      if ((scope === 'project' || scope === 'all') && opts.projectId) {
        files.push(...projectLibrary.listFiles(opts.userId, opts.projectId)
          .map((row) => ({ scope: 'project' as const, row })));
      }

      const filtered = files
        .filter(({ row }) => !dir || row.rel_path === rawDir || row.rel_path.startsWith(dir))
        .filter(({ row }) => !kind || row.kind === kind)
        .filter(({ row }) => !status || row.status === status)
        .sort((a, b) =>
          statusRank(a.row.status) - statusRank(b.row.status)
          || a.scope.localeCompare(b.scope)
          || a.row.rel_path.localeCompare(b.row.rel_path),
        );

      const globalSummary = kb.statusSummary(opts.userId);
      const projectSummary = opts.projectId ? projectLibrary.statusSummary(opts.userId, opts.projectId) : null;
      const summaryBits = [
        `global total=${globalSummary.total} ready=${globalSummary.ready} processing=${globalSummary.processing} pending=${globalSummary.pending} failed=${globalSummary.failed}`,
      ];
      if (projectSummary) {
        summaryBits.push(
          `project total=${projectSummary.total} ready=${projectSummary.ready} processing=${projectSummary.processing} pending=${projectSummary.pending} failed=${projectSummary.failed}`,
        );
      }

      const lines = [
        `Library files (${summaryBits.join('; ')}):`,
      ];
      if (!filtered.length) {
        lines.push('No files match the requested filters.');
        return { content: lines.join('\n') };
      }

      const shown = filtered.slice(0, limit);
      for (const { scope: fileScope, row } of shown) {
        lines.push(
          `- scope=${fileScope} path=${row.rel_path} kind=${row.kind} status=${row.status}`
          + ` chunks=${row.chunks} size=${formatBytes(row.bytes)}`
          + (row.error ? ` error="${previewOf(row.error)}"` : ''),
        );
      }
      if (filtered.length > shown.length) {
        lines.push(`... ${filtered.length - shown.length} more file(s). Increase limit or narrow dir/kind/status.`);
      }
      return { content: lines.join('\n') };
    },
  };
}

function createKbSearchTool(opts: KbToolsOpts): AgentTool {
  const hasProject = !!opts.projectId;
  return {
    name: 'kb_search',
    // Parallel-safe (verified 2026-06-18 by reading fastembed@2.1.0). kb_search
    // embeds the query on the process-wide shared ONNX embedder singleton, but
    // CONCURRENT calls on that ONE session are safe: fastembed's embed() keeps
    // all state local and already calls the tokenizer concurrently within a
    // batch (`Promise.all(...encode)`), and onnxruntime `InferenceSession.run()`
    // is concurrency-safe on a shared session (the documented serving pattern).
    // PC/CLAUDE.md's ONNX rule warns against multiple SESSIONS (worker_threads
    // each holding their own → memory blowup), NOT concurrent run() on one
    // session — which is all this is. (Same reason in-process indexing×search
    // concurrent embed is fine.)
    executionMode: 'parallel',
    description:
      'Semantic search over the user Library'
      + (hasProject ? ' (current project + global by default)' : '')
      + '. Returns the top-k most similar chunks across processed files. Prefer this\n'
      + 'over manual directory walking / grep — the embeddings handle synonymy and\n'
      + 'cross-language matches. Call `kb_read` with the returned `scope` + `path`\n'
      + 'to fetch a full chunk or file after picking promising hits.\n'
      + 'Files still being processed (status=processing) or failed (status=failed) are\n'
      + 'excluded; the `processing` counter in the response tells you how many are in\n'
      + 'flight if you want to retry shortly.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query. Natural language works; no regex/operators.',
        },
        k: {
          type: 'number',
          description: 'Top-k result count. Default 8, max 30.',
        },
        dir: {
          type: 'string',
          description: 'Optional: limit Library search to files under this relative subdirectory.',
        },
        path: {
          type: 'string',
          description: 'Optional: limit Library search to one exact Library-relative file path. Use paths returned by kb_list.',
        },
        kind: {
          type: 'string',
          enum: [...KB_KIND_VALUES],
          description: 'Optional: restrict to one file kind.',
        },
        scope: {
          type: 'string',
          enum: hasProject ? ['all', 'project', 'global'] : ['global'],
          description: hasProject
            ? 'Search scope. Default all = current project Library plus global Library.'
            : 'Search scope. Only global is available outside a project.',
        },
      },
      required: ['query'],
    },
    async execute(input) {
      const query = String(input.query ?? '').trim();
      if (!query) return { content: 'kb_search: `query` is required', isError: true };
      const k = Math.min(30, Math.max(1, Math.floor(Number(input.k ?? 8))));
      const kind = parseKbKind(input.kind);
      const rawDir = typeof input.dir === 'string' ? input.dir.trim() : '';
      const dir = rawDir || undefined;
      const rawPath = typeof input.path === 'string' ? input.path.trim().replace(/^\/+/, '') : '';
      const filePath = rawPath || undefined;
      const scope = parseSearchScope(input.scope, hasProject);

      let vec: number[];
      try { vec = await kbEmbed.embedQuery(query); }
      catch (err) {
        const msg = (err as Error).message;
        log.warn('kb_search embed failed', {
          user_id: maskId(opts.userId),
          project_id: maskId(opts.projectId),
          query_chars: query.length,
          k,
          kind,
          scope,
          error: logErrorRef(err),
        });
        return { content: `kb_search: embedding failed — ${msg}`, isError: true };
      }

      let hits: LibraryHit[];
      try {
        const globalSearchOpts: kb.KbSearchOpts = { k };
        if (dir) globalSearchOpts.dir = dir;
        if (filePath) globalSearchOpts.path = filePath;
        if (kind) globalSearchOpts.kind = kind;
        const projectSearchOpts: kb.KbSearchOpts = { k };
        if (dir) projectSearchOpts.dir = dir;
        if (filePath) projectSearchOpts.path = filePath;
        if (kind) projectSearchOpts.kind = kind;
        const collected: LibraryHit[] = [];
        if (scope === 'global' || scope === 'all') {
          collected.push(...kb.search(opts.userId, vec, globalSearchOpts).map((h) => ({ ...h, scope: 'global' as const })));
        }
        if ((scope === 'project' || scope === 'all') && opts.projectId) {
          collected.push(...(await projectLibrary.search(opts.userId, opts.projectId, vec, projectSearchOpts))
            .map((h) => ({ ...h, scope: 'project' as const })));
        }
        collected.sort((a, b) => b.score - a.score);
        hits = collected.slice(0, k);
      } catch (err) {
        const msg = (err as Error).message;
        log.warn('kb_search query failed', {
          user_id: maskId(opts.userId),
          project_id: maskId(opts.projectId),
          query_chars: query.length,
          k,
          kind,
          scope,
          has_dir: !!dir,
          has_path: !!filePath,
          error: logErrorRef(err),
        });
        return { content: `kb_search: ${msg}`, isError: true };
      }

      const globalSummary = kb.statusSummary(opts.userId);
      const projectSummary = opts.projectId ? projectLibrary.statusSummary(opts.userId, opts.projectId) : null;
      const lines: string[] = [];
      if (!hits.length) {
        lines.push(`No results for "${query}".`);
        const processing = globalSummary.processing + (projectSummary?.processing || 0);
        const total = globalSummary.total + (projectSummary?.total || 0);
        if (processing > 0) {
          lines.push(`Note: ${processing} Library file(s) are still being processed — retry shortly.`);
        } else if (total === 0) {
          lines.push('The Library is empty.');
        }
        return { content: lines.join('\n') };
      }

      const summaryBits = [`global=${globalSummary.total}`];
      if (projectSummary) summaryBits.push(`project=${projectSummary.total}`);
      const processing = globalSummary.processing + (projectSummary?.processing || 0);
      lines.push(`${hits.length} hit(s) for "${query}" (Library ${summaryBits.join(', ')}, processing=${processing}):`);
      for (const h of hits) {
        lines.push(
          `- scope=${h.scope} path=${h.rel_path} chunk=${h.chunk_idx} kind=${h.kind} score=${h.score.toFixed(3)}`
          + (h.title ? ` title="${h.title}"` : ''),
        );
        lines.push(`    ${previewOf(h.content)}`);
      }
      return { content: lines.join('\n') };
    },
  };
}

function createKbReadTool(opts: KbToolsOpts): AgentTool {
  const hasProject = !!opts.projectId;
  return {
    name: 'kb_read',
    executionMode: 'parallel',
    description:
      'Read a Library file\'s chunk content directly from the vector store.\n'
      + 'Use the `scope` and `path` fields returned by `kb_search`. Omit `chunk`\n'
      + 'to get the concatenated full body. Pass `chunk` (1-based) with optional\n'
      + '`window` (≥0) to fetch chunk N together with its ±window\n'
      + 'neighbours — use this when the kb_search preview isn\'t enough context.\n'
      + 'Chunks are ~400 chars each, so `window: 1` ≈ 3 chunks ≈ 1.2K chars.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Library-relative path (as returned by kb_search hits).' },
        scope: {
          type: 'string',
          enum: hasProject ? ['all', 'project', 'global'] : ['global'],
          description: hasProject
            ? 'Read scope. Prefer the scope returned by kb_search. Default all tries project, then global.'
            : 'Read scope. Only global is available outside a project.',
        },
        chunk: { type: 'number', description: '1-based chunk index. Omit for full body.' },
        window: {
          type: 'number',
          description: 'Include ±window neighbour chunks around `chunk` for more context (default 0). Ignored when `chunk` is omitted.',
        },
      },
      required: ['path'],
    },
    async execute(input) {
      const relPath = String(input.path ?? '').trim();
      if (!relPath) return { content: 'kb_read: `path` is required', isError: true };
      const scope = parseReadScope(input.scope, hasProject);
      let source: {
        scope: LibraryScope;
        row: kb.KbFileRow;
        chunks: Array<{ chunk_idx: number; title: string | null; content: string }>;
      } | null = null;
      if ((scope === 'project' || scope === 'all') && opts.projectId) {
        const row = projectLibrary.getFileByPath(opts.userId, opts.projectId, relPath);
        if (row) {
          source = {
            scope: 'project',
            row,
            chunks: projectLibrary.readFileChunks(opts.userId, opts.projectId, relPath),
          };
        }
      }
      if (!source && (scope === 'global' || scope === 'all')) {
        const row = kb.getFileByPath(opts.userId, relPath);
        if (row) {
          source = {
            scope: 'global',
            row,
            chunks: kb.readFileChunks(opts.userId, relPath),
          };
        }
      }
      if (!source) return { content: `kb_read: not found — ${relPath}`, isError: true };
      const { row, chunks } = source;
      if (row.status !== 'ready') {
        return {
          content: `kb_read: file status=${row.status}${row.error ? ` (${row.error})` : ''}`,
          isError: true,
        };
      }

      if (!chunks.length) {
        return { content: `kb_read: no chunks for ${relPath}`, isError: true };
      }

      const header = `<library-file scope="${source.scope}" path="${relPath}" kind="${row.kind}" chunks="${chunks.length}" bytes="${row.bytes}">`;
      if (input.chunk != null) {
        const n = Math.floor(Number(input.chunk));
        if (!Number.isFinite(n) || n < 1 || n > chunks.length) {
          return {
            content: `kb_read: chunk ${n} out of range; total=${chunks.length}`,
            isError: true,
          };
        }
        const w = Math.max(0, Math.floor(Number(input.window ?? 0)));
        const lo = Math.max(1, n - w);
        const hi = Math.min(chunks.length, n + w);
        const parts = chunks.slice(lo - 1, hi).map((c) => {
          const hit = c.chunk_idx === n ? ' · hit' : '';
          return `<!-- chunk ${c.chunk_idx}/${chunks.length}${c.title ? ` · ${c.title}` : ''}${hit} -->\n${c.content}`;
        });
        const rangeNote = lo === hi ? `chunk ${n}` : `chunks ${lo}..${hi} (hit=${n})`;
        return { content: `${header}\n<!-- ${rangeNote} -->\n${parts.join('\n\n')}\n</library-file>` };
      }

      const body = chunks
        .map((c) => `<!-- chunk ${c.chunk_idx}/${chunks.length}${c.title ? ` · ${c.title}` : ''} -->\n${c.content}`)
        .join('\n\n');
      return { content: `${header}\n${body}\n</library-file>` };
    },
  };
}

/** Build the KB tools for one runner. */
export function createKbTools(opts: KbToolsOpts): AgentTool[] {
  return [createKbListTool(opts), createKbSearchTool(opts), createKbReadTool(opts)];
}
