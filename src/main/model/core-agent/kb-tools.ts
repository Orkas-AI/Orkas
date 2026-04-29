/**
 * KB-scoped tools injected into every main-conv runner.
 *
 *   - `kb_search` — semantic search over the user's knowledge base
 *                   (embedding-based top-k over `kb_vec`).
 *   - `kb_read`   — read a knowledge base file's chunk text back out of the
 *                   vector store (no re-parsing of the source; fast).
 *
 * These tools are read-only and need no localExec permission. They replace
 * the pre-kb-vector flow of `cat _INDEX.md` → drill into subdirs → cat files
 * (see `prompts/chat_commander.md` § 知识库 (KB) for the routing rule).
 *
 * Uses the currently-active user via `getActiveUserId()` — the tool's `uid` is
 * captured at runner build time and stays stable for the runner's lifetime
 * (per-invocation uid swap would require tearing down the runner anyway).
 */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import * as kb from '../../features/kb_vector';
import * as kbEmbed from '../../features/kb_embed';

const log = createLogger('kb-tools');

export interface KbToolsOpts {
  userId: string;
}

const PREVIEW_CHARS = 400;

function previewOf(text: string): string {
  const s = (text || '').trim();
  if (s.length <= PREVIEW_CHARS) return s;
  return s.slice(0, PREVIEW_CHARS) + '…';
}

function createKbSearchTool(opts: KbToolsOpts): AgentTool {
  return {
    name: 'kb_search',
    description:
      'Semantic search over the user knowledge base. Returns the top-k most similar\n'
      + 'chunks across all processed files. Prefer this over manual directory walking /\n'
      + 'grep — the embeddings handle synonymy and cross-language matches. Call\n'
      + '`kb_read` to fetch a full chunk or file after picking promising hits.\n'
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
          description: 'Optional: limit search to files under this knowledge-base subdirectory (relative).',
        },
        kind: {
          type: 'string',
          enum: ['text', 'pdf', 'docx', 'image'],
          description: 'Optional: restrict to one file kind.',
        },
      },
      required: ['query'],
    },
    async execute(input) {
      const query = String(input.query ?? '').trim();
      if (!query) return { content: 'kb_search: `query` is required', isError: true };
      const k = Math.min(30, Math.max(1, Math.floor(Number(input.k ?? 8))));
      const rawKind = typeof input.kind === 'string' ? (input.kind as string) : undefined;
      const kind = rawKind && ['text', 'pdf', 'docx', 'image'].includes(rawKind)
        ? (rawKind as kb.KbKind) : undefined;
      const rawDir = typeof input.dir === 'string' ? input.dir.trim() : '';
      const dir = rawDir || undefined;

      let vec: number[];
      try { vec = await kbEmbed.embedQuery(query); }
      catch (err) {
        const msg = (err as Error).message;
        log.warn(`kb_search embed failed user=${opts.userId}: ${msg}`);
        return { content: `kb_search: embedding failed — ${msg}`, isError: true };
      }

      let hits: kb.KbSearchHit[];
      try {
        const searchOpts: kb.KbSearchOpts = { k };
        if (dir) searchOpts.dir = dir;
        if (kind) searchOpts.kind = kind;
        hits = kb.search(opts.userId, vec, searchOpts);
      } catch (err) {
        const msg = (err as Error).message;
        log.warn(`kb_search query failed user=${opts.userId}: ${msg}`);
        return { content: `kb_search: ${msg}`, isError: true };
      }

      const summary = kb.statusSummary(opts.userId);
      const lines: string[] = [];
      if (!hits.length) {
        lines.push(`No results for "${query}".`);
        if (summary.processing > 0) {
          lines.push(`Note: ${summary.processing} file(s) are still being processed — retry shortly.`);
        } else if (summary.total === 0) {
          lines.push('The knowledge base is empty.');
        }
        return { content: lines.join('\n') };
      }

      lines.push(`${hits.length} hit(s) for "${query}" (kb total=${summary.total}, processing=${summary.processing}):`);
      for (const h of hits) {
        lines.push(
          `- path=${h.rel_path} chunk=${h.chunk_idx} kind=${h.kind} score=${h.score.toFixed(3)}`
          + (h.title ? ` title="${h.title}"` : ''),
        );
        lines.push(`    ${previewOf(h.content)}`);
      }
      return { content: lines.join('\n') };
    },
  };
}

function createKbReadTool(opts: KbToolsOpts): AgentTool {
  return {
    name: 'kb_read',
    description:
      'Read a knowledge base file\'s chunk content directly from the vector store.\n'
      + 'Paths are KB-relative (the `path` field returned by `kb_search`). Omit\n'
      + '`chunk` to get the concatenated full body. Pass `chunk` (1-based) with\n'
      + 'optional `window` (≥0) to fetch chunk N together with its ±window\n'
      + 'neighbours — use this when the kb_search preview isn\'t enough context.\n'
      + 'Chunks are ~400 chars each, so `window: 1` ≈ 3 chunks ≈ 1.2K chars.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'KB-relative path (as returned by kb_search hits).' },
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
      const row = kb.getFileByPath(opts.userId, relPath);
      if (!row) return { content: `kb_read: not found — ${relPath}`, isError: true };
      if (row.status !== 'ready') {
        return {
          content: `kb_read: file status=${row.status}${row.error ? ` (${row.error})` : ''}`,
          isError: true,
        };
      }

      const chunks = kb.readFileChunks(opts.userId, relPath);
      if (!chunks.length) {
        return { content: `kb_read: no chunks for ${relPath}`, isError: true };
      }

      const header = `<kb-file path="${relPath}" kind="${row.kind}" chunks="${chunks.length}" bytes="${row.bytes}">`;
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
        return { content: `${header}\n<!-- ${rangeNote} -->\n${parts.join('\n\n')}\n</kb-file>` };
      }

      const body = chunks
        .map((c) => `<!-- chunk ${c.chunk_idx}/${chunks.length}${c.title ? ` · ${c.title}` : ''} -->\n${c.content}`)
        .join('\n\n');
      return { content: `${header}\n${body}\n</kb-file>` };
    },
  };
}

/** Build the KB tool pair for one runner. */
export function createKbTools(opts: KbToolsOpts): AgentTool[] {
  return [createKbSearchTool(opts), createKbReadTool(opts)];
}
