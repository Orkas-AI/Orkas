import {
  EXECUTION_PLAN_MAX_EXPLANATION_CHARS,
  EXECUTION_PLAN_MAX_STEP_CHARS,
  EXECUTION_PLAN_MAX_STEPS,
  type ExecutionPlanState,
  type ExecutionPlanStepInput,
  type ExecutionPlanStepStatus,
  type ExecutionPlanUpdate,
} from "../agent/session.js";
import { defineTool, type AgentTool } from "./base.js";

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

function planResult(plan: ExecutionPlanState, action: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    action,
    revision: plan.revision,
    objective_turn_id: plan.objectiveTurnId,
    step_count: plan.steps.length,
    steps: plan.steps.map((item) => ({ id: item.id, step: item.step, status: item.status })),
    ...extra,
  });
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
 * Session-local progress state for work whose independent outcomes or real
 * dependencies need durable continuity. It is deliberately not a scheduler:
 * the model may revise steps as evidence arrives, while the Session keeps the
 * objective tied to real user text and outside summaries.
 */
export function createExecutionPlanTool(controller: ExecutionPlanController): AgentTool {
  return defineTool({
    name: "manage_execution_plan",
    description:
      "Track durable outcome milestones only for independent success criteria, dependencies/branches/approval, or ambiguous long-run recovery; tool/file count and linear plumbing do not qualify. Create once; update only completion/blocking, scope, or newly required work. Prefer set_statuses for known transitions. Never announce tool starts or complete before evidence. IDs persist; append at capacity is a no-op. Clear or replace an existing plan only after newer user instruction.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["update", "replace", "append_step", "set_status", "set_statuses", "clear"],
          description: "Create/revise a full plan, append a milestone, update stable IDs, or clear after cancellation. replace aliases update. Omit action only when plan, updates, step_id, or step identifies one action.",
        },
        explanation: {
          type: "string",
          description: "Optional concise reason for this revision.",
          maxLength: EXECUTION_PLAN_MAX_EXPLANATION_CHARS,
        },
        replace_objective: {
          type: "boolean",
          description:
            "Re-anchor to the latest user text only on the first plan update after the user revised/replaced " +
            "the goal. Omit it on later status-only updates.",
        },
        step_id: {
          type: "integer",
          minimum: 1,
          description: "Stable host-assigned step ID required by set_status.",
        },
        step: {
          type: "string",
          maxLength: EXECUTION_PLAN_MAX_STEP_CHARS,
          description: "New milestone text required by append_step.",
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "blocked"],
          description: "Status for append_step or set_status.",
        },
        updates: {
          type: "array",
          description: "Status changes already known together. Optional; use set_status for one change. The batch is validated and applied atomically.",
          minItems: 1,
          maxItems: EXECUTION_PLAN_MAX_STEPS,
          items: {
            type: "object",
            properties: {
              step_id: {
                type: "integer",
                minimum: 1,
                description: "Stable host-assigned step ID.",
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
            "Complete ordered list. Under the same user instruction, copy every existing step text exactly, update statuses, and append new work. Each item requires a plain step string and allowed status.",
          maxItems: EXECUTION_PLAN_MAX_STEPS,
          items: {
            type: "object",
            properties: {
              step: {
                type: "string",
                description: "One concrete milestone as a plain string, never an object.",
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
      additionalProperties: false,
    },
    async execute(input) {
      try {
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
            return { content: planResult(current, "append_step", {
              appended: false,
              capacity_reached: true,
              max_steps: EXECUTION_PLAN_MAX_STEPS,
              do_not_retry: true,
              next_action: "continue_task_and_use_set_status_for_existing_steps",
            }) };
          }
          const plan = controller.update({
            steps: [
              ...current.steps.map((item) => ({ step: item.step, status: item.status })),
              { step, status },
            ],
            ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
          });
          const appended = plan.steps.at(-1);
          return { content: planResult(plan, "append_step", {
            appended_step_id: appended?.id,
            ...(appended && appended.status !== status
              ? { normalized_statuses: [{ step_id: appended.id, from: status, to: appended.status }] }
              : {}),
          }) };
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
            return { content: planResult(current, "set_status", { step_id: stepId, unchanged: true }) };
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
          const plan = controller.update({
            steps: current.steps.map((item) => ({
              step: item.step,
              status: item.id === stepId
                ? status
                : status === "in_progress" && item.status === "in_progress"
                  ? "pending"
                  : item.status,
            })),
            ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
          });
          return { content: planResult(plan, "set_status", {
            step_id: stepId,
            ...(statusNormalizations.length ? { normalized_statuses: statusNormalizations } : {}),
          }) };
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
            return { content: planResult(current, "set_statuses", {
              requested_step_ids: parsed.map((update) => update.stepId),
              updated_step_ids: [],
              unchanged_step_ids: unchangedStepIds,
              unchanged: true,
            }) };
          }

          const plan = controller.update({
            steps: current.steps.map((item) => ({
              step: item.step,
              status: requestedById.get(item.id)
                ?? (activeStepId !== undefined && item.status === "in_progress" ? "pending" : item.status),
            })),
            ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
          });
          return { content: planResult(plan, "set_statuses", {
            requested_step_ids: parsed.map((update) => update.stepId),
            updated_step_ids: updatedStepIds,
            unchanged_step_ids: unchangedStepIds,
            ...(statusNormalizations.length ? { normalized_statuses: statusNormalizations } : {}),
          }) };
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
          return { content: planResult(current, "update", {
            updated: false,
            capacity_reached: true,
            max_steps: EXECUTION_PLAN_MAX_STEPS,
            requested_step_count: input.plan.length,
            do_not_retry: true,
            next_action: "continue_task_and_use_set_status_for_existing_steps",
          }) };
        }
        const update: ExecutionPlanUpdate = {
          steps: normalizePlanSteps(input.plan),
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
        return { content: planResult(plan, "update", {
          action_inferred: !input.action || repairedFullPlanAction,
          replace_objective_applied: replaceObjectiveApplied,
          ...(statusNormalizations.length ? { normalized_statuses: statusNormalizations } : {}),
        }) };
      } catch (err) {
        return planFailure(controller, "PLAN_UPDATE_REJECTED", (err as Error).message);
      }
    },
  });
}
