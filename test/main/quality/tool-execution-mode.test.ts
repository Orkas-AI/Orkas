import { describe, expect, it } from 'vitest';

import type { AgentTool } from '../../../src/core-agent/src/tools';
import { enumerateAllInjectedTools } from '../model/core-agent/injected-tool-fixture';

/**
 * Execution-mode contract pin for the injected tool corpus.
 *
 * `partitionToolBatches` runs adjacent `executionMode: 'parallel'` calls
 * concurrently; anything undeclared is a barrier. The declaration is invisible
 * to the model and to users — losing one has no failing test, no log, and no
 * visible symptom except read-dense rounds quietly running serial. That exact
 * regression shipped twice: the result-cap wrapper once dropped the flag for
 * every wrapped tool (pinned since in tool-result-cap.test.ts), and the
 * web_search override once replaced the parallel builtin with an undeclared
 * copy (see the comment at its `executionMode` in search-tools.ts).
 *
 * The barrier side is equally deliberate: office tools stay sequential per the
 * R-4 ruling (same-file concurrency failed 5/6 in production shape —
 * `Common/docs/reviews/2026-08-11-agent-optimization-review.md`), write/exec
 * tools are the ordering barriers G4 depends on. `bash` sits between the two
 * lists since 2026-09-18: it declares parallel but refines it per call with
 * `parallelWhen`, and only a command the host can prove read-only is admitted
 * (`bashCommandIsProvablyReadOnly`); a write, `sed -i`, `npm`, `node -e` or a
 * `cd` is a barrier exactly as under R-4. That decision superseded the
 * 2026-09-17 unconditional shell opt-in after the same-cwd attribution and
 * dependent-command risks were reviewed (review 2026-09-17, F-1). Adding a
 * tool to PARALLEL_DECLARED is a reviewed decision that belongs with a
 * concurrency-safety argument at the declaration site, not a drive-by.
 * (2026-08-16 latency review P0-3 closed with exactly that verdict: pin the
 * current surface, add no new declarations — the undeclared read-only tools
 * appear too rarely in fan-out batches to buy anything.)
 */

/** Declared parallel today; every entry is a high-frequency read surface. */
const PARALLEL_DECLARED = [
  'read_files',
  'search_files',
  'grep_files',
  'list_files',
  'pdf_render',
  'library',
  'chat_history',
  'web_search',
  'web_fetch',
  'workspace_diff',
  'process_session',
] as const;

/** Declared parallel but admitted per call; the predicate is the contract. */
const CONDITIONALLY_PARALLEL = ['bash'] as const;

/** Barriers by omission whose barrier-ness is a recorded decision. */
const BARRIER_BY_OMISSION = [
  'write_file',
  'append_file',
  'edit_file',
  'delete_file',
  'apply_patch',
  'create_docx',
  'create_xlsx',
  'create_pptx',
  'office_read',
  'office_review',
  'edit_office',
] as const;

describe('injected tool execution modes', () => {
  const byName = new Map<string, AgentTool>(
    enumerateAllInjectedTools().map((tool) => [tool.name, tool]),
  );

  it('keeps every high-frequency read tool declared parallel', () => {
    for (const name of PARALLEL_DECLARED) {
      const tool = byName.get(name);
      expect(tool, `${name} missing from the injected corpus — a rename or factory change vacated this pin`).toBeTruthy();
      expect(
        tool!.executionMode,
        `${name} lost its parallel declaration; read-dense rounds run serial with no other symptom`,
      ).toBe('parallel');
    }
  });

  it('admits bash concurrently only for commands it can prove read-only', () => {
    for (const name of CONDITIONALLY_PARALLEL) {
      const tool = byName.get(name);
      expect(tool, `${name} missing from the injected corpus`).toBeTruthy();
      expect(tool!.executionMode, `${name} must declare parallel so its refinement is consulted`).toBe('parallel');
      expect(typeof tool!.parallelWhen, `${name} lost its per-call refinement; every call would overlap`).toBe('function');
      const admits = (command: string) => tool!.parallelWhen!({ command });
      // Read-only shapes overlap.
      expect(admits('cat README.md')).toBe(true);
      expect(admits('grep -rn TODO src | head -20')).toBe(true);
      expect(admits('ls -la && pwd')).toBe(true);
      expect(admits('find . -name "*.ts" -type f')).toBe(true);
      expect(admits('sleep 1 && date')).toBe(true);
      // Anything that writes, runs an interpreter, changes directory, or
      // hides a command stays a barrier — the R-4 failure shape.
      expect(admits('echo hi > out.txt')).toBe(false);
      expect(admits('cat a.log >> all.log')).toBe(false);
      expect(admits("sed -i 's/a/b/' f.txt")).toBe(false);
      expect(admits('npm test')).toBe(false);
      expect(admits('node -e "process.exit(0)"')).toBe(false);
      expect(admits('cd src && ls')).toBe(false);
      expect(admits('ls $(pwd)')).toBe(false);
      expect(admits('find . -name "*.tmp" -exec rm {} \\;')).toBe(false);
      expect(admits('')).toBe(false);
    }
  });

  it('keeps decided barriers out of parallel batches', () => {
    for (const name of BARRIER_BY_OMISSION) {
      const tool = byName.get(name);
      expect(tool, `${name} missing from the injected corpus`).toBeTruthy();
      expect(
        tool!.executionMode,
        `${name} became parallel; write/exec ordering and the office R-4 ruling forbid this without review`,
      ).not.toBe('parallel');
    }
  });
});
