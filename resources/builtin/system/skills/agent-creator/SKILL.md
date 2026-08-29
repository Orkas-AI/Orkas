---
name: agent-creator
description_zh: "通过内联 Agent 容器创建或修改用户明确要求的自定义 Agent；用于新建 Agent、把当前对话沉淀为 Agent，或调整其工作流与路由描述，不用于执行普通 Agent 任务。"
description_en: "Author or revise an explicitly requested custom Agent through its inline agent container. Use when the user asks to create an Agent, crystallize a conversation into one, or change its workflow or routing description; not for running an Agent task."
---

# agent-creator

Create or edit a custom Agent by emitting one inline `<agent>...</agent>` container in the final reply. The host parses and applies the container; do not call a mutation tool or write `agent.json` directly.

## Read only the reference needed for this request

The root file is the execution gate. Before emitting a container, read the matching reference through this Skill's read ref:

- New LLM-managed Agent, or an edit to its name, icon, description, workflow, guidance, Skills, tools, inputs, interaction mode, or category → [llm-agent-fields.md](references/llm-agent-fields.md).
- Creation from supplied files/prompts/specs, conversation crystallization, or an unbound edit of an existing Agent → also read [source-and-editing.md](references/source-and-editing.md). Current-turn requirements for inputs, checks, workflow, outputs, or non-goals count as a supplied spec, so this reference is required.
- CLI-backed Agent edit or a request about its external runtime boundary → read [cli-and-prose.md](references/cli-and-prose.md).

Do not read unrelated references. A simple bound edit normally needs only `llm-agent-fields.md`; a CLI-backed edit normally needs only `cli-and-prose.md`.

## Non-negotiable protocol

- **Mutation only via the inline container.** Never use `edit_file`, `write_file`, or `bash` to change `agent.json`. Never dump the container into a workspace file.
- **No container, no mutation, no success claim.** Without a valid container, describe the result only as a proposal, clarification, or blocker; never say the Agent is ready, created, updated, installed, or available. A valid container only requests a mutation; only the host result proves it was applied. Until then, use pending wording such as “将创建” or “已提交，等待应用”.
- **One container per Agent.** Multiple containers are legal only when the user asked to create or edit multiple distinct Agents, and the number of valid containers must equal the number of Agents you claim to have created. End the turn after emitting them; do not dispatch the Agent.
- **Validate every container independently before sending.** Read its tags in order: every opening tag must have the exact matching closing tag, with no crossed, missing, or reused closer. For a multi-Agent reply, repeat this structural check for each container rather than copying an unchecked suffix.
- **Read attachment sources.** For an injected attachment, missing inline body text is not a missing source; call `read_files` with the exact supplied path in `paths` and ask for another upload only if that read fails.
- **Use the user's current UI language** for display copy and user-visible prose. Keep XML tags, tool/Skill names, paths, JSON keys, and closed-set values unchanged. Use localized description tags only when the user explicitly requests multilingual descriptions.
- **Keep user-visible prose outcome-based.** State what the Agent does, when to use it, and the substantive change; do not expose XML/field/schema/id mechanics or source provenance by default.
- **Agent roles are not model runtimes.** Do not imitate or claim an unavailable provider by naming an ordinary role Agent after a model. Real external CLI runtimes are handled by their smaller editable contract.
- **Do not hard-code other Agent display names** in authored content; describe downstream roles by capability.
- **Agent workflows invoke Skills by their visible names, not Skill files or installation paths.** List every invoked Skill in `<skills>`. Built-in tool names belong to `<tools>`, never `<skills>`.
- **Keep runtime guidance bounded.** Use at most 5 items per field.
- **Run the category sanity check.** Do not accept an invalid source category or silently fall back to `general` when one domain clearly dominates.

## Decide create versus edit

- Bound edit session: Runtime injection supplies the target. Omit both `<operation>` and `<agent_id>` and patch only that Agent.
- Unbound session: always emit `<operation>` first with exactly `create` or `edit`. The host does not infer intent from `<agent_id>`.
- Unbound create: emit `<operation>create</operation>` and omit `<agent_id>`.
- Unbound edit: emit `<operation>edit</operation>` plus the canonical `<agent_id>` of an existing custom Agent. Read the current spec first as required by [source-and-editing.md](references/source-and-editing.md).
- A host correction never changes the operation. Correct the rejected fields while preserving `create` or `edit`; if an edit target cannot be resolved, ask the user and emit no create container.
- Pure discussion, unrelated questions, or a request that changes no field: emit no container.

For a new Agent, first compare its name and its typical objects/actions with the injected Agent index. If an existing Agent substantially overlaps, stop and ask whether to use it or still create a new one. Otherwise create in the same turn.

## Execution sequence

1. Classify the runtime as LLM-managed or CLI-backed and the session as bound or unbound.
2. Read only the reference files required by the routing table above.
3. Read any required current Agent spec or user-supplied source.
4. Validate the intended fields, category, capability dependencies, interaction shape, and safety boundary.
5. Emit concise user-facing prose plus the smallest valid patch container. On create, include every required creation field. On edit, omit unchanged fields; list-like fields replace the entire list when present.
6. Stop after emitting the container; the host supplies persistence evidence.

## Safety gate

Do not author direct access to credentials/private stores, dynamic or decoded execution, download-and-execute pipelines, startup persistence, runtime self-modification of Agent/Skill specs, or writes outside the authorized workspace. Convert required values into explicit user inputs or stop and explain the boundary.
