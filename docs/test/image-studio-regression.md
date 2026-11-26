# ImageStudio regression scenarios

When the user explicitly requests native PNG with `/export-png`, only a current, verified native PNG export may appear as the image deliverable. An unverified raster candidate stays in the workspace. Explicit publication and fallback delivery both report the actionable export failure and retain other saved artifacts. An ordinary edit without the command keeps its existing delivery behavior.

## Local inputs and output

| Scenario | Observable result | Owning cases |
| --- | --- | --- |
| The asset script receives a missing, unreadable, malformed or invalid request file | The request resolves relative to the project. File and JSON errors identify the failed input. Invalid shapes and operations use the existing validation errors and create no output. | `test/main/features/image_studio_skill_scripts.test.ts` |
| A saved request names a retired external workflow or optional image command | Reject before contacting a service, starting a command, consuming a generation slot or replacing a project file. Existing outputs remain available for inspection and local export. | `test/main/model/core-agent/image-studio-tool.test.ts`, `test/main/features/image_studio_skill_scripts.test.ts` |
| The user requests PNG and vector PDF from one SVG | Inspect the same native HTML candidate for both outputs. Confirm the PNG's alpha, the vector PDF and the original SVG's bytes. PNG-only delivery uses the existing local conversion path. | `test/main/features/image_studio_skill_scripts.test.ts`, `test/main/quality/studio-skill-references.test.ts` |

## Reference intent and edited output

| Scenario | Observable result | Owning cases |
| --- | --- | --- |
| A request requires reproducing a reference at its original size | The attachment and read result report original and preview dimensions separately. A deterministic reproduction reuses the original canvas. The exported PNG has the original dimensions. | `test/main/features/chat_attachments.test.ts`, `test/main/model/core-agent/file-tools.test.ts`, `test/e2e/image_studio_e2e_capture.spec.ts` |
| A localized edit changes copy within an authorized title region | Use the editable source when available. Otherwise keep the original canvas and verify every decoded pixel outside the independently established change region. Review readable copy, alignment and hierarchy separately. Preserve the line count when the user requires it. | `test/e2e/image_studio_e2e_capture.spec.ts`, `test/main/features/image_agent_eval.test.ts` |
| A reference declares a single instruction or conflicts with its own permitted changes | The instruction is a one-element array. Reject invalid field shapes and conflicting source boundaries without modifying the reference. The handoff carries both the locked route and reference intent. | `test/main/features/image_agent_eval.test.ts`, `test/main/model/core-agent/image-studio-tool.test.ts` |

## Canvas and input scope

| Scenario | Observable result | Owning cases |
| --- | --- | --- |
| A single artboard contains a main visual and a separate supporting facts block | The router treats them as separate reading jobs and loads the canvas workflow before authoring. A simple icon skips it unless it needs layout or reference constraints. | `test/main/features/image_agent_eval.test.ts` |
| An input path is outside the conversation files | Refuse the request and give the recovery path to copy the image into the image project. | `test/main/model/core-agent/image-studio-tool.test.ts` |

Configured image providers own their billing and runtime availability. The
public generation preflight checks the configured provider and the exact
request. A status or recovery read does not dispatch a replacement generation.
