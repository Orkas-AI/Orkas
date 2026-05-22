/**
 * File-scoped tools injected into every main-conv runner.
 *
 *   - `read_file`     — read a slice of a file's text by char offsets. All
 *                       kinds use `charStart` / `charEnd` (0-based, half-open);
 *                       the server does not truncate. Text works as-is; pdf/
 *                       docx require a prior `stat_file` call so this tool
 *                       never triggers extract side-effects. Image returns an
 *                       inline compressed grayscale JPEG (no range).
 *                       Overrides core-agent's builtin of the same name.
 *   - `stat_file`     — extract (if needed) and return `total_chars` for a
 *                       file. The only tool that triggers pdfjs / mammoth.
 *   - `search_files`  — locate files by name/glob across the current
 *                       conversation's attachment dir + active workspace.
 *                       Never triggers extract; `total_chars` is included
 *                       only when the cache already has it.
 *   - `grep_files`    — cross-file text search in that same scanned scope.
 *                       text/md/code → direct; pdf/docx → extract (cached);
 *                       image skipped.
 *
 * Scope is enforced via `util/path-sandbox.isPathAllowed`: path-taking tools
 * first verify the target falls under
 *   [ active workspace dir,  chat_attachments/<cid>/, project files /
 *     caller-provided extra roots ].
 * Paths outside that set return an explicit E_PATH_OUT_OF_SCOPE error.
 *
 * These tools do NOT require localExec permission — they only read from
 * paths visible to the current conv. Permission-gated tools (bash,
 * write_file) live in local-tools.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentTool, ToolContext } from '#core-agent';
import { createLogger } from '../../logger';
import {
  statFile,
  readRange,
  readImageAsGrayJpeg,
  getExtractedText,
  getCachedMeta,
  kindOf,
  NeedStatError,
  NoTextError,
} from '../../features/file_indexer';
import { chatAttachmentDir } from '../../paths';
import { getWorkspacePath } from '../../features/user_workspace';
import { isPathAllowed } from '../../util/path-sandbox';
import { parseSkillPath } from '../../features/expert_signals/skill_path';

const log = createLogger('file-tools');

// ── Tunables ──────────────────────────────────────────────────────────────

/** Hard ceiling for `search_files` / `grep_files` directory walks — protects
 *  against accidentally pointing at a huge workspace tree. */
const MAX_SCAN_FILES = 2000;

/** Max results returned by search_files per call. */
const MAX_SEARCH_RESULTS = 200;

/** Max matches returned by grep_files per call. */
const MAX_GREP_MATCHES = 200;

/** Concurrent extract workers in grep_files. PDF/DOCX cache miss path. */
const GREP_EXTRACT_CONCURRENCY = 4;

// ── Opts + scope ─────────────────────────────────────────────────────────

export interface FileToolsOpts {
  userId: string;
  /** Current conversation id. Scopes file tools to this cid's attachment
   *  dir (in addition to the user's active workspace). Omitted = no
   *  attachment scope (workspace-only). */
  cid?: string;
  /** Extra absolute directory roots to allow on top of workspace + attachment.
   *  Read AND write are permitted under these roots — used by per-skill edit
   *  chats to expose the skill dir for the `<<<skill-file>>>` tooling. */
  extraRoots?: readonly string[];
  /** Read-only extra roots: path-taking file tools (read_file / stat_file)
   *  can see these, but write-side tools (edit_file / write_file
   *  / bash / markdown_to_pdf / html_to_pdf / generate_image) cannot mutate
   *  paths inside. Used by the group-chat commander to inspect agent.json /
   *  built-in agents / skill specs without giving direct-write access — the
   *  `<agent>` / `<skill>` containers are the only sanctioned mutation
   *  channels for those resources, and a sandbox-level lock keeps the LLM
   *  honest even when its prompt strays. */
  readOnlyExtraRoots?: readonly string[];
  /** Project id of the current conversation, when it belongs to one.
   *  Threaded through from group_chat at runTurn so workspace resolution
   *  picks up the project-scoped selection (per CLAUDE.md projects feature).
   *  Empty / missing → default-scope workspace. */
  projectId?: string;
  /** Fires when `read_file` resolves to a SKILL.md path under one of the
   *  three skill roots (System A.custom / A.platform / B). Bus collects
   *  per turn for the `skill_invoked` signal. Pure callback — exceptions
   *  swallowed, never blocks the tool result. */
  onSkillInvoked?: (skill_id: string, system: 'A.custom' | 'A.platform' | 'B', trigger: 'read_file') => void;
}

/** Assemble the allowed-roots list for the current (uid, cid). File-tools
 *  read side: workspace + attachment + extraRoots + readOnlyExtraRoots. */
function allowedRoots(opts: FileToolsOpts): string[] {
  const roots: string[] = [];
  try {
    const ws = getWorkspacePath(opts.userId, opts.projectId);
    if (ws) roots.push(ws);
  } catch (err) { log.warn(`resolve workspace: ${(err as Error).message}`); }
  if (opts.cid) {
    try { roots.push(chatAttachmentDir(opts.userId, opts.cid)); }
    catch (err) { log.warn(`resolve attachment dir: ${(err as Error).message}`); }
  }
  if (opts.extraRoots?.length) {
    for (const r of opts.extraRoots) if (r) roots.push(r);
  }
  if (opts.readOnlyExtraRoots?.length) {
    for (const r of opts.readOnlyExtraRoots) if (r) roots.push(r);
  }
  return roots;
}

function resolveAbs(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.workingDir ?? '.', p);
}

function errText(code: string, msg: string): string {
  return `${code}: ${msg}`;
}

function guardPath(opts: FileToolsOpts, abs: string): string | null {
  if (!isPathAllowed(abs, allowedRoots(opts))) {
    return errText(
      'E_PATH_OUT_OF_SCOPE',
      `path is outside the current conversation's visible scope (workspace + attachments + project files): ${abs}`,
    );
  }
  return null;
}

// ── read_file ─────────────────────────────────────────────────────────────

function createReadFileTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'read_file',
    description:
      'Read a slice of a file\'s text by absolute path.\n'
      + '\n'
      + 'Parameters:\n'
      + '  path      — required. Must be inside the current workspace, this conversation\'s attachment dir, or a listed project file.\n'
      + '  charStart — 0-based inclusive start offset. Default 0.\n'
      + '  charEnd   — 0-based exclusive end offset.  Default = total_chars (end of file).\n'
      + '\n'
      + 'Response header:\n'
      + '  <file path="..." kind="..." total_chars="N" covered="a-b"> … </file>\n'
      + '  `covered` echoes the clamped [charStart, charEnd) actually returned.\n'
      + '\n'
      + 'How to use:\n'
      + '  - Whole file: omit charStart/charEnd. Header tells you total_chars.\n'
      + '  - Continue: set charStart = previous response\'s covered end.\n'
      + '  - total_chars is usually already in the `<attachments>` manifest or in a prior\n'
      + '    `search_files` hit — use it to plan charStart/charEnd.\n'
      + '  - If a pdf/docx has never been read/stated before, this tool returns E_NEED_STAT.\n'
      + '    Call `stat_file(path)` first to trigger extraction, then come back.\n'
      + '  - For image kind, no range applies; a compressed grayscale JPEG is returned inline\n'
      + '    as a user-turn image.\n'
      + '\n'
      + 'The server does NOT truncate and has NO size cap — you receive exactly the range you ask for.\n'
      + 'You are responsible for your own context budget.',
    inputSchema: {
      type: 'object',
      properties: {
        path:      { type: 'string', description: 'Absolute path. Must be inside workspace, current attachment dir, or project files.' },
        charStart: { type: 'number', description: '0-based start char (inclusive). Default 0.' },
        charEnd:   { type: 'number', description: '0-based end char (exclusive). Default total_chars.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const abs = resolveAbs(ctx, raw);

      const scopeErr = guardPath(opts, abs);
      if (scopeErr) {
        log.warn(`read_file scope reject user=${opts.userId} path=${abs}`);
        return { content: scopeErr, isError: true };
      }

      try { fs.statSync(abs); }
      catch (err) {
        const siblings = findUniquifySiblings(abs);
        log.warn(`read_file not-found user=${opts.userId} path=${abs}: ${(err as Error).message}`);
        let content = errText('E_NOT_FOUND', `${abs}: ${(err as Error).message}`);
        if (siblings.length) {
          content +=
            '\n\n<file-renamed-earlier>\n'
            + 'This name was uniquified earlier in this conversation. Existing variants in the same directory:\n'
            + siblings.map((b) => `  - ${b}`).join('\n')
            + '\nUse one of those paths instead — the original requested name was never written.\n'
            + '</file-renamed-earlier>';
        }
        return { content, isError: true };
      }

      const kind = kindOf(abs);
      try {
        if (kind === 'image') {
          const img = await readImageAsGrayJpeg(opts.userId, abs);
          const header = `<file path="${abs}" kind="image" bytes="${img.bytes}" compressed="${img.width}x${img.height} gray JPEG q=70"/>`;
          log.info(`read_file user=${opts.userId} kind=image bytes=${img.bytes} path=${abs}`);
          return {
            content: `${header}\nImage loaded — the compressed grayscale JPEG follows as a user-turn image.`,
            images: [{ data: img.base64, mediaType: img.mediaType }],
          };
        }

        const result = await readRange(opts.userId, abs, {
          ...(typeof input.charStart === 'number' ? { charStart: input.charStart } : {}),
          ...(typeof input.charEnd   === 'number' ? { charEnd:   input.charEnd   } : {}),
        });

        const total = result.meta.totalChars ?? 0;
        const cs = result.range.charStart;
        const ce = result.range.charEnd;
        const attrs = [
          `path="${abs}"`,
          `kind="${kind}"`,
          `total_chars="${total}"`,
          `covered="${cs}-${ce}"`,
        ];
        const header = `<file ${attrs.join(' ')}>`;
        log.info(
          `read_file user=${opts.userId} kind=${kind} covered=${cs}-${ce} total=${total} path=${abs}`,
        );
        // skill_invoked attribution: when the LLM read_file's a SKILL.md
        // body, the body is the progressive-disclosure "use this skill"
        // signal (per Claude Code conventions). Emit AFTER the successful
        // text read — image / pdf / docx SKILL.md is not a real shape.
        if (opts.onSkillInvoked) {
          const parsed = parseSkillPath(abs, opts.userId);
          if (parsed) {
            try { opts.onSkillInvoked(parsed.skill_id, parsed.system, 'read_file'); }
            catch (err) { log.warn(`onSkillInvoked callback failed: ${(err as Error).message}`); }
          }
        }
        return { content: `${header}\n${result.content}\n</file>` };
      } catch (err) {
        if (err instanceof NeedStatError) {
          log.warn(`read_file need-stat user=${opts.userId} kind=${err.kind} path=${abs}`);
          return {
            content: errText(
              'E_NEED_STAT',
              `${abs}: ${err.kind} has not been extracted yet. Call stat_file(path=...) first to get total_chars, then call read_file with charStart/charEnd.`,
            ),
            isError: true,
          };
        }
        if (err instanceof NoTextError) {
          log.warn(`read_file no-text user=${opts.userId} path=${abs}`);
          return { content: errText('E_NO_TEXT', `${abs}: image has no text representation`), isError: true };
        }
        const msg = (err as Error).message;
        log.warn(`read_file failed user=${opts.userId} path=${abs}: ${msg}`);
        return { content: errText('E_READ_FAILED', msg), isError: true };
      }
    },
  };
}

// ── stat_file ────────────────────────────────────────────────────────────

function createStatFileTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'stat_file',
    description:
      'Ensure a file\'s text is extracted and return its `total_chars`. Use this when the\n'
      + '`<attachments>` manifest or a `search_files` result did NOT already include\n'
      + '`total_chars` for the file — typically for a pdf/docx that has never been read.\n'
      + '\n'
      + 'Parameters:\n'
      + '  path — required. Absolute path inside workspace, current attachment dir, or project files.\n'
      + '\n'
      + 'Response:\n'
      + '  <file path="..." kind="text|pdf|docx" total_chars="N"/>\n'
      + '\n'
      + 'Notes:\n'
      + '  - Skip this call when total_chars is already provided — go straight to read_file.\n'
      + '  - This tool does the pdfjs / mammoth extraction; first call on a large pdf may\n'
      + '    take a few seconds, subsequent read_file calls hit the cache instantly.\n'
      + '  - Returns E_NO_TEXT for image kind; images are displayed via read_file directly.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path. Must be inside workspace, current attachment dir, or project files.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const abs = resolveAbs(ctx, raw);

      const scopeErr = guardPath(opts, abs);
      if (scopeErr) {
        log.warn(`stat_file scope reject user=${opts.userId} path=${abs}`);
        return { content: scopeErr, isError: true };
      }

      try { fs.statSync(abs); }
      catch (err) {
        log.warn(`stat_file not-found user=${opts.userId} path=${abs}: ${(err as Error).message}`);
        return { content: errText('E_NOT_FOUND', `${abs}: ${(err as Error).message}`), isError: true };
      }

      const kind = kindOf(abs);
      try {
        const meta = await statFile(opts.userId, abs);
        const total = meta.totalChars ?? 0;
        log.info(`stat_file user=${opts.userId} kind=${kind} total_chars=${total} path=${abs}`);
        return {
          content: `<file path="${abs}" kind="${kind}" total_chars="${total}"/>`,
        };
      } catch (err) {
        if (err instanceof NoTextError) {
          log.warn(`stat_file no-text user=${opts.userId} path=${abs}`);
          return { content: errText('E_NO_TEXT', `${abs}: image has no text representation`), isError: true };
        }
        const msg = (err as Error).message;
        log.warn(`stat_file failed user=${opts.userId} path=${abs}: ${msg}`);
        return { content: errText('E_STAT_FAILED', msg), isError: true };
      }
    },
  };
}

// ── search_files ─────────────────────────────────────────────────────────

interface SearchHit {
  path: string;
  name: string;
  size: number;
  mtime: number;
  ext: string;
  source: 'attachment' | 'workspace';
  /** Only present when a fresh cache entry is already on disk. Never
   *  triggers extract just to populate this field. */
  totalChars?: number;
}

function compileMatcher(query: string): (name: string) => boolean {
  const q = query.trim();
  if (!q) return () => true;
  const hasGlob = /[*?[]/.test(q);
  if (hasGlob) {
    const re = new RegExp(
      '^' + q.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i',
    );
    return (name) => re.test(name);
  }
  const lower = q.toLowerCase();
  return (name) => name.toLowerCase().includes(lower);
}

function walkFiles(root: string, max: number): string[] {
  const out: string[] = [];
  if (!root) return out;
  let rootStat: fs.Stats;
  try { rootStat = fs.statSync(root); }
  catch { return out; }
  if (!rootStat.isDirectory()) return out;

  const stack: string[] = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        out.push(p);
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

function createSearchFilesTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'search_files',
    description:
      'Discover files when you do NOT already have the path. Scans the active workspace +\n'
      + 'the current conversation\'s attachment dir.\n'
      + 'Query forms:\n'
      + '  • substring (case-insensitive): "contract" matches "Contract_v2.pdf"\n'
      + '  • glob:                         "*.pdf", "design*"\n'
      + 'Returns each hit with path/name/size/mtime/ext/source. If the file\'s text has\n'
      + 'already been extracted (cache hit), `total_chars` is also included — use it to\n'
      + 'plan read_file without an extra stat_file round-trip. If `total_chars` is absent,\n'
      + 'you need `stat_file(path)` before your first read_file on that file.\n'
      + 'This tool does NOT trigger extract — it stays cheap even over large directories.\n'
      + 'Use this when:\n'
      + '  • the user names a file that is NOT in the current <attachments> block — try here\n'
      + '    before telling them the file is missing; the workspace is in scope too\n'
      + '  • the user refers to a file by a fuzzy phrase ("the contract")\n'
      + '  • exploring the workspace for files matching a pattern\n'
      + 'Do NOT call this on a filename that is already listed in <attachments> — the `path`\n'
      + 'attribute there is the authoritative absolute path; feed it straight to `read_file`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring or glob. Omit to list everything.' },
      },
    },
    async execute(input) {
      const query = String(input.query ?? '');
      const matcher = compileMatcher(query);
      const roots = allowedRoots(opts);
      if (!roots.length) {
        return { content: errText('E_NO_SCOPE', 'no visible roots for this conversation'), isError: true };
      }

      const rootKinds: Array<{ root: string; source: 'attachment' | 'workspace' }> = [];
      try {
        rootKinds.push({ root: getWorkspacePath(opts.userId, opts.projectId), source: 'workspace' });
      } catch { /* workspace unavailable → skip */ }
      if (opts.cid) {
        rootKinds.push({ root: chatAttachmentDir(opts.userId, opts.cid), source: 'attachment' });
      }

      const hits: SearchHit[] = [];
      let budget = MAX_SCAN_FILES;
      for (const { root, source } of rootKinds) {
        if (budget <= 0) break;
        const files = walkFiles(root, budget);
        budget -= files.length;
        for (const abs of files) {
          const name = path.basename(abs);
          if (!matcher(name)) continue;
          let st: fs.Stats;
          try { st = fs.statSync(abs); }
          catch { continue; }
          const ext = path.extname(name).toLowerCase();
          const hit: SearchHit = {
            path: abs,
            name,
            size: st.size,
            mtime: Math.floor(st.mtimeMs),
            ext,
            source,
          };
          // Only include total_chars when a cache entry already exists — never
          // trigger extract from a search. Model can call stat_file if needed.
          const cached = getCachedMeta(opts.userId, abs);
          if (cached?.totalChars !== undefined) hit.totalChars = cached.totalChars;
          hits.push(hit);
          if (hits.length >= MAX_SEARCH_RESULTS) break;
        }
        if (hits.length >= MAX_SEARCH_RESULTS) break;
      }

      hits.sort((a, b) => b.mtime - a.mtime);
      if (!hits.length) {
        return { content: query ? `No matches for "${query}".` : 'No files found.' };
      }
      const lines = hits.map((h) => {
        const bits = [
          `path=${h.path}`,
          `size=${h.size}`,
          `mtime=${new Date(h.mtime).toISOString()}`,
          `source=${h.source}`,
          ...(h.totalChars !== undefined ? [`total_chars=${h.totalChars}`] : []),
        ];
        return `- ${h.name}  (${bits.join(', ')})`;
      });
      log.info(`search_files user=${opts.userId} query="${query}" hits=${hits.length}`);
      return { content: `${hits.length} match(es):\n${lines.join('\n')}` };
    },
  };
}

// ── grep_files ───────────────────────────────────────────────────────────

interface GrepHit {
  path: string;
  line: number;
  snippet: string;
  source: 'attachment' | 'workspace';
}

async function pMapLimit<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  const n = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: n }, () => worker());
  await Promise.all(workers);
  return out;
}

function createGrepFilesTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'grep_files',
    description:
      'Search for a pattern across files visible to this conversation (workspace + attachment dir).\n'
      + 'File type handling:\n'
      + '  • text / md / csv / code → searched directly on the source file\n'
      + '  • pdf / docx             → extracted to text (cached) and searched\n'
      + '  • images / binaries      → skipped\n'
      + 'First cross-file grep on a fresh set of pdfs/docx may be slow (parallel extract);\n'
      + 'subsequent calls in the same session are cached. Use `search_files` to narrow the\n'
      + 'set before grepping when the scope is large.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Pattern to search for.' },
        regex: { type: 'boolean', description: 'Default false — treat pattern as a case-insensitive substring.' },
      },
      required: ['pattern'],
    },
    async execute(input) {
      const pattern = String(input.pattern ?? '');
      if (!pattern) {
        return { content: errText('E_BAD_INPUT', '`pattern` is required'), isError: true };
      }
      const useRegex = input.regex === true;
      let matcher: RegExp;
      try {
        matcher = useRegex
          ? new RegExp(pattern, 'i')
          : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      } catch (err) {
        return { content: errText('E_BAD_INPUT', `invalid regex: ${(err as Error).message}`), isError: true };
      }

      const rootKinds: Array<{ root: string; source: 'attachment' | 'workspace' }> = [];
      try { rootKinds.push({ root: getWorkspacePath(opts.userId, opts.projectId), source: 'workspace' }); }
      catch { /* workspace unavailable */ }
      if (opts.cid) rootKinds.push({ root: chatAttachmentDir(opts.userId, opts.cid), source: 'attachment' });
      if (!rootKinds.length) {
        return { content: errText('E_NO_SCOPE', 'no visible roots for this conversation'), isError: true };
      }

      const targets: Array<{ abs: string; source: 'attachment' | 'workspace' }> = [];
      let budget = MAX_SCAN_FILES;
      for (const { root, source } of rootKinds) {
        if (budget <= 0) break;
        const files = walkFiles(root, budget);
        budget -= files.length;
        for (const abs of files) targets.push({ abs, source });
      }

      let scanned = 0, skipped = 0, extracted = 0;
      const hits: GrepHit[] = [];

      // Split into text-direct vs extract-required buckets. Text bucket is
      // fast (sync read + scan); extract bucket is bounded-concurrency async.
      const textTargets = targets.filter((t) => {
        const k = kindOf(t.abs);
        if (k === 'image') return false;
        return k === 'text';
      });
      const extractTargets = targets.filter((t) => {
        const k = kindOf(t.abs);
        return k === 'pdf' || k === 'docx';
      });
      // Images + unknown → skipped
      skipped += targets.length - textTargets.length - extractTargets.length;

      // Text bucket — synchronous line scan.
      for (const t of textTargets) {
        scanned++;
        let body: string;
        try { body = fs.readFileSync(t.abs, 'utf8'); }
        catch { continue; }
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matcher.test(lines[i])) {
            hits.push({ path: t.abs, line: i + 1, snippet: snippetFromLine(lines[i], matcher), source: t.source });
            if (hits.length >= MAX_GREP_MATCHES) break;
          }
        }
        if (hits.length >= MAX_GREP_MATCHES) break;
      }

      // Extract bucket — parallel extract with cache, then line scan.
      if (hits.length < MAX_GREP_MATCHES && extractTargets.length) {
        await pMapLimit(extractTargets, GREP_EXTRACT_CONCURRENCY, async (t) => {
          if (hits.length >= MAX_GREP_MATCHES) return;
          scanned++;
          let text: string;
          try {
            const { text: got } = await getExtractedText(opts.userId, t.abs);
            text = got;
            extracted++;
          } catch (err) {
            log.warn(`grep_files: extract failed ${t.abs}: ${(err as Error).message}`);
            return;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= MAX_GREP_MATCHES) return;
            if (matcher.test(lines[i])) {
              hits.push({ path: t.abs, line: i + 1, snippet: snippetFromLine(lines[i], matcher), source: t.source });
            }
          }
        });
      }

      log.info(
        `grep_files user=${opts.userId} pattern=${useRegex ? `/${pattern}/i` : `"${pattern}"`}`
        + ` hits=${hits.length} scanned=${scanned} extracted=${extracted} skipped=${skipped}`,
      );
      if (!hits.length) {
        return {
          content:
            `No matches for ${useRegex ? `/${pattern}/i` : `"${pattern}"`}.\n`
            + `scanned=${scanned} extracted=${extracted} skipped=${skipped}`,
        };
      }
      const lines = hits.map((h) => `  ${h.path}:${h.line}  ${h.snippet}`);
      const header = `${hits.length} match(es)`
        + (hits.length >= MAX_GREP_MATCHES ? ` (capped at ${MAX_GREP_MATCHES})` : '')
        + `  scanned=${scanned} extracted=${extracted} skipped=${skipped}`;
      return { content: `${header}\n${lines.join('\n')}` };
    },
  };
}

/** Scan `path.parse(absPath).dir` for siblings matching `<name>-N<ext>` —
 *  the shape produced by `util/uniquify-path.uniquifyPath` when an earlier
 *  write hit a collision. Returned newest-first by N. Tolerates a missing
 *  parent dir (returns []). Used by `read_file`'s ENOENT branch as a hint
 *  signal so the LLM is reminded of the rename without having to grep its
 *  own tool history. */
function findUniquifySiblings(absPath: string): string[] {
  const { dir, name, ext } = path.parse(absPath);
  if (!dir) return [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); }
  catch { return []; }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(name)}-(\\d+)${esc(ext)}$`);
  const matches: Array<{ basename: string; n: number }> = [];
  for (const e of entries) {
    const m = re.exec(e);
    if (m) matches.push({ basename: e, n: parseInt(m[1], 10) });
  }
  matches.sort((a, b) => a.n - b.n);
  return matches.map((m) => m.basename);
}

function snippetFromLine(line: string, matcher: RegExp): string {
  const m = matcher.exec(line);
  if (!m) return line.slice(0, 160);
  const mid = m.index;
  const lo = Math.max(0, mid - 40);
  const hi = Math.min(line.length, mid + m[0].length + 40);
  return (lo > 0 ? '…' : '') + line.slice(lo, hi).replace(/\s+/g, ' ').trim() + (hi < line.length ? '…' : '');
}

// ── Factory ──────────────────────────────────────────────────────────────

export function createFileTools(opts: FileToolsOpts): AgentTool[] {
  return [
    createReadFileTool(opts),
    createStatFileTool(opts),
    createSearchFilesTool(opts),
    createGrepFilesTool(opts),
  ];
}
