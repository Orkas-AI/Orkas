#!/usr/bin/env node

const VALID = {
  line: new Set(['unknown', 'compose', 'auto', 'generate', 'edit']),
  artifact: new Set(['unknown', 'composition', 'production']),
  gate: new Set(['none', 'gate_a', 'gate_b', 'gate_c', 'gate_d']),
  decision: new Set(['none', 'approve', 'revise']),
  scope: new Set(['unknown', 'none', 'visual_only', 'gate_b_payload']),
  recovery: new Set(['unknown', 'available', 'not_available']),
  recoveryDecision: new Set(['none', 'new_visual_revision', 'pause']),
  artifactState: new Set(['unknown', 'new', 'unchanged', 'changed']),
  // Who asked for the change. `user` means the current user turn names it in
  // their own words; `model` covers a model-initiated change and any reply
  // that mixes both, because a mixed reply takes the higher bar.
  origin: new Set(['unknown', 'user', 'model']),
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
  allowedOps = [],
  prohibitedOps = [],
  reason,
}) {
  return {
    policy_version: 1,
    next_action: nextAction,
    authorities,
    allowed_ops: allowedOps,
    prohibited_ops: prohibitedOps,
    reason,
  };
}

const NO_VISUAL_RESET = ['restart_visual_qa_cycle'];

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
    origin: raw.origin || 'unknown',
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
  assertEnum('origin', input.origin, VALID.origin);
  assertEnum('approval-status', input.approvalStatus, VALID.approvalStatus);
  if (input.recoveryDecision !== 'none' && input.decision !== 'none') {
    throw new Error('decision and recovery-decision cannot both describe the current turn; pass only the field submitted by the real user');
  }
  const lineOps = lineOperations(input.line, input.artifact);

  // A signed-payload change the user themselves named needs no confirmation
  // back to them: they already said what they wanted. Apply exactly that change
  // and re-sign. The host verifies the quote appears in the current user turn,
  // so this cannot be claimed for a model-initiated rewrite. A reply that mixes
  // a user instruction with model suggestions is `model` — high water mark.
  if (input.decision === 'revise'
    && input.scope === 'gate_b_payload'
    && input.origin === 'user') {
    return result({
      nextAction: 'apply_user_instruction_then_approve_plan',
      authorities: ['edit_current_artifact', 'approve_gate_b'],
      allowedOps: [
        'edit_current_artifact',
        input.artifact === 'composition' || (input.artifact === 'unknown' && input.line === 'compose')
          ? 'composition.approve_plan'
          : 'production.approve_plan',
      ],
      prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
      reason: 'The current user named this exact change. Apply it to the canonical plan artifacts and re-sign with expected_plan_change=true and decision_evidence quoting their instruction; do not ask them to confirm what they just asked for.',
    });
  }

  // Signed-payload impact always wins over visual recovery/error handling.
  // Its one Gate B amendment creates a fresh signature and QA cycle.
  if (input.decision === 'revise' && input.scope === 'gate_b_payload') {
    return result({
      nextAction: 'open_gate_b_amendment',
      authorities: ['edit_current_artifact'],
      prohibitedOps: NO_VISUAL_RESET,
      reason: 'The requested revision changes the signed production-plan payload. Its new approved signature owns a fresh QA cycle, so old-cycle recovery is irrelevant.',
    });
  }

  if (input.errorCode === 'E_VISUAL_REVISION_NOT_REQUIRED') {
    return result({
      nextAction: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
      allowedOps: lineOps.edit,
      prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
      reason: 'Native state says the current visual QA cycle is not exhausted.',
    });
  }

  if (input.errorCode === 'E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED') {
    if (input.recovery === 'available') {
      return result({
        nextAction: 'present_findings_and_ask_user_direction',
        authorities: [],
        allowedOps: [],
        prohibitedOps: ['edit_files', 'restart_visual_qa_cycle'],
        reason: 'An exhausted visual QA cycle is not restarted by the agent. Present the current frames and the remaining findings, offer another repair round or skipping the named check, and end the turn; the user reply grants the next cycle.',
      });
    }
    if (input.recovery === 'unknown') {
      return result({
        nextAction: 'query_status',
        allowedOps: [lineOps.status],
        prohibitedOps: ['stop_for_user', 'edit_files', 'restart_visual_qa_cycle'],
        reason: 'An authorization error cannot establish recovery availability.',
      });
    }
    if (input.recovery === 'not_available') {
      return result({
        nextAction: 'edit_current_cycle',
        authorities: input.decision === 'revise' ? ['edit_current_artifact'] : [],
        allowedOps: input.decision === 'revise' ? lineOps.edit : [],
        prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
        reason: 'Native status says no restart is required. A failed reset call is a control-flow error, not a reason to ask the user again.',
      });
    }
    return result({
      nextAction: 'query_status',
      allowedOps: [lineOps.status],
      prohibitedOps: ['stop_for_user', 'edit_files', 'restart_visual_qa_cycle'],
      reason: 'The legacy authorization error is not authoritative. Query native status and follow its recovery availability.',
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
      prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
      reason: 'No current decision was submitted and the same artifact signature is already approved.',
    });
  }

  if (input.decision === 'revise') {
    if (input.scope === 'unknown') {
      return result({
        nextAction: 'classify_revision_scope',
        authorities: ['inspect_requested_change'],
        prohibitedOps: ['stop_for_user', 'restart_visual_qa_cycle'],
        reason: 'A revise decision grants edit intent, but signed-payload impact must be classified.',
      });
    }
    if (input.recovery === 'available') {
      return result({
        nextAction: 'edit_current_cycle',
        authorities: ['edit_current_artifact'],
        allowedOps: lineOps.edit,
        prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
        reason: 'This revise decision is the user reply that already bought the next QA cycle, so edit now and do not ask again. Choose a strategy the recorded failed evidence has not already tried.',
      });
    }
    if (input.recovery === 'unknown') {
      return result({
        nextAction: 'query_status',
        authorities: ['edit_current_artifact'],
        allowedOps: [lineOps.status],
        prohibitedOps: ['stop_for_user', 'restart_visual_qa_cycle'],
        reason: 'Resolve native recovery state before editing or asking another question.',
      });
    }
    return result({
      nextAction: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
      allowedOps: lineOps.edit,
      prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
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
        prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
        reason: 'The current user approved the displayed amendment. Apply that exact patch, call composition.approve_plan with expected_plan_change=true, and continue the fresh QA cycle without visual recovery.',
      });
    }
    return result({
      nextAction: mapped[0],
      authorities: [`approve_${input.gate}`],
      allowedOps: [mapped[1]],
      prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
      reason: 'The current real user message explicitly approved the displayed gate artifact.',
    });
  }

  // Backward compatibility for recovery requests emitted by VideoStudio 1.1.5
  // or older. New policy never emits one, but an already-visible request
  // must remain consumable without producing yet another confirmation.
  if (input.recoveryDecision === 'new_visual_revision') {
    if (input.recovery === 'available') {
      return result({
        nextAction: 'edit_current_cycle',
        authorities: ['edit_current_artifact'],
        allowedOps: lineOps.edit,
        prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
        reason: 'The legacy submission is a user reply, so the next cycle was already granted by the host. Consume it by making a materially different edit — never by repeating a strategy the recorded evidence already shows failed.',
      });
    }
    if (input.recovery === 'unknown') {
      return result({
        nextAction: 'query_status',
        allowedOps: [lineOps.status],
        prohibitedOps: ['stop_for_user', 'edit_files', 'restart_visual_qa_cycle'],
        reason: 'A legacy recovery submission cannot be consumed until native state is verified.',
      });
    }
    return result({
      nextAction: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
      allowedOps: lineOps.edit,
      prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
      reason: 'The cycle is not exhausted, so consume the legacy submission by continuing the bounded edit without a reset.',
    });
  }

  if (input.recovery === 'available') {
    return result({
      nextAction: 'present_findings_and_ask_user_direction',
      authorities: [],
      allowedOps: [],
      prohibitedOps: ['edit_files', 'restart_visual_qa_cycle'],
      reason: 'The visual QA budget is spent. Show the frames and the remaining findings, offer another repair round or skipping the named check, and end the turn — the user reply is what buys the next cycle.',
    });
  }

  return result({
    nextAction: 'follow_native_state',
    prohibitedOps: ['stop_for_user', ...NO_VISUAL_RESET],
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
