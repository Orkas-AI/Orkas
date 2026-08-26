# Source-backed creation and editing

Read this file when source material or conversation history defines the Agent, when checking similarity for a new Agent, or when editing an existing Agent from an unbound Commander session.

## Pre-create similarity check

Before creating, compare the proposed name and its typical objects/actions with the injected Agent index.

- If an existing entry overlaps, emit no container. Name the existing Agent in one current-language paragraph, explain the overlap, and ask whether to use it or still create a new one.
- If none overlaps, create in the same turn without a pre-announcement.

## Source-preservation contract

Source includes current-turn attachments or referenced files, pasted prompts, `agent.json`, YAML/JSON specs, README/workflow documents, examples, or Agent directories.

1. Read the source first. A filename plus a short request is not enough. For an injected attachment path, call `read_files` with that exact path in `paths`; ask for another upload only if the read fails.
2. Preserve the core prompt: role/persona, objective, boundaries, step order, tool rules, examples, output format, evaluation checks, and safety/confirmation points.
3. Adapt format rather than substance. Map content into Orkas display, workflow, guidance, capability dependency, input, interaction, and category fields.
4. Treat an `agent_id` found in exported or supplied source as provenance, not mutation intent. For import-as-new, copy, or create-from-source requests, never copy or emit that source ID. Follow the mutation controls in `llm-agent-fields.md`; only an explicit unbound edit resolved from the current index and spec emits the canonical current id.
5. Map a source capability only to a real built-in tool or available Skill; state any unmapped capability as a limitation. Preserve useful examples, data/report shapes, acceptance criteria, and behavior-affecting configuration; ignore only unrelated build/editor artifacts.
6. Treat a matching domain folder such as `education`, `data`, `creation`, `office`, or `rnd` as strong category evidence.

## Conversation crystallization

For “turn the above conversation into an Agent”, identify the concrete target before the current request: the task, delivered output, artifact, decision, or repeatable workflow. Author from that target, not from the meta act of creating an Agent. If no concrete target is identifiable, ask one concise clarification and emit no container.

## Unbound editing loop

1. Resolve the injected index entry and read its current `agent.json` through the advertised path; never reconstruct it from the slim roster.
2. Check editability before applying the mutation controls from `llm-agent-fields.md`:
   - `Source: builtin` → explain that built-in Agents cannot be edited here and can be forked from the detail panel; emit no container.
   - `runtime.kind === "cli"` → follow `cli-and-prose.md`; Commander must send the user to the detail panel, while a bound CLI editor may edit only its small supported surface.
3. For a custom LLM-managed Agent, emit only the verified edit target and changed fields.

If the target does not resolve to one existing Agent, emit no container. Say in ordinary language that nothing changed, and ask the user to select it or provide its current display name. Do not list ids or XML mechanics, change the operation, or create a replacement.

## Source-aware quality check

Before emitting the container, verify:

- substantive behavior, examples, and output checks remain source-specific rather than generic;
- mapped capabilities are real and have matching dependencies; and
- the visible claim is limited to what this container changes.
