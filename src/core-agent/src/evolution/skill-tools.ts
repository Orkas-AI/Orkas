import { defineTool, type AgentTool } from "../tools/base.js";
import { createLogger } from "../shared/logger.js";
import type { SkillStore } from "./skill-store.js";

const log = createLogger("skill-manage");

/**
 * Create the skill_manage tool that the LLM uses to create, read,
 * patch, list, and delete learned skills.
 *
 * `onCreated` fires after a successful `create` action with the new skill
 * id — Orkas uses this to append the new skill to the current agent's
 * `skill_list` so the runtime allowlist filter can see it on the next turn.
 * The callback is fire-and-forget; exceptions are logged but don't fail
 * the tool call.
 *
 * Modeled after Hermes-Agent's skill_manager_tool.py.
 */
export function createSkillManageTool(
  store: SkillStore,
  onCreated?: (id: string) => void,
): AgentTool {
  return defineTool({
    name: "skill_manage",
    description: [
      "Manage learned skills — reusable procedures you can create after completing complex tasks.",
      "",
      "Actions:",
      "  create  — Save a new skill after a complex task (5+ tool calls), error recovery, or non-trivial workflow discovery.",
      "  read    — Load a skill's full instructions before using it.",
      "  patch   — Fix outdated, incomplete, or wrong instructions in a skill. Do this immediately when issues are found during use.",
      "  list    — List all available skills with summaries.",
      "  delete  — Remove a skill that is no longer useful.",
      "",
      "Guidelines:",
      "  - After completing a complex task (5+ tool calls), fixing a tricky error, or discovering a non-trivial workflow, save the approach as a skill.",
      "  - When using a skill and finding it outdated, incomplete, or wrong, patch it immediately — don't wait to be asked.",
      "  - Skip for simple one-offs. Confirm with user before creating or deleting.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "read", "patch", "list", "delete"],
          description: "The action to perform.",
        },
        id: {
          type: "string",
          description: "Skill identifier (lowercase, hyphens/underscores). Required for create/read/patch/delete.",
        },
        name: {
          type: "string",
          description: "Human-readable skill name (max 64 chars). Required for create.",
        },
        description: {
          type: "string",
          description: "One-line skill description (max 1024 chars). Required for create.",
        },
        body: {
          type: "string",
          description: "Markdown body with procedures/instructions. Required for create.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization. Used with create.",
        },
        old_string: {
          type: "string",
          description: "Text to find in the skill body. Required for patch.",
        },
        new_string: {
          type: "string",
          description: "Replacement text. Required for patch.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences (default: false). Used with patch.",
        },
      },
      required: ["action"],
    },
    async execute(input) {
      const action = input.action as string;

      try {
        switch (action) {
          case "list": {
            const skills = await store.list();
            if (skills.length === 0) {
              return { content: "No skills found. Create one after completing a complex task." };
            }
            const lines = skills.map(
              (s) =>
                `- **${s.name}** (${s.id}): ${s.description} [patches: ${s.patchCount}, tags: ${(s.tags ?? []).join(", ") || "none"}]`,
            );
            return { content: `Found ${skills.length} skill(s):\n\n${lines.join("\n")}` };
          }

          case "read": {
            const id = input.id as string;
            if (!id) return { content: "Error: 'id' is required for read action.", isError: true };
            const skill = await store.read(id);
            if (!skill) return { content: `Skill not found: ${id}`, isError: true };
            store.touch(id).catch(() => {});
            return {
              content: [
                `# ${skill.frontmatter.name}`,
                `> ${skill.frontmatter.description}`,
                `> Updated: ${skill.frontmatter.updatedAt} | Patches: ${skill.frontmatter.patchCount}`,
                "",
                skill.body,
              ].join("\n"),
            };
          }

          case "create": {
            const id = input.id as string;
            const name = input.name as string;
            const description = input.description as string;
            const body = input.body as string;
            const tags = input.tags as string[] | undefined;

            if (!id || !name || !description || !body) {
              return {
                content: "Error: 'id', 'name', 'description', and 'body' are required for create action.",
                isError: true,
              };
            }

            const skill = await store.create({ id, name, description, body, tags });
            if (onCreated) {
              try { onCreated(skill.id); }
              catch (err) { log.warn(`onCreated callback threw for skill "${skill.id}": ${(err as Error).message}`); }
            }
            return {
              content: `Skill created: ${skill.id} ("${skill.frontmatter.name}")\nPath: ${skill.path}`,
            };
          }

          case "patch": {
            const id = input.id as string;
            const oldStr = input.old_string as string;
            const newStr = input.new_string as string;
            const replaceAll = (input.replace_all as boolean) ?? false;

            if (!id || !oldStr || !newStr) {
              return {
                content: "Error: 'id', 'old_string', and 'new_string' are required for patch action.",
                isError: true,
              };
            }

            const skill = await store.patch(id, oldStr, newStr, replaceAll);
            return {
              content: `Skill patched: ${skill.id} (patch #${skill.frontmatter.patchCount})`,
            };
          }

          case "delete": {
            const id = input.id as string;
            if (!id) return { content: "Error: 'id' is required for delete action.", isError: true };
            const deleted = await store.delete(id);
            return {
              content: deleted ? `Skill deleted: ${id}` : `Skill not found: ${id}`,
              isError: !deleted,
            };
          }

          default:
            return { content: `Unknown action: ${action}`, isError: true };
        }
      } catch (err) {
        return { content: `Error: ${(err as Error).message}`, isError: true };
      }
    },
  });
}
