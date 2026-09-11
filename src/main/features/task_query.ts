/** Shared bounded list receipts for backlog and scheduled tasks. Callers validate query inputs. */
export function taskSummaryPage<T>(tasks: readonly T[], offset = 0, limit = 20) {
  const page: T[] = [];
  let bytes = 0;
  for (const task of tasks.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(task), 'utf8');
    if (bytes + size > 32_000) {
      if (!page.length) throw new Error('task summary exceeds read limit');
      break;
    }
    page.push(task);
    bytes += size;
  }
  const next = offset + page.length;
  return { tasks: page, total: tasks.length, next_offset: next < tasks.length ? next : null };
}
