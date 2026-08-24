import {
  EXECUTION_PLAN_MAX_EXPLANATION_CHARS,
  EXECUTION_PLAN_MAX_STEP_CHARS,
  EXECUTION_PLAN_MAX_STEPS,
  type ExecutionPlanState,
  type ExecutionPlanStepInput,
  type ExecutionPlanStepStatus,
  type ExecutionPlanUpdate,
} from "../agent/session.js";
import { defineTool, type AgentTool, type ToolResult } from "./base.js";

type ExecutionPlanFinish = "completed" | "blocked";

export type ExecutionPlanController = {
  get(): ExecutionPlanState | undefined;
  update(update: ExecutionPlanUpdate): ExecutionPlanState;
  clear(): void;
};

function normalizePlanStatus(raw: unknown): ExecutionPlanStepStatus | null {
  const status = String(raw || "").trim().toLowerCase().replace(/-/g, "_");
  if (status === "pending" || status === "not_started" || status === "todo" || status === "unknown") {
    return "pending";
  }
  if (status === "in_progress" || status === "working") return "in_progress";
  if (status === "completed" || status === "complete" || status === "done") return "completed";
  if (status === "blocked") return "blocked";
  return null;
}

function normalizePlanStepId(raw: unknown): number {
  const canonicalAlias = typeof raw === "string"
    ? /^step_([1-9]\d*)$/.exec(raw.trim())
    : null;
  return Number(canonicalAlias?.[1] ?? raw);
}

function inferPlanAction(input: Record<string, unknown>): string {
  if (typeof input.action === "string" && input.action) return input.action;
  const candidates = new Set<string>();
  if (Array.isArray(input.plan)) candidates.add("update");
  if (Array.isArray(input.updates)) candidates.add("set_statuses");
  if (input.step_id !== undefined) candidates.add("set_status");
  if (input.step !== undefined) candidates.add("append_step");
  return candidates.size === 1 ? [...candidates][0] : "";
}

function normalizePlanSteps(raw: unknown[]): ExecutionPlanStepInput[] {
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item as ExecutionPlanStepInput;
    }
    const value = item as Record<string, unknown>;
    const status = normalizePlanStatus(value.status);
    return {
      step: value.step as string,
      status: (status || value.status) as ExecutionPlanStepStatus,
    };
  });
}

function normalizePlanFinish(raw: unknown): ExecutionPlanFinish | null {
  if (raw === "completed" || raw === "blocked") return raw;
  return null;
}

function normalizeCandidateStatuses(
  steps: readonly ExecutionPlanStepInput[],
): ExecutionPlanStepInput[] {
  let hasInProgress = false;
  return steps.map((step) => {
    if (step.status !== "in_progress") return step;
    if (hasInProgress) return { ...step, status: "pending" };
    hasInProgress = true;
    return step;
  });
}

function finishValidationMessage(
  finish: ExecutionPlanFinish,
  steps: readonly ExecutionPlanStepInput[],
): string | null {
  if (steps.length === 0) return "manage_execution_plan finish requires an explicit plan";
  if (finish === "completed") {
    return steps.every((step) => step.status === "completed")
      ? null
      : "manage_execution_plan finish=completed requires every milestone to be completed";
  }
  return steps.some((step) => step.status === "blocked")
    && steps.every((step) => step.status !== "in_progress")
    ? null
    : "manage_execution_plan finish=blocked requires at least one blocked milestone and no in_progress milestone";
}

function planResult(plan: ExecutionPlanState, action: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    action,
    revision: plan.revision,
    step_count: plan.steps.length,
    step_ids: plan.steps.map((item) => item.id),
    ...extra,
  });
}

function planSuccess(
  plan: ExecutionPlanState,
  action: string,
  extra: Record<string, unknown>,
  finish?: ExecutionPlanFinish,
): ToolResult {
  return {
    content: planResult(plan, action, {
      ...extra,
      ...(finish ? { finish } : {}),
    }),
  };
}

function changedStepIds(
  before: ExecutionPlanState | undefined,
  after: ExecutionPlanState,
): number[] {
  if (!before) return after.steps.map((step) => step.id);
  const beforeById = new Map(before.steps.map((step) => [step.id, step]));
  return after.steps
    .filter((step) => {
      const previous = beforeById.get(step.id);
      return !previous || previous.step !== step.step || previous.status !== step.status;
    })
    .map((step) => step.id);
}

function normalizedStatuses(
  requested: ExecutionPlanStepInput[],
  plan: ExecutionPlanState,
): Array<{ step_id: number; from: ExecutionPlanStepStatus; to: ExecutionPlanStepStatus }> {
  const byText = new Map(plan.steps.map((step) => [step.step, step]));
  return requested.flatMap((step) => {
    const stored = byText.get(step.step);
    if (!stored || stored.status === step.status) return [];
    return [{ step_id: stored.id, from: step.status, to: stored.status }];
  });
}

function planFailure(
  controller: ExecutionPlanController,
  errorCode: string,
  message: string,
): { content: string; isError: true } {
  const current = controller.get();
  return {
    content: JSON.stringify({
      ok: false,
      error_code: errorCode,
      message,
      ...(current
        ? {
            current_revision: current.revision,
            current_steps: current.steps.map((step) => ({
              id: step.id,
              step: step.step,
              status: step.status,
            })),
          }
        : {}),
    }),
    isError: true,
  };
}

/**
 * Session-local progress state for user-requested planning and meaningfully
 * multi-step work whose milestones must remain stable across an extended
 * execution. It complements canonical history and checkpoints rather than
 * replacing them. It is deliberately not a scheduler: the model may revise
 * steps as evidence arrives, while the Session keeps the objective tied to
 * real user text and outside summaries.
 */
export function createExecutionPlanTool(controller: ExecutionPlanController): AgentTool {
  return defineTool({
    name: "manage_execution_plan",
    description:
      "Maintain current-task outcome milestones. Co-emit changes with the related non-Plan business tool; the Plan records progress but never ends the run. Use update only to create or materially revise milestones and set_statuses to batch transitions; skip simple/single-step work and use project_tasks for a cross-conversation backlog.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["update", "set_statuses"],
          description:
            "update creates or materially revises the full plan; set_statuses atomically advances existing milestones. Legacy operations remain accepted but are not advertised.",
        },
        explanation: {
          type: "string",
          description: "Optional concise reason for this revision.",
          maxLength: EXECUTION_PLAN_MAX_EXPLANATION_CHARS,
        },
        replace_objective: {
          type: "boolean",
          description:
            "Re-anchor to the latest user text after the user changes the objective; omit for status-only updates.",
        },
        updates: {
          type: "array",
          description:
            "All status transitions at the current milestone boundary, applied atomically. Complete the old active milestone and start the next one in this single array.",
          minItems: 1,
          maxItems: EXECUTION_PLAN_MAX_STEPS,
          items: {
            type: "object",
            properties: {
              step_id: {
                type: "integer",
                minimum: 1,
                description: "Stable host-assigned ID.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "blocked"],
              },
            },
            required: ["step_id", "status"],
            additionalProperties: false,
          },
        },
        plan: {
          type: "array",
          description:
            "Complete ordered milestone plan for creation or material revision. Preserve existing step text exactly; use set_statuses for ordinary progress.",
          maxItems: EXECUTION_PLAN_MAX_STEPS,
          items: {
            type: "object",
            properties: {
              step: {
                type: "string",
                description: "One outcome milestone.",
                maxLength: EXECUTION_PLAN_MAX_STEP_CHARS,
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "blocked"],
              },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const parsedFinish = input.finish === undefined ? undefined : normalizePlanFinish(input.finish);
        if (parsedFinish === null) {
          return planFailure(
            controller,
            "PLAN_FINISH_INVALID",
            "manage_execution_plan finish must be completed or blocked",
          );
        }
        const finish: ExecutionPlanFinish | undefined = parsedFinish;
        const requestedAction = inferPlanAction(input);
        // Some providers choose the narrow status action but still emit the
        // complete guarded plan shape. This is unambiguous only when neither
        // narrow-action field is present; route that exact shape through the
        // normal full-update validation instead of burning another tool loop.
        const repairedFullPlanAction = requestedAction === "set_status"
          && Array.isArray(input.plan)
          && input.step_id === undefined
          && input.status === undefined;
        const action = repairedFullPlanAction ? "update" : requestedAction;
        if (action === "clear") {
          if (finish) {
            return planFailure(
              controller,
              "PLAN_FINISH_INVALID",
              "manage_execution_plan finish cannot be combined with action=clear",
            );
          }
          controller.clear();
          return { content: JSON.stringify({ ok: true, action: "clear" }) };
        }
        if (action === "append_step") {
          const current = controller.get();
          if (!current) {
            return planFailure(controller, "PLAN_MISSING", "manage_execution_plan append_step requires an existing plan; create it with action=update");
          }
          const step = String(input.step || "").trim();
          const status = normalizePlanStatus(input.status ?? "pending");
          if (!step) return planFailure(controller, "PLAN_STEP_REQUIRED", "manage_execution_plan append_step requires step");
          if (!status) return planFailure(controller, "PLAN_STATUS_INVALID", "manage_execution_plan append_step requires a valid status");
          if (current.steps.length >= EXECUTION_PLAN_MAX_STEPS) {
            // The plan is advisory bookkeeping, not the user's task. Once its
            // bounded ledger is full, failing the tool only invites the model
            // to retry the same impossible append and delays real work. Keep
            // every durable milestone intact and return an explicit no-op so
            // execution can continue with status updates on existing steps.
            if (finish) {
              return planFailure(
                controller,
                "PLAN_FINISH_REJECTED",
                "manage_execution_plan cannot finish from an append that exceeded plan capacity",
              );
            }
            return planSuccess(current, "append_step", {
              appended: false,
              capacity_reached: true,
              max_steps: EXECUTION_PLAN_MAX_STEPS,
              do_not_retry: true,
              next_action: "continue_task_and_use_set_status_for_existing_steps",
            });
          }
          const candidateSteps = normalizeCandidateStatuses([
            ...current.steps.map((item) => ({ step: item.step, status: item.status })),
            { step, status },
          ]);
          if (finish) {
            const message = finishValidationMessage(finish, candidateSteps);
            if (message) return planFailure(controller, "PLAN_FINISH_REJECTED", message);
          }
          const plan = controller.update({
            steps: candidateSteps,
            ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
          });
          const appended = plan.steps.at(-1);
          return planSuccess(plan, "append_step", {
            appended_step_id: appended?.id,
            updated_step_ids: changedStepIds(current, plan),
            ...(appended && appended.status !== status
              ? { normalized_statuses: [{ step_id: appended.id, from: status, to: appended.status }] }
              : {}),
          }, finish);
        }
        if (action === "set_status") {
          const current = controller.get();
          if (!current) {
            return planFailure(controller, "PLAN_MISSING", "manage_execution_plan set_status requires an existing plan");
          }
          // Some providers echo the stable ID label as `step_5` even though
          // the schema requests integer 5. Accept only that exact canonical
          // alias; arbitrary labels must keep failing closed.
          const stepId = normalizePlanStepId(input.step_id);
          const status = normalizePlanStatus(input.status);
          if (!Number.isInteger(stepId) || stepId <= 0) {
            return planFailure(controller, "PLAN_STEP_ID_INVALID", "manage_execution_plan set_status requires a positive integer step_id");
          }
          if (!status) return planFailure(controller, "PLAN_STATUS_INVALID", "manage_execution_plan set_status requires a valid status");
          const target = current.steps.find((item) => item.id === stepId);
          if (!target) {
            return planFailure(controller, "PLAN_STEP_NOT_FOUND", `manage_execution_plan step_id ${stepId} does not exist`);
          }
          if (target.status === status) {
            if (finish) {
              const message = finishValidationMessage(finish, current.steps);
              if (message) return planFailure(controller, "PLAN_FINISH_REJECTED", message);
            }
            return planSuccess(current, "set_status", {
              step_id: stepId,
              updated_step_ids: [],
              unchanged: true,
            }, finish);
          }
          const statusNormalizations = status === "in_progress"
            ? current.steps
                .filter((item) => item.id !== stepId && item.status === "in_progress")
                .map((item) => ({
                  step_id: item.id,
                  from: "in_progress" as const,
                  to: "pending" as const,
                }))
            : [];
          const candidateSteps = current.steps.map((item) => ({
              step: item.step,
              status: item.id === stepId
                ? status
                : status === "in_progress" && item.status === "in_progress"
                  ? "pending"
                  : item.status,
            }));
          if (finish) {
            const message = finishValidationMessage(finish, candidateSteps);
            if (message) return planFailure(controller, "PLAN_FINISH_REJECTED", message);
          }
          const plan = controller.update({
            steps: candidateSteps,
            ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
          });
          return planSuccess(plan, "set_status", {
            step_id: stepId,
            updated_step_ids: changedStepIds(current, plan),
            ...(statusNormalizations.length ? { normalized_statuses: statusNormalizations } : {}),
          }, finish);
        }
        if (action === "set_statuses") {
          const current = controller.get();
          if (!current) {
            return planFailure(controller, "PLAN_MISSING", "manage_execution_plan set_statuses requires an existing plan");
          }
          if (!Array.isArray(input.updates) || input.updates.length === 0) {
            return planFailure(controller, "PLAN_STATUS_UPDATES_REQUIRED", "manage_execution_plan set_statuses requires one or more updates");
          }
          if (input.updates.length > EXECUTION_PLAN_MAX_STEPS) {
            return planFailure(controller, "PLAN_STATUS_UPDATES_INVALID", `manage_execution_plan set_statuses accepts at most ${EXECUTION_PLAN_MAX_STEPS} updates`);
          }

          const parsed: Array<{ stepId: number; status: ExecutionPlanStepStatus }> = [];
          const seenStepIds = new Set<number>();
          for (const raw of input.updates) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              return planFailure(controller, "PLAN_STATUS_UPDATES_INVALID", "manage_execution_plan set_statuses requires update objects");
            }
            const update = raw as Record<string, unknown>;
            const stepId = normalizePlanStepId(update.step_id);
            const status = normalizePlanStatus(update.status);
            if (!Number.isInteger(stepId) || stepId <= 0) {
              return planFailure(controller, "PLAN_STEP_ID_INVALID", "manage_execution_plan set_statuses requires positive integer step_id values");
            }
            if (!status) {
              return planFailure(controller, "PLAN_STATUS_INVALID", "manage_execution_plan set_statuses requires valid status values");
            }
            if (seenStepIds.has(stepId)) {
              return planFailure(controller, "PLAN_STEP_ID_DUPLICATE", `manage_execution_plan set_statuses repeats step_id ${stepId}`);
            }
            if (!current.steps.some((item) => item.id === stepId)) {
              return planFailure(controller, "PLAN_STEP_NOT_FOUND", `manage_execution_plan step_id ${stepId} does not exist`);
            }
            seenStepIds.add(stepId);
            parsed.push({ stepId, status });
          }

          const requestedInProgress = parsed.filter((update) => update.status === "in_progress");
          if (requestedInProgress.length > 1) {
            return planFailure(controller, "PLAN_MULTIPLE_IN_PROGRESS", "manage_execution_plan set_statuses accepts at most one in_progress update");
          }
          const requestedById = new Map(parsed.map((update) => [update.stepId, update.status]));
          const activeStepId = requestedInProgress[0]?.stepId;
          const updatedStepIds = parsed
            .filter((update) => current.steps.find((item) => item.id === update.stepId)?.status !== update.status)
            .map((update) => update.stepId);
          const unchangedStepIds = parsed
            .filter((update) => current.steps.find((item) => item.id === update.stepId)?.status === update.status)
            .map((update) => update.stepId);
          const statusNormalizations = activeStepId === undefined
            ? []
            : current.steps
                .filter((item) => (
                  item.id !== activeStepId
                  && item.status === "in_progress"
                  && !requestedById.has(item.id)
                ))
                .map((item) => ({
                  step_id: item.id,
                  from: "in_progress" as const,
                  to: "pending" as const,
                }));
          if (updatedStepIds.length === 0 && statusNormalizations.length === 0) {
            if (finish) {
              const message = finishValidationMessage(finish, current.steps);
              if (message) return planFailure(controller, "PLAN_FINISH_REJECTED", message);
            }
            return planSuccess(current, "set_statuses", {
              requested_step_ids: parsed.map((update) => update.stepId),
              updated_step_ids: [],
              unchanged_step_ids: unchangedStepIds,
              unchanged: true,
            }, finish);
          }

          const candidateSteps = current.steps.map((item) => ({
            step: item.step,
            status: requestedById.get(item.id)
              ?? (activeStepId !== undefined && item.status === "in_progress" ? "pending" : item.status),
          }));
          if (finish) {
            const message = finishValidationMessage(finish, candidateSteps);
            if (message) return planFailure(controller, "PLAN_FINISH_REJECTED", message);
          }
          const plan = controller.update({
            steps: candidateSteps,
            ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
          });
          return planSuccess(plan, "set_statuses", {
            requested_step_ids: parsed.map((update) => update.stepId),
            updated_step_ids: changedStepIds(current, plan),
            unchanged_step_ids: unchangedStepIds,
            ...(statusNormalizations.length ? { normalized_statuses: statusNormalizations } : {}),
          }, finish);
        }
        if (action !== "update" && action !== "replace") {
          return planFailure(controller, "PLAN_ACTION_INVALID", "manage_execution_plan action must be update, append_step, set_status, set_statuses, or clear");
        }
        if (!Array.isArray(input.plan)) {
          return planFailure(controller, "PLAN_REQUIRED", "manage_execution_plan action=update requires plan");
        }
        const current = controller.get();
        if (input.plan.length > EXECUTION_PLAN_MAX_STEPS
          && current
          && current.steps.length >= EXECUTION_PLAN_MAX_STEPS
          && input.replace_objective !== true) {
          // Providers that do not enforce maxItems sometimes replay the full
          // plan plus one more milestone after append_step was rejected. The
          // same-objective ledger cannot grow, so preserve it and make the
          // capacity signal terminal for this bookkeeping attempt. A genuine
          // newer objective still goes through normal validation below.
          if (finish) {
            return planFailure(
              controller,
              "PLAN_FINISH_REJECTED",
              "manage_execution_plan cannot finish from an update that exceeded plan capacity",
            );
          }
          return planSuccess(current, "update", {
            updated: false,
            capacity_reached: true,
            max_steps: EXECUTION_PLAN_MAX_STEPS,
            requested_step_count: input.plan.length,
            do_not_retry: true,
            next_action: "continue_task_and_use_set_status_for_existing_steps",
          });
        }
        const requestedSteps = normalizePlanSteps(input.plan);
        const candidateSteps = normalizeCandidateStatuses(requestedSteps);
        if (finish) {
          const validStatuses = candidateSteps.every((step) => (
            step.status === "pending"
            || step.status === "in_progress"
            || step.status === "completed"
            || step.status === "blocked"
          ));
          if (validStatuses) {
            const message = finishValidationMessage(finish, candidateSteps);
            if (message) return planFailure(controller, "PLAN_FINISH_REJECTED", message);
          }
        }
        const update: ExecutionPlanUpdate = {
          steps: requestedSteps,
          ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
          ...(input.replace_objective === true ? { replaceObjective: true } : {}),
        };
        let replaceObjectiveApplied = input.replace_objective === true;
        let plan: ExecutionPlanState;
        try {
          plan = controller.update(update);
        } catch (err) {
          // Live long runs commonly replay a previously successful
          // replace_objective flag on later status-only updates. The Session
          // rejects that stale capability before it validates milestones. Retry
          // once without the capability: ordinary same-instruction guards still
          // reject milestone removal, renaming, or completed-step regression.
          const message = (err as Error).message || "";
          if (
            input.replace_objective !== true
            || !message.includes("replace_objective requires a newer real user instruction")
          ) {
            throw err;
          }
          const { replaceObjective: _redundant, ...statusOnlyUpdate } = update;
          plan = controller.update(statusOnlyUpdate);
          replaceObjectiveApplied = false;
        }
        const statusNormalizations = normalizedStatuses(update.steps, plan);
        return planSuccess(plan, "update", {
          action_inferred: !input.action || repairedFullPlanAction,
          replace_objective_applied: replaceObjectiveApplied,
          updated_step_ids: changedStepIds(current, plan),
          ...(statusNormalizations.length ? { normalized_statuses: statusNormalizations } : {}),
        }, finish);
      } catch (err) {
        return planFailure(controller, "PLAN_UPDATE_REJECTED", (err as Error).message);
      }
    },
  });
}
