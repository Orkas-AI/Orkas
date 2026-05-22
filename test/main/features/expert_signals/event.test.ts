import { describe, it, expect } from 'vitest';
import {
  buildRetrySignal,
  buildSkipSignal,
  buildFormLeftBlankSignals,
  buildToolFailureSignal,
  buildSkillAdvertisedSignal,
  buildSkillInvokedSignal,
  buildAgentDispatchedSignal,
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

describe('expert_signals.event › skill_advertised builder', () => {
  it('positive: groups by system + skill_ids list', () => {
    const sig = buildSkillAdvertisedSignal({
      cid: 'c1', aid: 'a1', turn_id: 'm_42',
      system: 'A.custom',
      skill_ids: ['summary-writer', 'search-docs'],
    });
    expect(sig.type).toBe('skill_advertised');
    expect(sig.delta?.system).toBe('A.custom');
    expect(sig.delta?.skill_ids).toEqual(['summary-writer', 'search-docs']);
    expect(sig.extractor_version).toBe('skill_attribution@1.0');
  });

  it('positive: System B emits with aid=agent_id (per-agent SkillStore)', () => {
    const sig = buildSkillAdvertisedSignal({
      cid: 'c1', aid: 'agent_x', turn_id: 'm_42',
      system: 'B',
      skill_ids: ['my-custom-pricing'],
    });
    expect(sig.aid).toBe('agent_x');
    expect(sig.delta?.system).toBe('B');
  });

  it('negative: empty skill_ids list still emits a record (consumer sees the system fired but no ids)', () => {
    // The buffer in turn_hooks dedups + groups, so this builder is fine
    // with an empty list. Consumer behavior is to treat as a no-skill turn.
    const sig = buildSkillAdvertisedSignal({
      cid: 'c1', aid: 'a1', turn_id: 'm_42',
      system: 'A.platform',
      skill_ids: [],
    });
    expect(sig.delta?.skill_ids).toEqual([]);
  });
});

describe('expert_signals.event › skill_invoked builder', () => {
  it('positive: carries system + skill_id + trigger', () => {
    const sig = buildSkillInvokedSignal({
      cid: 'c1', aid: 'agent_x', turn_id: 'm_42',
      system: 'A.platform',
      skill_id: 'a1b2c3d4e5f6',
      trigger: 'read_file',
    });
    expect(sig.type).toBe('skill_invoked');
    expect(sig.delta?.system).toBe('A.platform');
    expect(sig.delta?.skill_id).toBe('a1b2c3d4e5f6');
    expect(sig.delta?.trigger).toBe('read_file');
  });

  it('positive: System B invocation carries owner aid', () => {
    const sig = buildSkillInvokedSignal({
      cid: 'c1', aid: 'agent_x', turn_id: 'm_42',
      system: 'B',
      skill_id: 'self-evolved',
      trigger: 'read_file',
    });
    expect(sig.aid).toBe('agent_x');
    expect(sig.delta?.system).toBe('B');
  });
});

describe('expert_signals.event › agent_dispatched builder', () => {
  it('positive: parallel group, candidates == dispatched (current model)', () => {
    const sig = buildAgentDispatchedSignal({
      cid: 'c1',
      turn_id: 'c1:plan:dispatch:1000000:0',
      candidates: ['aid_x', 'aid_y'],
      dispatched: ['aid_x', 'aid_y'],
      parallel_group: 'g1',
    });
    expect(sig.type).toBe('agent_dispatched');
    expect(sig.aid).toBeNull();           // commander-scope signal
    expect(sig.delta?.candidates).toEqual(['aid_x', 'aid_y']);
    expect(sig.delta?.dispatched).toEqual(['aid_x', 'aid_y']);
    expect(sig.delta?.parallel_group).toBe('g1');
  });

  it('positive: solo step → parallel_group=null', () => {
    const sig = buildAgentDispatchedSignal({
      cid: 'c1',
      turn_id: 'c1:plan:dispatch:1000000:0',
      candidates: ['aid_x'],
      dispatched: ['aid_x'],
      parallel_group: null,
    });
    expect(sig.delta?.parallel_group).toBeNull();
  });

  it('positive: candidates / dispatched arrays are copied (no shared reference)', () => {
    const cand = ['aid_x', 'aid_y'];
    const sig = buildAgentDispatchedSignal({
      cid: 'c1',
      turn_id: 't1',
      candidates: cand,
      dispatched: cand,
      parallel_group: null,
    });
    cand.push('aid_z');
    // Builder snapshotted via `.slice()` — mutations after emit don't bleed in.
    expect(sig.delta?.candidates).toEqual(['aid_x', 'aid_y']);
    expect(sig.delta?.dispatched).toEqual(['aid_x', 'aid_y']);
  });
});
