---
name: autotask-creator
description_zh: "创建、修改、删除或启停自动化任务的系统协议；适合\"每天早上提醒我复盘\"\"把这个自动化改到周五\"\"删除那个自动化\"；触发词：自动化、自动任务、定时、提醒、周期、删除自动化、修改自动化"
description_en: "System protocol for creating, updating, deleting, enabling, or disabling automation tasks; for 'remind me every morning', 'move this automation to Friday', 'delete that automation'; triggers: automation, auto task, schedule, reminder, recurring, delete automation, update automation."
category: "general"
---

# autotask-creator

Rules for automation CRUD from the group-chat commander. The commander does not call mutation tools and does not edit `cloud/auto_tasks` files directly. It emits one or more top-level `<auto-task>...</auto-task>` containers in its final text; the bus parses and applies them after the turn.

## When to consult this skill

`read_file <ROOT>/autotask-creator/SKILL.md` whenever the user asks to:

- Create an automation / auto task / scheduled reminder.
- Update an existing automation's content, title, schedule, recipient, skill, connector, project scope, attachments, or enabled state.
- Delete, enable, or disable an automation.

## Hard rules

- **Mutations only via `<auto-task>` container.** Do not use file tools or shell commands to write/delete auto task configs.
- **Read before edit/delete.** For update, delete, enable, or disable, call `auto_tasks_list` first unless the current user message already contains the exact `task_id`.
- **No guessed IDs.** If multiple tasks could match, ask one concise clarification instead of emitting a container.
- **Partial updates are expected.** For update, output only `<task_id>`, `<action>update</action>`, and the fields being changed. Never re-emit a full task unless several fields truly changed.
- **Top-level raw block.** Containers must not be fenced, quoted, or wrapped in markdown lists.
- **One task per container.** Use multiple containers only when the user explicitly asks to change multiple automations.
- **Keep content clean.** `<content>` stores the user-facing instruction only; do not include `@agent` text, skill-use prefixes, or connector-use prefixes. Use `<recipient>`, `<skill>`, and `<connector>` fields instead.
- **Visible prose stays brief.** Do not repeat the full JSON in prose. After container(s), a short summary is enough.

## Existing task lookup

Use:

`auto_tasks_list({})`

Optional filters:

- `auto_tasks_list({ "project_id": "__current__" })` for tasks scoped to the current project conversation.
- `auto_tasks_list({ "project_id": "__current__", "include_global": true })` when the user might mean a global task too.

The result includes `id`, `title`, `content`, `enabled`, `schedule`, `recipient`, `skill`, `connector`, `project_id`, `attachments`, and timestamps. Use the exact `id` as `<task_id>`.

## Container format

Create:

<auto-task>
<action>create</action>
<title>Short optional title</title>
<content>User instruction to run at fire time</content>
<enabled>true</enabled>
<schedule>{"type":"daily","hour":9,"minute":0}</schedule>
<recipient>{"kind":"commander"}</recipient>
</auto-task>

Update:

<auto-task>
<action>update</action>
<task_id>at_1234abcd</task_id>
<schedule>{"type":"weekly","weekday":5,"hour":9,"minute":30}</schedule>
</auto-task>

Delete:

<auto-task>
<action>delete</action>
<task_id>at_1234abcd</task_id>
</auto-task>

Enable / disable:

<auto-task>
<action>disable</action>
<task_id>at_1234abcd</task_id>
</auto-task>

## Fields

- `<action>`: `create`, `update`, `delete`, `enable`, or `disable`.
- `<task_id>`: required except create. Shape is `at_` plus 8 lowercase hex chars; copy from `auto_tasks_list`.
- `<title>`: optional short display name.
- `<content>`: required on create; optional on update. Max is 8000 chars.
- `<enabled>`: `true` or `false`. Omit on create to default to `true`.
- `<schedule>`: required on create; optional on update. Body is JSON matching one schedule shape below.
- `<recipient>`: optional JSON. Omit for commander. Agent recipient must be `{"kind":"agent","id":"agent_id","name":"Agent Display Name"}`.
- `<skill>`: optional JSON `{"id":"skill_id","name":"Skill Display Name"}`. In update, empty `<skill></skill>` clears it.
- `<connector>`: optional JSON `{"id":"connector_id","name":"Connector Display Name"}`. In update, empty `<connector></connector>` clears it.
- `<project_id>`: optional project id. In update, empty `<project_id></project_id>` clears project scope.
- `<attachments>`: optional JSON string array. On create/update, names matching the current user message's attachments are copied into the automation task; existing task attachment names may also be kept. Do not invent filenames.

## Schedule JSON

- One-time: `{"type":"one_time","at":"2026-06-09T09:00:00.000Z"}`
- Daily: `{"type":"daily","hour":9,"minute":0}`
- Weekly: `{"type":"weekly","weekday":1,"hour":9,"minute":0}`
- Monthly: `{"type":"monthly","day":31,"hour":9,"minute":0}`

Rules:

- `hour` is 0-23, `minute` is 0-59.
- `weekday` is 0-6, Sunday = 0, Monday = 1.
- `day` is 1-31; day 31 means the last day for shorter months.
- For one-time tasks, convert the user's local date/time to an ISO timestamp.
- If the user says "tomorrow / next Friday / every morning" and the date/time is ambiguous, use the current runtime date/time block to resolve it; ask only when the target is still unclear.

## Update semantics

- Omitted fields preserve the current value.
- Empty `<skill></skill>`, `<connector></connector>`, or `<project_id></project_id>` clears that optional field.
- `<attachments>` is a full-list replace for the task's attachment references. To add one attachment while keeping existing ones, include all existing attachment names from `auto_tasks_list` plus the new current-message attachment name.
- To rename plus reschedule, include both `<title>` and `<schedule>`.
- To pause/resume only, prefer `disable` / `enable` over `update`.

## Recipient, skill, connector

- If the automation should run through a particular agent, set `<recipient>` with both id and display name from the agents list.
- If it should invoke a skill, set `<skill>` with the installed skill id and display name.
- If it should use a connector, set `<connector>` with the connector id and display name.
- Skill and connector are mutually exclusive in the current UI flow. If the user switches from one to the other, clear the old field with an empty tag and set the new one.

## Failure handling

- If the user's create request lacks the content or schedule, ask one concise question.
- If the user's edit/delete target is not uniquely identifiable from `auto_tasks_list`, ask which task to change.
- If an action is irreversible (`delete`), do it only when the user clearly asked to delete/remove. Do not treat "pause" as delete; use `disable`.
