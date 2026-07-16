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

/**
 * Session-local progress state for long, tool-heavy tasks. It is deliberately
 * not a scheduler: the model may revise steps as evidence arrives, while the
 * Session keeps the objective tied to real user text and outside summaries.
 */
export function createExecutionPlanTool(controller: ExecutionPlanController): AgentTool {
  return defineTool({
    name: "manage_execution_plan",
    description:
      "Maintain durable milestones for a long current task. Use early and after material progress; skip trivial tasks. The objective comes from user text. Under the same user instruction, copy every existing step exactly, update statuses, and append new work; do not delete or rename steps. Explicit plans persist after completion. Clear or replace only after a newer real user instruction changes or cancels the goal.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["update", "clear"],
          description: "Update statuses/the complete step list, or clear a plan only after a newer user instruction cancels or supersedes it.",
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
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        if (input.action === "clear") {
          controller.clear();
          return { content: JSON.stringify({ ok: true, action: "clear" }) };
        }
        if (input.action !== "update" && input.action !== "replace") {
          return { content: "manage_execution_plan action must be update or clear", isError: true };
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
        return {
          content: JSON.stringify({
            ok: true,
            action: "update",
            revision: plan.revision,
            objective_turn_id: plan.objectiveTurnId,
            step_count: plan.steps.length,
            replace_objective_applied: replaceObjectiveApplied,
          }),
        };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  });
}
