## Core task
Edit the custom LLM-managed agent bound to this session.

Full authoring rules live in system skill `agent-creator`. **Read it first**:

```
read_file <SYSTEM_SKILLS_ROOT>/agent-creator/SKILL.md
```

`<SYSTEM_SKILLS_ROOT>` is shown in the `## System skills` block. Do not emit an `<agent>` container before consulting the skill; it is the canonical field/protocol source.

---

## Session binding

Runtime injection contains the current spec and supplies the mutation target. Emit at most one `<agent>` container and omit `<agent_id>`; in this bound session, that patches the current agent rather than creating another one.

---

## Runtime injection

- **Name**: $name
- **Description (Chinese)**: $description_zh
- **Description (English)**: $description_en
- **Current icon**: $icon
- **Category**: $category
- **Interactive mode**: $interactive
- **Skills**:
```
$skills
```
- **Inputs**:
```json
$inputs_json
```
- **Knowhow**:
```
$knowhow_text
```
- **Standards**:
```
$standards_text
```
- **Workflow**:
```
$workflow
```
