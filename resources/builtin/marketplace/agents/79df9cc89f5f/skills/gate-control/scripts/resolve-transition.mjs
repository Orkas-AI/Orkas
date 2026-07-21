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
  if (input.recoveryDecision !== 'none' && input.decision !== 'none') {
    throw new Error('decision and recovery-decision cannot both describe the current turn; pass only the field submitted by the real user');
  }
  const lineOps = lineOperations(input.line, input.artifact);

  // Signed-payload impact always wins over visual recovery/error handling.
  // Its one Gate B amendment creates a fresh signature and QA cycle.
  if (input.decision === 'revise' && input.scope === 'gate_b_payload') {
    return result({
      nextAction: 'open_gate_b_amendment',
      authorities: ['edit_current_artifact'],
      form: { fields: ['gate_b_decision'] },
      prohibitedOps: NO_VISUAL_RESET,
      reason: 'The requested revision changes the signed production-plan payload. Its new approved signature owns a fresh QA cycle, so old-cycle recovery is irrelevant.',
    });
  }

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
    if (input.decision === 'revise' && input.scope === 'visual_only' && input.recovery === 'available') {
      return result({
        nextAction: 'begin_visual_revision_then_edit',
        authorities: ['edit_current_artifact', 'restart_visual_qa_cycle'],
        allowedOps: ['composition.begin_visual_revision', ...lineOps.edit],
        prohibitedOps: ['emit_form'],
        reason: 'The current visual-preview or final-video revision decision already authorizes the bounded edit and any non-billable QA-cycle restart it requires.',
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
    if (input.recovery === 'not_available') {
      return result({
        nextAction: 'edit_current_cycle',
        authorities: input.decision === 'revise' ? ['edit_current_artifact'] : [],
        allowedOps: input.decision === 'revise' ? lineOps.edit : [],
        prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
        reason: 'Native status says no restart is required. A failed reset call is a control-flow error, not a reason to ask the user again.',
      });
    }
    return result({
      nextAction: 'report_visual_qa_blocker',
      prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
      reason: 'A technical QA exhaustion never creates a user authorization form. Wait for a real user revision request, which itself authorizes the next bounded cycle.',
    });
  }

  if (input.recoveryDecision === 'pause') {
    return result({ nextAction: 'pause', reason: 'The user paused visual recovery.' });
  }

  if (input.decision === 'none'
    && input.approvalStatus === 'approved'
    && input.artifactState === 'unchanged') {
    return result({
      nextAction: 'continue_from_existing_approval',
      authorities: ['consume_existing_approval'],
      prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
      reason: 'No current decision was submitted and the same artifact signature is already approved.',
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
    if (input.recovery === 'available') {
      return result({
        nextAction: 'begin_visual_revision_then_edit',
        authorities: ['edit_current_artifact', 'restart_visual_qa_cycle'],
        allowedOps: ['composition.begin_visual_revision', ...lineOps.edit],
        prohibitedOps: ['emit_form'],
        reason: 'The current revise decision already authorizes the bounded edit. Restart the exhausted internal QA cycle without asking the user again.',
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
    if (input.gate === 'gate_b' && input.scope === 'gate_b_payload') {
      return result({
        nextAction: 'apply_approved_amendment_then_approve_plan',
        authorities: ['edit_current_artifact', 'approve_gate_b'],
        allowedOps: ['edit_current_artifact', mapped[1]],
        prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
        reason: 'The current user approved the displayed amendment. Apply that exact patch, call composition.approve_plan with expected_plan_change=true, and continue the fresh QA cycle without visual recovery.',
      });
    }
    return result({
      nextAction: mapped[0],
      authorities: [`approve_${input.gate}`],
      allowedOps: [mapped[1]],
      prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
      reason: 'The current real user message explicitly approved the displayed gate artifact.',
    });
  }

  // Backward compatibility for recovery forms emitted by VideoStudio 1.1.5
  // or older. New policy never emits this form, but an already-visible form
  // must remain consumable without producing yet another confirmation.
  if (input.recoveryDecision === 'new_visual_revision') {
    if (input.recovery === 'available') {
      return result({
        nextAction: 'begin_visual_revision',
        authorities: ['restart_visual_qa_cycle'],
        allowedOps: ['composition.begin_visual_revision'],
        prohibitedOps: ['emit_form'],
        reason: 'Consume the legacy recovery submission once. New turns use the original revise decision directly and never emit this form.',
      });
    }
    if (input.recovery === 'unknown') {
      return result({
        nextAction: 'query_status',
        allowedOps: [lineOps.status],
        prohibitedOps: ['emit_form', 'edit_files', 'composition.begin_visual_revision'],
        reason: 'A legacy recovery submission cannot be consumed until native state is verified.',
      });
    }
    return result({
      nextAction: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
      allowedOps: lineOps.edit,
      prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
      reason: 'The cycle is not exhausted, so consume the legacy submission by continuing the bounded edit without a reset.',
    });
  }

  if (input.recovery === 'available') {
    return result({
      nextAction: 'report_visual_qa_blocker',
      prohibitedOps: ['emit_form', 'edit_files', 'composition.begin_visual_revision'],
      reason: 'Technical QA exhaustion is not a separate user decision. Report the blocker and wait for a real revision request; never emit a recovery form.',
    });
  }

  return result({
    nextAction: 'follow_native_state',
    prohibitedOps: ['emit_form', ...NO_VISUAL_RESET],
    reason: 'No new authority is required; follow the current native next action.',
  });
}

export default async function runSkill({ args = [] } = {}) {
  if (!Array.isArray(args)) throw new Error('args must be an array');
  return resolveTransition(parseArgs(args));
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
