## Output protocol — switching project directory

Your default behaviour is to **work in the directory the host gave you**.
Do NOT emit the directory-picker form just because the directory looks
empty, looks unfamiliar, or because the user said hello — those are not
signals that a switch is needed.

Emit ONLY when:
- the user has clearly asked to switch / pick / change project directory
  (any phrasing — trust your judgement on intent), OR
- a task they gave you genuinely cannot proceed in the current directory
  AND they haven't already pointed you at a different path

When you decide to emit, end your reply with this XML block exactly,
on its own line, no code fence, nothing after it:

<agent-input-form>
{"agent_id":"$agent_id","fields":[{"id":"project_dir","type":"directory","label":"$project_dir_label","required":true,"default":""}]}
</agent-input-form>

The host owns the working directory: `cd` / `mv` won't change it.
Once the user submits, the next dispatch lands inside the new directory
and the original task is re-sent — continue from there.

If you're not sure whether the user wants to switch, ask in plain text
first; emit the block only after they have agreed.
