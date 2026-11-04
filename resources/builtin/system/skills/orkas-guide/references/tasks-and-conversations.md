# Tasks and conversations

## Start with a useful request

A task is the execution conversation for a concrete request: it keeps messages, progress and results, and can continue through follow-up messages. A Project groups related tasks; a to-do records planned work that can be linked to one of these execution conversations.

A strong request states:

- the result the user wants;
- the audience or intended use;
- the source material to use;
- important limits such as format, tone, deadline, or actions that need approval.

The user can attach local files or select available Orkas resources from the task composer. Attachments are best for material needed only in this task; Library or Project resources are better for material that should be reused.

## Add the right capability or context

Use the task's resource selector when a specific agent, skill, connector, or saved source is needed. Selecting fewer relevant resources is usually clearer than selecting everything.

If a required resource is disabled, disconnected, or unavailable to the current account, fix that state first or continue with the capabilities that remain available.

## Follow work in progress

- The current status shows whether Orkas is working, waiting for input, completed, stopped, or failed.
- Progress messages and queued work explain what is happening; they are not the final deliverable.
- User-authored queued messages offer **Send now** when available, **Edit**, and **Cancel**, in that order. **Edit** puts the message back in the main input box with its attachments, references, Skill and Connector chips, and selected Agent. The message stays visible in the queue while editing. New queued messages wait while editing; replies already in progress continue. Use the check button to save back to the same queue position, **Cancel** on its queue row to cancel the message without sending it, or Escape to discard edits and keep the original queued message. Each completed action restores the draft that was previously in the input box. Edits survive switching tasks and reloading the window. If saving fails, the edited text stays in the input box for retry; if the message is no longer editable, copy the text before cancelling the edit and sending a new message.
- **Send now** appears only when the queued message can guide the current turn: its target must be the active Commander, the same Orkas-run Agent, or the same external CLI Agent while that CLI exposes live input for its current turn. The full message is preserved when inserted, including attachments and images, references and referenced files, Skill and Connector selections, and the selected Agent. The inserted message appears in the task before the current reply continues. A different Agent recipient, nested dispatch, or CLI turn without live input does not show this action; that message remains intact in the queue and starts automatically as a follow-up turn.
- When a Claude Code Agent reports **Background task running**, its current reply remains in progress and continues receiving the CLI's later output. New messages stay queued by default until that reply finishes. **Stop** ends the current CLI turn and its background processes. A continuous background phase is stopped after 24 hours; retry or ask the Agent to continue any unfinished work.
- When no queued message is being edited, a queued message starts automatically when the preceding turn finishes, even if another task is open. Return to the original task to review its progress or stop it.
- In a longer task, use the slim navigation rail at the left of the conversation to preview and jump between turns. Scroll inside the rail to reveal earlier turns.
- When Orkas asks for a choice, confirmation, or form value, answer in the task so work can continue.
- A Codex Agent can show a question panel above the message input while its current reply keeps running. The question panel, task list, and attachments occupy separate rows; scroll this area when space is limited. Choose an option or type an answer for each question, then select **Send answer**. Switching tasks keeps the draft. The submitted answer appears separately in the conversation. Unanswered questions remain available while that CLI turn accepts input. Select **Cancel** to dismiss an unanswered question without sending an answer or stopping the task. Cancelled questions stay closed after switching tasks or reloading. If cancellation fails, the draft is kept so you can retry. The panel also closes after the answer is saved or the turn ends. After the turn ends, send a new message to continue instead. Expiry does not send an answer or interrupt the running Agent.
- Claude Code questions appear as a choice or text dialog. Questions that allow several choices require **Confirm** after selection; a custom answer is also available. Cancelling does not supply an answer. Question deadlines and cancellation follow the CLI. Orkas does not add its own answer timeout. When the CLI clears a request or the run ends, its dialog closes; the CLI decides how to proceed.
- Use **Stop** when the current direction should not continue. Stopping does not automatically undo actions already completed. The stopped message returns to the composer with its attachments, references, Skill and Connector chips, and selected Agent, so it can be corrected and sent again; it also stays in the task as sent. Anything already typed in the composer is kept instead, and a queued message being edited keeps the composer.
- Send an additional message when the outcome needs refinement; keep it in the same task when the context still applies.

## Review and continue

When the task finishes:

1. Check that the result matches the requested outcome.
2. Open generated files or interactive results from the final message.
3. Download or save anything that needs to be used outside Orkas.
4. Ask for a focused revision in the same task when the existing context is useful.
5. Start a new task when the goal or sensitive context is materially different.

Past tasks can be reopened from the conversation or task history. Search is often faster when the user remembers a title, phrase, project, or result name.

## Organize a task in a Project

For a task outside a Project, use its three-dot menu → **Add to project**. See [Add an existing task to a Project](projects-and-automation.md#add-an-existing-task-to-a-project) for choosing a destination and agents, the running-task restriction, and partial-success handling.

## Share messages and results (commercial edition only)

- Hover over a message to reveal its actions, then use **Share** to create a 30-day link to that message; alternatively, select several messages and share them together.
- If a selected message has generated files, the Share panel lists only files that the public page can preview. Files are not included by default; select only what link visitors should receive. Images, audio, video, PDF, HTML, and text open directly in an isolated preview. Modern Word, Excel, and PowerPoint files are converted on this device to an anonymous read-only HTML preview because browsers cannot open them directly; the original Office file is not included. Each file or generated preview may be up to 10 MB, with a 30 MB total per share.
- Use the result's **More** menu or the Share button in its preview to share one file directly. Files without a supported preview do not show Share.
- A share link includes the chosen content and previews, but not filenames, sizes, download actions, local device paths, or neighboring files. Anyone with the link can view what was selected until the link expires.

If a selected file was moved, deleted, or is no longer accessible, reopen Share after restoring access or choose another result.

## Retry safely

Hover over a failed or stopped message to reveal **Retry**, then retry after correcting the likely cause or deciding that the interrupted work should continue. Before retrying a task that may have changed an external system, verify what already happened so the same message, record, purchase, or deletion is not performed twice.
