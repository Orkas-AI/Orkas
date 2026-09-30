import { createModelEvalLogCollector } from '../../../scripts/model-eval-log-policy.mjs';

export interface RecoveredRendererRange { start: number; end: number; diagnosticIndex: number }

/** Preserve raw logs and original severity, then classify only host-attributed
 * renderer records whose recovery has been independently verified. */
export function analyzeWebAppLogs(log: string, recovered: readonly RecoveredRendererRange[] = []) {
  const original = createModelEvalLogCollector('web-app-generation');
  const reviewed = createModelEvalLogCollector('web-app-generation');
  const lines = log.split(/\r?\n/);
  const starts = new Set<number>();
  for (const range of recovered) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)
      || range.start < 1 || range.end < range.start || range.end > lines.length
      || !/^\[renderer:(?:error|pageerror)\] /.test(lines[range.start - 1])) {
      throw new Error('Invalid recovered renderer diagnostic range');
    }
    starts.add(range.start);
  }
  let stream = 'stdout';
  for (const [index, raw] of lines.entries()) {
    let line = raw;
    const prefix = /^\[(main|renderer):([^\]]+)\] ?/.exec(line);
    if (prefix) {
      stream = prefix[1] === 'main' && prefix[2] === 'stderr' ? 'stderr' : 'stdout';
      line = line.slice(prefix[0].length);
      if (prefix[1] === 'renderer' && ['warning', 'error', 'pageerror'].includes(prefix[2])) {
        line = `[00:00:00.000] [${prefix[2] === 'warning' ? 'warn' : 'error'}] [(renderer)] ${line}`;
      }
    }
    if (/^===/.test(line)) stream = 'stdout';
    if (/^Debugger (?:listening|ending) on ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/.test(line)
      || line === 'For help, see: https://nodejs.org/learn/getting-started/debugging'
      || line === 'Waiting for the debugger to disconnect...') {
      original.ingest('stdout', '[playwright-debugger] lifecycle\n');
      reviewed.ingest('stdout', '[playwright-debugger] lifecycle\n');
      continue;
    }
    if (line.startsWith('[fixture-cleanup] ')) {
      original.ingest('stdout', line + '\n');
      reviewed.ingest('stdout', line + '\n');
      continue;
    }
    line = line.replace(/^\[\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}\.\d{3})\]/, '[$1]');
    original.ingest(stream, line + '\n');
    reviewed.ingest(stream, (starts.has(index + 1)
      ? `[00:00:00.000] [warn] [(preview-recovery)] Recovered renderer ${prefix![2]} retained at raw log line ${index + 1}`
      : line) + '\n');
  }
  const initial = original.finish();
  return { ...reviewed.finish(), originalLevelCounts: initial.levelCounts, originalFindings: initial.findings,
    recoveredRendererErrorCount: starts.size, recoveredRendererRanges: recovered };
}
