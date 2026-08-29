---
name: memory-manager
description_zh: "当用户要求让信息、偏好、决定或规则在未来对话持续生效，或要求更新、纠正、遗忘这些持久信息时，先读取本 Skill，再通过实际工具完成添加、替换或删除；覆盖 Commander、用户、共享、项目记忆及项目指令。不用于只读回忆或保存普通文件。"
description_en: "Read this Skill before “remember this” or any request to preserve facts, preferences, decisions, or rules across future conversations, or correct/forget durable state. It governs mutations to Commander, user, shared, and project memory/instructions; exclude read-only recall and ordinary file saving."
---

# memory-manager

Use this protocol only for durable context that should affect future conversations. Do not persist current task progress, temporary plans, one-off status, or TODO and dependency state.

## Choose the destination

Apply both axes: directive versus descriptive, and global versus project scope. Choose exactly one destination for each item unless the user explicitly requests two distinct durable records. Do not mirror descriptive knowledge into project instructions merely because later work should use that knowledge; "base future proposals on this fact" remains project memory, not a standing rule.

- Use `cross_session_memory` with `target: "agent"` for Commander's durable orchestration lessons and user corrections about how Commander should coordinate, route, synthesize, or ask for missing information.
- Use `cross_session_memory` with `target: "user"` for stable global user facts and preferences: identity, communication style, expertise, tech stack, or a preference that should apply outside the current project.
- Use `cross_session_memory` with `target: "shared"` for stable non-user global facts, shared decisions and conventions, or repository and environment facts that every agent should know.
- In a Project conversation, use `cross_session_memory` with `target: "project"` for durable descriptive project facts, decisions, outcomes, milestones, and conventions.
- Use `project_instructions` for durable directives that should steer every future conversation in this project: its goal, scope, standing rules, and project-specific preferences or constraints.

Do not duplicate a global user preference or a descriptive project fact in project instructions. Do not put Commander-specific orchestration lessons in user or shared memory. Put concrete work items, live progress, and TODO status in `project_tasks`, not memory or project instructions.

## Mutate safely

1. Resolve the intended store, target, and current record. Use a read-only lookup when the exact record or current project instructions are not already identified; never invent a record identifier.
2. Add new durable context, replace a correction to an existing record, and remove only an exact intended record. If several records match a replace or remove request, show the candidates and ask one concise clarifying question without mutating any of them.
3. Treat `project_instructions` as a full replacement. Preserve every existing rule that still applies and send the complete intended text, not a partial patch.
4. Write in the user's current UI language while preserving proper nouns, commands, paths, URLs, and exact quoted text.
5. Name the exact tool, operation, and target even when tools are unavailable and you can only propose the mutation. A prose label such as "project memory" is not a substitute for `cross_session_memory` with `target: "project"`.
6. Call the exact mutation tool when available. Claim that a change succeeded only after its tool result confirms success; otherwise report the error or describe the intended mutation as a proposal.
