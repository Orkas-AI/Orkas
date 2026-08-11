import { describe, expect, it } from 'vitest';

import {
  parentEdlLinkOf,
  summarizeVideoProductionState,
  type VideoProductionCandidateRevision,
  type VideoProductionStateV1,
} from '../../../src/main/features/video_studio_state';

function candidate(index: number): VideoProductionCandidateRevision {
  return {
    revision_id: `candidate-${index}`,
    content_hash: String(index).padStart(64, '0'),
    visual_signature: String(index).padStart(64, 'a'),
    artifacts: { composition_signature: String(index).padStart(64, 'b') },
    // The bulk of a real revision: locators plus a content-addressed snapshot.
    locators: {
      html_path: `/w/render/rev-${index}/index.html`,
      manifest_path: `/w/render/rev-${index}/composition-manifest.json`,
      preview_path: `/w/render/rev-${index}/preview.png`,
      frame_paths: Array.from({ length: 8 }, (_, f) => `/w/render/rev-${index}/frame-${f}.png`),
      findings_path: `/w/render/rev-${index}/findings.json`,
      report_path: `/w/render/rev-${index}/report.json`,
    },
    snapshot: {
      root_path: `/w/snapshots/rev-${index}`,
      manifest_path: `/w/snapshots/rev-${index}/composition-manifest.json`,
      source_file_count: 6,
      source_total_bytes: 120_000,
      locators: { html_path: `/w/snapshots/rev-${index}/index.html` },
      updated_at: '2026-08-04T10:00:00.000Z',
    },
    runtime_fingerprint: 'fingerprint',
    created_at: '2026-08-04T10:00:00.000Z',
    last_observed_at: '2026-08-04T10:00:00.000Z',
    last_observed_op: 'composition.snapshot',
  };
}

function stateWith(historyLength: number, journalLength: number): VideoProductionStateV1 {
  return {
    schema_version: 1,
    revision: 40,
    composition_dir: '/w/project/composition',
    stage: 'preview_ready',
    artifacts: { composition_signature: 'c'.repeat(64) },
    candidate_history: Array.from({ length: historyLength }, (_, index) => candidate(index)),
    operation_journal: Array.from({ length: journalLength }, (_, index) => ({
      op: 'composition.snapshot',
      status: 'passed' as const,
      recorded_at: `2026-08-04T10:${String(index).padStart(2, '0')}:00.000Z`,
      signature: String(index).padStart(64, 'd'),
    })),
    history: [],
    created_at: '2026-08-04T09:00:00.000Z',
    updated_at: '2026-08-04T11:00:00.000Z',
  } as VideoProductionStateV1;
}

describe('production state summary payload', () => {
  it('counts superseded revisions instead of carrying them', () => {
    // Measured on the 2026-08-04 run: 202 native results totalling 15.0MB with
    // a 62KB median, and the size was uniform rather than driven by a few large
    // failures. Half of every returned byte was durable state echoed back in
    // full — candidate_history alone 33%, the journal 8% — while no prompt or
    // skill asks the model to read either. That pass bounded both to a tail;
    // the entries left entirely on 2026-08-08, when the one thing that read
    // them (an assembled segment falling back to its last rendered revision)
    // turned out to restore nothing and to have been wired to a key its
    // consumer never read.
    const summary = summarizeVideoProductionState(stateWith(15, 100)) as Record<string, any>;

    expect(summary).not.toHaveProperty('candidate_history');
    expect(summary.operation_journal).toHaveLength(10);
    // Counts stay exact so "how many revisions exist" survives the trim.
    expect(summary.candidate_history_count).toBe(15);
    expect(summary.operation_journal_count).toBe(100);

    const full = JSON.stringify(stateWith(15, 100)).length;
    const trimmed = JSON.stringify(summary).length;
    expect(trimmed).toBeLessThan(full * 0.2);
  });

  it('keeps the newest journal entries, not the oldest', () => {
    // The journal appends at the end, so the tail is the recent end. Slicing
    // the wrong end would silently hand the model operations it has already
    // moved past — a stale-evidence bug no size assertion would catch.
    const summary = summarizeVideoProductionState(stateWith(15, 100)) as Record<string, any>;

    expect(summary.operation_journal.at(-1).recorded_at).toBe('2026-08-04T10:99:00.000Z');
    expect(summary.operation_journal[0].recorded_at).toBe('2026-08-04T10:90:00.000Z');
  });

  it('drops only the journal fields a reader cannot act on', () => {
    // `operation_id` is a uuid and `input_hash` is a content address: a model
    // can compute neither, and the repeated-input question they would answer is
    // decided host-side and returned as `same_input_attempts` by the operation
    // that needs it. Everything an entry says about what happened stays.
    const state = stateWith(1, 1);
    state.operation_journal[0] = {
      ...state.operation_journal[0],
      operation_id: 'op-uuid',
      input_hash: 'e'.repeat(64),
      turn_id: 'turn-7',
      findings_path: '/w/project/composition/qa/snapshot.json',
    } as typeof state.operation_journal[0];
    const [entry] = (summarizeVideoProductionState(state) as Record<string, any>).operation_journal;

    expect(entry).not.toHaveProperty('operation_id');
    expect(entry).not.toHaveProperty('input_hash');
    expect(entry).toMatchObject({
      op: 'composition.snapshot',
      status: 'passed',
      turn_id: 'turn-7',
      findings_path: '/w/project/composition/qa/snapshot.json',
    });
  });

  it('reports a short record whole', () => {
    // Negative control: the bound must not truncate a project that has simply
    // not produced much yet.
    const summary = summarizeVideoProductionState(stateWith(1, 3)) as Record<string, any>;

    expect(summary.operation_journal).toHaveLength(3);
    expect(summary.candidate_history_count).toBe(1);
    expect(summary.operation_journal_count).toBe(3);
  });
});

describe('parentEdlLinkOf', () => {
  const linked = {
    gate: 'B',
    signature: 'sig-linked',
    artifact_paths: [],
    validation_version: 3,
    inheritance_reason: 'parent_edl_segment',
    parent_plan_path: '/ws/project/plan.json',
    parent_segment_id: 's3_reveal',
  } as VideoProductionStateV1['plan_approval'];

  it('reads the link from the current approval', () => {
    expect(parentEdlLinkOf({ plan_approval: linked } as VideoProductionStateV1))
      .toEqual({ planPath: '/ws/project/plan.json', segmentId: 's3_reveal' });
  });

  it('falls back to the newest history entry when a re-sign dropped the link', () => {
    // The 2026-08-06 run shape: an amendment re-signed four child approvals
    // without resolving the parent. Structure survives in history, and every
    // consumer (review grouping, delivered-opening) must read it the same way
    // — reading only the current approval turned mid-film segments back into
    // "the delivered opening" and cover-blocked them.
    const state = {
      plan_approval: { gate: 'B', signature: 'resigned', artifact_paths: [], validation_version: 3 },
      plan_approval_history: [
        { ...linked, signature: 'sig-old-1', parent_segment_id: 'stale-entry' },
        linked,
      ],
    } as unknown as VideoProductionStateV1;
    expect(parentEdlLinkOf(state))
      .toEqual({ planPath: '/ws/project/plan.json', segmentId: 's3_reveal' });
  });

  it('reports no link for a standalone composition', () => {
    expect(parentEdlLinkOf({
      plan_approval: { gate: 'B', signature: 'solo', artifact_paths: [], validation_version: 3 },
    } as unknown as VideoProductionStateV1)).toEqual({ planPath: '', segmentId: '' });
    expect(parentEdlLinkOf(undefined)).toEqual({ planPath: '', segmentId: '' });
  });
});
