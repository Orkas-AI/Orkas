#!/usr/bin/env node

const VALID = {
  line: new Set(['unknown', 'compose', 'auto', 'generate', 'edit']),
  artifact: new Set(['unknown', 'composition', 'production']),
  gate: new Set(['none', 'gate_a', 'gate_b', 'gate_c', 'preview', 'gate_d']),
  decision: new Set(['none', 'approve', 'revise']),
  scope: new Set(['unknown', 'none', 'visual_only', 'gate_b_payload']),
  recovery: new Set(['unknown', 'available', 'not_available']),
  recoveryDecision: new Set(['none', 'new_visual_revision', 'pause']),
  artifactState: new Set(['unknown', 'new', 'unchanged', 'changed']),
  approvalStatus: new Set(['unknown', 'none', 'pending', 'approved']),
};

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function assertEnum(name, value, allowed) {
  if (!allowed.has(value)) {
    throw new Error(`${name} must be one of: ${[...allowed].join(', ')}`);
  }
}

function result({
  nextAction,
  authorities = [],
  form = null,
  allowedOps = [],
  prohibitedOps = [],
  reason,
}) {
  return {
    policy_version: 1,
    next_action: nextAction,
    authorities,
    form,
    allowed_ops: allowedOps,
    prohibited_ops: prohibitedOps,
    reason,
  };
}

const NO_VISUAL_RESET = ['composition.begin_visual_revision'];

function lineOperations(line, artifact) {
  if (artifact === 'composition' || (artifact === 'unknown' && line === 'compose')) {
    return {
      status: 'composition.status',
      edit: ['edit_current_artifact', 'composition.reconcile', 'composition.inspect', 'composition.snapshot'],
    };
  }
  if (line === 'auto' || line === 'generate' || line === 'edit') {
    return {
      status: 'production.status',
      edit: ['edit_current_artifact', 'run_line_native_reconcile', 'run_line_native_qa'],
    };
  }
  return {
    status: 'read_native_status',
    edit: ['edit_current_artifact', 'run_line_native_reconcile', 'run_line_native_qa'],
  };
}

export function resolveTransition(raw = {}) {
  const input = {
    line: raw.line || 'unknown',
    artifact: raw.artifact || 'unknown',
    gate: raw.gate || 'none',
    decision: raw.decision || 'none',
    scope: raw.scope || 'unknown',
    recovery: raw.recovery || 'unknown',
    recoveryDecision: raw.recoveryDecision || 'none',
    artifactState: raw.artifactState || 'unknown',
    approvalStatus: raw.approvalStatus || 'unknown',
    errorCode: raw.errorCode || '',
  };

  assertEnum('line', input.line, VALID.line);
  assertEnum('artifact', input.artifact, VALID.artifact);
  assertEnum('gate', input.gate, VALID.gate);
  assertEnum('decision', input.decision, VALID.decision);
  assertEnum('scope', input.scope, VALID.scope);
  assertEnum('recovery', input.recovery, VALID.recovery);
  assertEnum('recovery-decision', input.recoveryDecision, VALID.recoveryDecision);
  assertEnum('artifact-state', input.artifactState, VALID.artifactState);
  assertEnum('approval-status', input.approvalStatus, VALID.approvalStatus);
  const lineOps = lineOperations(input.line, input.artifact);

  if (input.errorCode === 'E_VISUAL_REVISION_NOT_REQUIRED') {
    return result({
      nextAction: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
      allowedOps: lineOps.edit,
      prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
      reason: 'Native state says the current visual QA cycle is not exhausted.',
    });
  }

  if (input.errorCode === 'E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED') {
    if (input.recovery === 'available') {
      return result({
        nextAction: 'open_visual_recovery',
        form: { fields: ['visual_recovery_decision'] },
        prohibitedOps: ['edit_files', 'composition.begin_visual_revision'],
        reason: 'Recovery was independently established by the latest native result.',
      });
    }
    if (input.recovery === 'unknown') {
      return result({
        nextAction: 'query_status',
        allowedOps: [lineOps.status],
        prohibitedOps: ['emit_form', 'edit_files', 'composition.begin_visual_revision'],
        reason: 'An authorization error cannot establish recovery availability.',
      });
    }
    return result({
      nextAction: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
      allowedOps: lineOps.edit,
      prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
      reason: 'Status says recovery is not required; the failed reset call was invalid.',
    });
  }

  if (input.recoveryDecision === 'pause') {
    return result({ nextAction: 'pause', reason: 'The user paused visual recovery.' });
  }

  if (input.recoveryDecision === 'new_visual_revision') {
    if (input.recovery === 'available') {
      return result({
        nextAction: 'begin_visual_revision',
        authorities: ['reset_visual_qa_cycle'],
        allowedOps: ['composition.begin_visual_revision'],
        reason: 'The current user authorized a reset that the latest native result offered.',
      });
    }
    if (input.recovery === 'unknown') {
      return result({
        nextAction: 'query_status',
        allowedOps: [lineOps.status],
        prohibitedOps: ['emit_form', 'edit_files', 'composition.begin_visual_revision'],
        reason: 'A recovery decision cannot be consumed until availability is verified.',
      });
    }
    return result({
      nextAction: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
      allowedOps: lineOps.edit,
      prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
      reason: 'The cycle is not exhausted, so ordinary editing continues without a reset.',
    });
  }

  if (input.decision !== 'revise'
    && input.approvalStatus === 'approved'
    && input.artifactState === 'unchanged') {
    return result({
      nextAction: 'continue_from_existing_approval',
      authorities: ['consume_existing_approval'],
      prohibitedOps: ['emit_form'],
      reason: 'The same artifact signature is already approved.',
    });
  }

  if (input.decision === 'revise') {
    if (input.scope === 'unknown') {
      return result({
        nextAction: 'classify_revision_scope',
        authorities: ['inspect_requested_change'],
        prohibitedOps: ['emit_form', 'composition.begin_visual_revision'],
        reason: 'A revise decision grants edit intent, but signed-payload impact must be classified.',
      });
    }
    if (input.scope === 'gate_b_payload') {
      if (input.recovery === 'unknown') {
        return result({
          nextAction: 'query_status',
          authorities: ['edit_current_artifact'],
          allowedOps: [lineOps.status],
          prohibitedOps: ['emit_form', 'edit_files', 'composition.begin_visual_revision'],
          reason: 'Resolve recovery availability before choosing one Gate B or combined form.',
        });
      }
      if (input.recovery === 'available') {
        return result({
          nextAction: 'open_combined_amendment_and_recovery',
          authorities: ['edit_current_artifact'],
          form: { fields: ['gate_b_decision', 'visual_recovery_decision'] },
          prohibitedOps: ['edit_files', 'composition.begin_visual_revision'],
          reason: 'The change needs one Gate B re-sign and the exhausted cycle needs one reset.',
        });
      }
      return result({
        nextAction: 'open_gate_b_amendment',
        authorities: ['edit_current_artifact'],
        form: { fields: ['gate_b_decision'] },
        prohibitedOps: NO_VISUAL_RESET,
        reason: 'The requested revision changes the signed Gate B payload.',
      });
    }
    if (input.recovery === 'available') {
      return result({
        nextAction: 'open_visual_recovery',
        authorities: ['edit_current_artifact'],
        form: { fields: ['visual_recovery_decision'] },
        prohibitedOps: ['edit_files', 'composition.begin_visual_revision'],
        reason: 'Ordinary edit intent exists, but the exhausted QA cycle must be reset first.',
      });
    }
    if (input.recovery === 'unknown') {
      return result({
        nextAction: 'query_status',
        authorities: ['edit_current_artifact'],
        allowedOps: [lineOps.status],
        prohibitedOps: ['emit_form', 'composition.begin_visual_revision'],
        reason: 'Resolve native recovery state before editing or asking another question.',
      });
    }
    return result({
      nextAction: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
      allowedOps: lineOps.edit,
      prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
      reason: 'The user already authorized a bounded revision and native recovery is not required.',
    });
  }

  if (input.decision === 'approve') {
    const sharedApprovals = {
      gate_a: ['lock_brief', 'lock_brief'],
      gate_c: ['approve_generation', 'production.approve_generation'],
    };
    const compositionApprovals = {
      gate_b: ['approve_plan', 'composition.approve_plan'],
      preview: ['approve_preview', 'composition.approve_preview'],
      gate_d: ['approve_draft', 'composition.approve_draft'],
    };
    const productionApprovals = {
      gate_b: ['approve_plan', 'production.approve_plan'],
      gate_d: ['accept_draft', 'continue_line_delivery'],
    };
    const artifact = input.artifact === 'unknown'
      ? (input.line === 'compose' ? 'composition' : 'production')
      : input.artifact;
    const mapped = sharedApprovals[input.gate]
      || (artifact === 'composition' ? compositionApprovals[input.gate] : productionApprovals[input.gate]);
    if (!mapped) throw new Error('approve requires a named gate');
    return result({
      nextAction: mapped[0],
      authorities: [`approve_${input.gate}`],
      allowedOps: [mapped[1]],
      prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
      reason: 'The current real user message explicitly approved the displayed gate artifact.',
    });
  }

  if (input.recovery === 'available') {
    return result({
      nextAction: 'open_visual_recovery',
      form: { fields: ['visual_recovery_decision'] },
      prohibitedOps: ['edit_files', 'composition.begin_visual_revision'],
      reason: 'The latest native result explicitly offered exhausted-cycle recovery.',
    });
  }

  return result({
    nextAction: 'follow_native_state',
    prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
    reason: 'No new authority is required; follow the current native next action.',
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(resolveTransition(args), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
