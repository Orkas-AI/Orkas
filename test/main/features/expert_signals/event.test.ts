import { describe, it, expect } from 'vitest';
import {
  buildRetrySignal,
  buildSkipSignal,
  buildFormLeftBlankSignals,
  buildToolFailureSignal,
} from '../../../../src/main/features/expert_signals/extractors/event';

describe('expert_signals.event › retry/skip builders', () => {
  it('retry: stamps step_index in metadata', () => {
    const sig = buildRetrySignal({
      cid: 'c1', aid: 'a1', turn_id: 't1', step_index: 3,
    });
    expect(sig.type).toBe('retry');
    expect(sig.aid).toBe('a1');
    expect(sig.metadata?.step_index).toBe(3);
  });

  it('skip: same shape as retry but type=skip', () => {
    const sig = buildSkipSignal({
      cid: 'c1', aid: 'a1', turn_id: 't1', step_index: 3,
    });
    expect(sig.type).toBe('skip');
    expect(sig.metadata?.step_index).toBe(3);
  });
});

describe('expert_signals.event › form_left_blank', () => {
  const fields = [
    { id: 'project_dir', required: true,  default: '' },
    { id: 'review_depth', type: 'select', required: false, default: 'quick' },
    { id: 'target_branch', type: 'text',  required: false, default: 'main' },
  ];

  it('positive: required field empty → emits with was_required=true', () => {
    const out = buildFormLeftBlankSignals({
      cid: 'c1', aid: 'a1', turn_id: 't1', msg_id: 'm1',
      fields,
      values: { project_dir: '', review_depth: 'quick', target_branch: 'main' },
    });
    const projectDir = out.find((s) => (s.metadata as any)?.input_id === 'project_dir');
    expect(projectDir).toBeDefined();
    expect(projectDir!.metadata!.was_required).toBe(true);
  });

  it('positive: non-required unchanged from default → emits used_default=true', () => {
    const out = buildFormLeftBlankSignals({
      cid: 'c1', aid: 'a1', turn_id: 't1', msg_id: 'm1',
      fields,
      values: { project_dir: '/some/path', review_depth: 'quick', target_branch: 'main' },
    });
    const depth = out.find((s) => (s.metadata as any)?.input_id === 'review_depth');
    expect(depth).toBeDefined();
    expect(depth!.metadata!.used_default).toBe(true);
    const branch = out.find((s) => (s.metadata as any)?.input_id === 'target_branch');
    expect(branch).toBeDefined();
    expect(branch!.metadata!.used_default).toBe(true);
  });

  it('negative: user changed every field → no signals', () => {
    const out = buildFormLeftBlankSignals({
      cid: 'c1', aid: 'a1', turn_id: 't1', msg_id: 'm1',
      fields,
      values: { project_dir: '/x', review_depth: 'deep', target_branch: 'develop' },
    });
    expect(out).toEqual([]);
  });

  it('negative: required field filled, no defaults equal → no signals', () => {
    const out = buildFormLeftBlankSignals({
      cid: 'c1', aid: 'a1', turn_id: 't1', msg_id: 'm1',
      fields: [
        { id: 'name', required: true, default: '' },
      ],
      values: { name: 'Alice' },
    });
    expect(out).toEqual([]);
  });
});

describe('expert_signals.event › tool_failure', () => {
  it('truncates error_excerpt to 200 chars', () => {
    const long = 'x'.repeat(500);
    const sig = buildToolFailureSignal({
      cid: 'c1', aid: 'a1', turn_id: 't1',
      tool_name: 'bash', error_excerpt: long,
    });
    expect((sig.metadata!.error_excerpt as string).length).toBe(200);
  });
});
