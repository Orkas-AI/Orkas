import type { ToolResult } from '#core-agent';
import {
  runOfficeCli, OfficeCliError,
  OFFICECLI_DEFAULT_TIMEOUT_MS, OFFICECLI_DEFAULT_MAX_OUTPUT_BYTES,
} from '../../features/office/office_engine';

type Section = {
  target: string;
  status: 'complete' | 'partial' | 'absent' | 'unavailable' | 'truncated' | 'not_read';
  content?: string;
  data?: unknown;
  error?: string;
  unread_table_paths?: string[];
};

function bodyTablePaths(stdout: string): string[] | undefined {
  const parsed = JSON.parse(stdout);
  const rows = parsed?.data?.results;
  // The native selector returns structured table nodes in document order.
  if (parsed?.success !== true || !Array.isArray(rows) || parsed.data.matches !== rows.length) return;
  if (!rows.every(row => row?.type === 'table' && typeof row.path === 'string'
    && row.path.startsWith('/body/'))) return;
  return rows.map(row => row.path);
}

/** One read scope, one source budget. The ordinary final result cap retains
 * oversized receipts losslessly; this layer reports native acquisition gaps. */
export async function readDocxText(file: string, cwd: string, signal?: AbortSignal): Promise<ToolResult> {
  const scope = ['/body', '/footnotes', '/endnotes'];
  const sections: Section[] = [];
  const deadline = performance.now() + OFFICECLI_DEFAULT_TIMEOUT_MS;
  let bytesLeft = OFFICECLI_DEFAULT_MAX_OUTPUT_BYTES;
  let stopped: 'E_OFFICE_OUTPUT_LIMIT' | 'E_OFFICE_TIMEOUT' | undefined;

  for (const target of scope) {
    if (signal?.aborted) throw new OfficeCliError('E_OFFICE_ABORTED', 'Office read cancelled.');
    const timeoutMs = Math.floor(deadline - performance.now());
    if (!stopped && timeoutMs <= 0) stopped = 'E_OFFICE_TIMEOUT';
    if (!stopped && bytesLeft <= 0) stopped = 'E_OFFICE_OUTPUT_LIMIT';
    if (stopped) {
      sections.push({ target, status: 'not_read', error: stopped });
      continue;
    }
    try {
      const body = target === '/body';
      const result = await runOfficeCli(body ? ['view', file, 'text'] : ['get', file, target, '--json'], {
        cwd, signal, timeoutMs, maxOutputBytes: bytesLeft,
      });
      bytesLeft -= Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      if (signal?.aborted) throw new OfficeCliError('E_OFFICE_ABORTED', 'Office read cancelled.');
      if (body) {
        sections.push(result.code === 0
          ? { target, status: 'complete', content: result.stdout }
          : { target, status: 'unavailable', error: 'E_OFFICE_READ_FAILED' });
        continue;
      }
      // Only the engine's structured not_found establishes an absent part.
      // A failed or malformed response must never become an empty note list.
      const parsed = JSON.parse(result.stdout);
      if (result.code === 1 && parsed?.success === false && parsed.error?.code === 'not_found') {
        sections.push({ target, status: 'absent' });
      } else if (result.code === 0 && parsed?.success === true && Array.isArray(parsed.data?.results)) {
        sections.push({ target, status: 'complete', data: parsed.data });
      } else {
        sections.push({ target, status: 'unavailable', error: 'E_OFFICE_READ_FAILED' });
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof OfficeCliError && error.code === 'E_OFFICE_ABORTED')) {
        throw new OfficeCliError('E_OFFICE_ABORTED', 'Office read cancelled.');
      }
      if (error instanceof OfficeCliError && error.code === 'E_OFFICE_OUTPUT_LIMIT') {
        stopped = error.code;
        sections.push({ target, status: 'truncated', error: stopped });
      } else {
        if (error instanceof OfficeCliError && error.code === 'E_OFFICE_TIMEOUT') stopped = error.code;
        sections.push({ target, status: 'unavailable', error: stopped ?? 'E_OFFICE_READ_FAILED' });
      }
    }
  }

  const body = sections.find(section => section.target === '/body' && section.status === 'complete');
  if (body) {
    const remainingMs = Math.floor(deadline - performance.now());
    const limit = stopped ?? (remainingMs <= 0 ? 'E_OFFICE_TIMEOUT' : bytesLeft <= 0 ? 'E_OFFICE_OUTPUT_LIMIT' : undefined);
    // The text view folds tables into placeholders. Check its coverage using
    // native structured paths, after giving body and notes their original budget.
    body.status = 'partial';
    if (limit) body.error = limit;
    else {
      try {
        const result = await runOfficeCli(['query', file, 'table', '--json'], {
          cwd, signal, timeoutMs: remainingMs, maxOutputBytes: bytesLeft,
        });
        if (signal?.aborted) throw new OfficeCliError('E_OFFICE_ABORTED', 'Office read cancelled.');
        const paths = result.code === 0 ? bodyTablePaths(result.stdout) : undefined;
        if (!paths) body.error = 'E_OFFICE_TABLE_COVERAGE_UNKNOWN';
        else if (paths.length) body.unread_table_paths = paths;
        else body.status = 'complete';
      } catch (error) {
        if (signal?.aborted || (error instanceof OfficeCliError && error.code === 'E_OFFICE_ABORTED')) {
          throw new OfficeCliError('E_OFFICE_ABORTED', 'Office read cancelled.');
        }
        body.error = error instanceof OfficeCliError && (
          error.code === 'E_OFFICE_OUTPUT_LIMIT' || error.code === 'E_OFFICE_TIMEOUT'
        ) ? error.code : 'E_OFFICE_TABLE_COVERAGE_UNKNOWN';
      }
    }
  }
  const unread = sections.filter(section => section.status !== 'complete' && section.status !== 'absent');
  const readable = sections.some(section => section.status === 'complete' || section.status === 'partial');
  return {
    content: JSON.stringify({
      status: unread.length === 0 ? 'complete' : readable ? 'partial' : 'failed',
      scope, other_regions: 'not_read',
      source_truncated: sections.some(section => section.error === 'E_OFFICE_OUTPUT_LIMIT'),
      unread_sections: unread.map(section => section.target),
      sections,
    }),
    ...(!readable ? { isError: true } : {}),
  };
}
