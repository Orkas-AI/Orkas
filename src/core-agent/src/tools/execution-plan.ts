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

/**
 * Session-local progress state for long, tool-heavy tasks. It is deliberately
 * not a scheduler: the model may revise steps as evidence arrives, while the
 * Session keeps the objective tied to real user text and outside summaries.
 */
export function createExecutionPlanTool(controller: ExecutionPlanController): AgentTool {
  return defineTool({
    name: "manage_execution_plan",
    description:
      "Maintain durable milestones for a long current task. Use update for the initial/full revision, then prefer set_status(step_id) and append_step so unchanged steps are not replayed. Stable step IDs are returned after every update. The objective comes from user text; explicit plans persist after completion. Clear or replace only after a newer real user instruction changes or cancels the goal.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["update", "replace", "append_step", "set_status", "clear"],
          description: "Create/revise a complete plan, append one milestone, update one stable step_id status, or clear after a newer user instruction cancels/supersedes it. replace is a legacy alias for update; omitted with plan infers update.",
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
        const action = input.action || (Array.isArray(input.plan) ? "update" : "");
        if (action === "clear") {
          controller.clear();
          return { content: JSON.stringify({ ok: true, action: "clear" }) };
        }
        if (action === "append_step") {
          const current = controller.get();
          if (!current) {
            return { content: "manage_execution_plan append_step requires an existing plan; create it with action=update", isError: true };
          }
          const step = String(input.step || "").trim();
          const status = normalizePlanStatus(input.status ?? "pending");
          if (!step) return { content: "manage_execution_plan append_step requires step", isError: true };
          if (!status) return { content: "manage_execution_plan append_step requires a valid status", isError: true };
          if (current.steps.length >= EXECUTION_PLAN_MAX_STEPS) {
            return { content: `manage_execution_plan allows at most ${EXECUTION_PLAN_MAX_STEPS} steps`, isError: true };
          }
          const plan = controller.update({
            steps: [
              ...current.steps.map((item) => ({ step: item.step, status: item.status })),
              { step, status },
            ],
            ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
          });
          return { content: planResult(plan, "append_step", { appended_step_id: plan.steps.at(-1)?.id }) };
        }
        if (action === "set_status") {
          const current = controller.get();
          if (!current) {
            return { content: "manage_execution_plan set_status requires an existing plan", isError: true };
          }
          const stepId = Number(input.step_id);
          const status = normalizePlanStatus(input.status);
          if (!Number.isInteger(stepId) || stepId <= 0) {
            return { content: "manage_execution_plan set_status requires a positive integer step_id", isError: true };
          }
          if (!status) return { content: "manage_execution_plan set_status requires a valid status", isError: true };
          const target = current.steps.find((item) => item.id === stepId);
          if (!target) {
            return { content: `manage_execution_plan step_id ${stepId} does not exist`, isError: true };
          }
          if (target.status === status) {
            return { content: planResult(current, "set_status", { step_id: stepId, unchanged: true }) };
          }
          const plan = controller.update({
            steps: current.steps.map((item) => ({
              step: item.step,
              status: item.id === stepId ? status : item.status,
            })),
            ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
          });
          return { content: planResult(plan, "set_status", { step_id: stepId }) };
        }
        if (action !== "update" && action !== "replace") {
          return { content: "manage_execution_plan action must be update, append_step, set_status, or clear", isError: true };
        }
        if (!Array.isArray(input.plan)) {
          return { content: "manage_execution_plan action=update requires plan", isError: true };
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
        return { content: planResult(plan, "update", {
          action_inferred: !input.action,
          replace_objective_applied: replaceObjectiveApplied,
        }) };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  });
}
