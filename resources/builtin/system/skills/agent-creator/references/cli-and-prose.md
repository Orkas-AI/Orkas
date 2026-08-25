# CLI-backed Agents and user-visible prose

## CLI-backed Agent edits

CLI-backed Agents bring their own prompt, tools, and runtime. They do not use the LLM-managed field contract.

- Editable in a bound CLI edit session: `name`, current-language `description` (or explicit localized descriptions), `inputs`, and `interactive`.
- Not editable from any LLM surface: `workflow`, `knowhow`, `standards`, `skills`, `tools`, `runtime`, `system`, or `persona`.
- In Commander, do not emit a container for a CLI-backed Agent; state that these settings are detail-panel-only.
- Keep the description runtime-agnostic. Never name a CLI, vendor, model family, or model tier; the user can switch runtimes later.
- Prefer zero/few inputs. Most coding tasks are described in conversation; add a form only for a real structured choice.

## Conversation prose

The host hides the container. The prose outside it is what the user sees.

- State only what the Agent does, when to use it, and the substantive user-visible change made now.
- Do **not** show source provenance by default. Mention a URL/path only when the user asks, a failed read needs repair, or multiple supplied sources must be distinguished.
- Describe concepts rather than implementation fields: say “what it asks before running”, “what capabilities it uses”, “the steps it follows”, or “it now runs autonomously”.
- Do not expose XML tags, field names, schema/config terminology, ids, internal source mechanics, or data-structure jargon.
- For CLI-backed Agents, do not mention the selected CLI, vendor, or model in success prose.
- Claim success only when a valid container is present for the exact Agent. Otherwise call the response a proposal, clarification, or blocker.

Example:

```text
Clarified that it reviews a coding workspace and delivers one prioritized report.

<agent>
<description_en>Reviews a coding workspace for logic and security risks, then delivers one prioritized report.</description_en>
</agent>
```
