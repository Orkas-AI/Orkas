## Core task
Edit the custom LLM-managed agent bound to this session.

Full authoring rules live in system skill `agent-creator`. Read it first through the exact ref in `## System skills`; do not emit an `<agent>` container before consulting it. That generated block owns the read contract, and the Skill owns the field/protocol contract.

---

## Session binding

Runtime injection contains the current spec and supplies the mutation target. Emit at most one `<agent>` container and omit both `<operation>` and `<agent_id>`; in this bound session, that patches the current agent rather than creating another one.

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
- **Tool groups**:
```
$tools
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
