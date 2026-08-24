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
 * tools are the ordering barriers G4 depends on, and `ocr_file` is the one
 * explicit `'sequential'` declaration (local native OCR engine). Adding a
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

/** The one deliberate explicit `'sequential'` declaration. */
const SEQUENTIAL_DECLARED = ['ocr_file'] as const;

/** Barriers by omission whose barrier-ness is a recorded decision. */
const BARRIER_BY_OMISSION = [
  'bash',
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

  it('keeps ocr_file explicitly sequential', () => {
    for (const name of SEQUENTIAL_DECLARED) {
      const tool = byName.get(name);
      expect(tool, `${name} missing from the injected corpus`).toBeTruthy();
      expect(tool!.executionMode).toBe('sequential');
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
