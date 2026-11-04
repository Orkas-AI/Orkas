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

export type ExecutionPlanController = {
  get(): ExecutionPlanState | undefined;
  update(update: ExecutionPlanUpdate): ExecutionPlanState;
  clear(): void;
};

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
): ToolResult {
  const changed = extra.unchanged !== true
    && extra.updated !== false
    && extra.appended !== false;
  return {
    content: planResult(plan, action, extra),
    observations: {
      coordination: { changed },
    },
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
    compatibilityInputFields: ["action", "finish", "replace_objective", "status", "step", "step_id", "updates"],
    description:
      "Store the optional current-task Plan as a complete ordered snapshot of a few durable outcome milestones. Use it for complex work that benefits from progress state across rounds; keep at most one in_progress. Use todo_tasks for backlogs. Plan state is working memory, not task completion or termination.",
    inputSchema: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Optional concise reason for this Plan update.",
          maxLength: EXECUTION_PLAN_MAX_EXPLANATION_CHARS,
        },
        plan: {
          type: "array",
          description:
            "Complete ordered milestone snapshot. The first snapshot creates the Plan; every later snapshot preserves existing step text exactly, updates statuses in one batch, and may append newly discovered milestones.",
          minItems: 1,
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
      required: ["plan"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const unsupported = Object.keys(input).filter(key => !["plan", "explanation"].includes(key));
        if (unsupported.length) return planFailure(controller, "PLAN_INPUT_UNSUPPORTED_FIELDS",
          "Use plan/explanation only; unsupported fields: " + unsupported.join(", "));
        if (!Array.isArray(input.plan)) return planFailure(controller, "PLAN_REQUIRED", "manage_execution_plan requires plan");
        const requestedSteps = input.plan as ExecutionPlanStepInput[];
        if (requestedSteps.some(step => !step || typeof step !== "object" || Array.isArray(step)
          || Object.keys(step).some(key => !["step", "status"].includes(key))
          || !["pending", "in_progress", "completed", "blocked"].includes(step.status))) {
          return planFailure(controller, "PLAN_STATUS_INVALID", "Each milestone requires step and a current status: pending, in_progress, completed, blocked");
        }
        const current = controller.get();
        if (input.plan.length > EXECUTION_PLAN_MAX_STEPS
          && current
          && current.steps.length >= EXECUTION_PLAN_MAX_STEPS) {
          // Providers that do not enforce maxItems sometimes replay the full
          // plan plus one more milestone after reaching capacity. The
          // same-objective ledger cannot grow, so preserve it and make the
          // capacity signal terminal for this bookkeeping attempt. A genuine
          // newer objective still goes through normal validation below.
          return planSuccess(current, "update", {
            updated: false,
            capacity_reached: true,
            max_steps: EXECUTION_PLAN_MAX_STEPS,
            requested_step_count: input.plan.length,
          });
        }
        const update: ExecutionPlanUpdate = {
          steps: requestedSteps,
          ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
        };
        const plan = controller.update(update);
        const statusNormalizations = normalizedStatuses(update.steps, plan);
        const unchanged = current !== undefined && plan.revision === current.revision;
        return planSuccess(plan, "update", {
          updated_step_ids: changedStepIds(current, plan),
          ...(unchanged ? {
            unchanged: true,
          } : {}),
          ...(statusNormalizations.length ? { normalized_statuses: statusNormalizations } : {}),
        });
      } catch (err) {
        return planFailure(controller, "PLAN_UPDATE_REJECTED", (err as Error).message);
      }
    },
  });
}
