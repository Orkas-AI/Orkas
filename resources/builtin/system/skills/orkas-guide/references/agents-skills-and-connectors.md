# Agents, skills, and connectors

## Choose the right kind of resource

- An **agent** is a reusable specialist role with a workflow and delivery standards. Choose one when its expertise or interaction style fits the work, whether for one task or a recurring responsibility.
- A **skill** is a repeatable method for producing a result or following a workflow. Choose one when its method fits the task; it can support different callers. Running it on an Orkas schedule uses Automation; connected-service access uses the caller's available connections and permissions.
- A **connector** gives Orkas authorized access to a supported external service's information and actions. Choose one when the work needs that service; the task supplies the work to do, and access remains subject to the connection and operation permissions.

Use an agent for specialist judgment, a skill for a repeatable way of working, and a connector when the task needs external information or actions. A task may use more than one, but only select what contributes to the outcome.

A model/provider is configured separately in **Account settings > Models**. A custom Agent can define a role and workflow, but it does not become ChatGPT, Claude, DeepSeek, or another model merely by using that name or imitating a style. A connector is also not a model-provider substitute.

## Create an agent or skill

Commander can carry out a clearly requested Agent or Skill creation or edit through the dedicated resource workflow. After success, open the returned resource to review the saved configuration. If the request is still exploratory or requires choices the user has not made, use the visible creation screen instead of inventing them.

- For a custom Orkas Agent, open **AI Team**, choose **Create agent**, keep
  **Create** selected, enter a name and one-line summary, then confirm. Open the
  Agent detail to review and refine its workflow, inputs, standards, and memory.
  Orkas does not provide a general Agent JSON import screen; do not ask the user
  to paste or import an Agent configuration file instead of using this visible
  creation flow.
- For a Skill, open **Skills**, choose **Create skill**, then select **Manual**,
  **From URL**, or **From folder**. Confirm the source and finish the Skill in
  its edit conversation before relying on it. The folder picker shows its
  current file-count and size limits.
- For a local Skill ZIP, attach the ZIP in **Commander** and explicitly ask Orkas to import the Skill. Do not describe the ZIP as normal model-readable task context. For multiple Skills, review the list and choose what you need; ask for all explicitly if wanted. Selected Skills import in batches, with failures reported separately. Installation does not verify every Skill can run or migrate other plugin components.

## Save an agent's default skills

For an Orkas-run Agent, ask Commander or that Agent's edit conversation to add named, available Skills to its saved defaults. After the edit succeeds, the Agent keeps this default skill list across tasks and restarts. Disabled, missing, system-only, or another Agent's private Skills cannot be added as shared defaults.
Defaults appear in the Agent's skill directory; their contents are read when needed, not automatically executed or always loaded in full. Other eligible shared Skills remain discoverable through search. Selecting a Skill for one task does not rewrite saved defaults. External CLI Agents such as Claude Code or OpenCode use their own skill mechanisms instead of this saved-default configuration.

## Use an agent or skill

1. Open **AI Team** or **Skills** to see what is currently available.
2. Review the description and any stated inputs or limitations.
3. Enable or install the item if the current catalog offers that action and the account permits it.
4. In Commander or a Project task, select the relevant resource from the task composer.
5. Describe the outcome normally; include inputs the specialist or workflow needs.

Catalog contents and availability can vary by edition, account, or region. The current in-app entry is the authority for whether something can be installed or used.

The user pauses or removes a Skill. To keep it but stop using it, open its card's **⋯** menu in **Skills** and choose **Disable**; **Enable** turns it back on. Choose **Delete** in that menu and confirm to remove one they created or imported; for a Skill installed from **Marketplace**, open it in **Marketplace** and choose **Uninstall** (the button reads **Update** when an update is available), since its card menu only disables it. Agents work the same way in **AI Team**: only custom Agents can be deleted, and Marketplace Agents are uninstalled from **Agent marketplace**.

For audio-only tasks, choose **VoiceStudio** in **AI Team** and provide a script or recording. It produces narration, transcription, cuts, or mixes with supplied music. Speech generation sends the script to the configured service in **Account settings > Models** and needs network access; local transcription and editing use bundled components without first-use downloads. Keep the saved project and audio together to revise individual paragraphs or mix settings. Repair/update Orkas if a component is missing. Cloning, generated music and automatic speaker identification are outside this core workflow; use video production for picture changes.
## Add a local external agent

1. Install Codex, Claude Code, OpenCode, or another supported CLI you want to use, complete its sign-in, and make sure it is available to desktop applications.
2. Open **AI Team** and choose **Connect an agent**, or use the **@** agent picker in the task composer.
3. On the first visit, wait for the selector's detection message. On later visits, Orkas immediately shows the first agent from its in-memory result while the title marks the list as updating.
4. Review the first agent selected by default, switch it if needed, review the prefilled name and summary, then confirm.
5. Open the new Agent's details and use **Runtime settings** to choose any supported model, thinking, and **Permission level** overrides. For CLIs with selectable permissions, the default is **Use CLI default**. **Ask for permission** forwards native approval requests to the shared Orkas confirmation dialog with the CLI action or selected path and the same CLI permission-level choices, then returns the decision to that CLI; changing the level there saves it for that Agent after approval. OpenCode instead runs with fixed **Full access** and shows no permission selector.
6. For Claude Code, Codex, or OpenCode, keep the workspace default or choose a custom project directory in the Agent's details. Without a custom choice, a task inside a Project uses that Project's workspace.
7. During a coding task, ask the external agent to switch project directories when needed. It can show a folder form; after you choose an existing folder, the task continues in that directory with a fresh CLI session.

Detection and Agent-detail project-directory choices are device-local. Detection refreshes every time the External panel is entered. If a CLI is below the minimum supported version, upgrade it from the connection panel, Agent details, or the named CLI button at the bottom of the task error bubble. Progress appears on the button; the result appears beside it. Retry the task after a successful upgrade. Supported versions adapt automatically; if an explicitly selected model is unavailable, change it in Runtime settings. Upgrading does not retry a task automatically. If the expected CLI does not appear, confirm it is installed and available to desktop applications, then leave and re-enter the External panel. If a custom project directory was moved or removed, choose an existing folder from the task form or reset the agent to the workspace default in its details.

During a task, Claude Code, Codex, OpenCode, Hermes, and OpenClaw can use the built-in Browser for that conversation only. You can switch to other Orkas pages while the agent continues working in its task browser. Other conversations and external browser windows are outside its access. In Task Details > Browser, you can interact with the page directly. AI page actions pause while you interact and become available again after 10 seconds without input, once held keys, dragging, or input-method composition have ended. The agent can read ordinary form values, fill and submit fields including passwords, verification codes and card details, and upload files from the task workspace or attachments. Sensitive field values are never returned to the model. Uploads and downloads have no browser file-count or size quota; website limits still apply. AI uploads use file paths and ordinary downloads save to task attachments without a file dialog. Attach external files to the conversation. Website native file-system pickers are cancelled during AI control; use the website manually if it offers no ordinary upload or download. Task downloads need no separate site approval. After finishing your interaction, choose **Let AI continue** for immediate handback. Website requests for camera, microphone, clipboard, location or screen sharing show a site permission or source selection dialog. AI can allow or deny keeping the screen awake for the current request. Other website permissions still require your choice. Use **Reset site permissions** in the browser toolbar to clear that site’s choices and retry the website request; the form is kept. Complete CAPTCHA or other site-required checks when prompted; automatic control recovery does not restart a stopped task.

## Connect an external service

1. Open **Connectors**.
2. Find the supported service under the available catalog.
3. Choose **Connect** and complete the service's authorization flow.
4. Return to Orkas and confirm the service is listed under **Connected**.
5. Select the connector in a task and clearly state what Orkas may read or do.

You can also ask Commander to connect or reconnect a named service in the current
task. Not connected does not mean unsupported: setup discovery checks the full
available catalog, not only the connections enabled for task use. Simple OAuth
only needs the connection entry and your login/consent. Extra configuration uses
the connector's concise guide and browser assistance; Commander handles authorized browser steps, including filling and submitting sensitive fields without returning their values, and pauses for login or verification it cannot complete or a required platform confirmation. Ordinary work with an existing connection does not need setup discovery.

If a connector opens a setup panel for extra configuration, choose **Ask
Commander** there to start a separate assistance task with that connector
already identified. The request is sent automatically; values entered in the
protected fields are not included. Complete any requested login or secret entry
directly in the provider page or protected setup form.

Authorization occurs with the external service. Do not paste passwords, access tokens, or secret keys into a normal task unless Orkas is explicitly showing a protected setup field intended for that value.

For a server that is not in the catalog, use **Connectors > Add MCP server**.
Choose a remote server or local command and enter only configuration supplied
by a source you trust. A local command runs on the device whenever that server
connects, so review it before choosing **Add and connect**.

Commander may prepare this installation only from exact configuration the user already supplied; Orkas still shows the required confirmation before adding it. If a credential or authorization value is missing, open the protected Connectors form and enter it there rather than sending it in the task.

## Manage access deliberately

- To stop using a connection but keep it, choose **Disable** in its card's **⋯** menu (**Enable** restores it). **Disconnect** removes the connection; for a server added with **Add MCP server** it also deletes that saved server.
- Reconnect when authorization expires or the external account changes: choose **Connect** on the card again; **Reconnect OAuth** for a custom OAuth server; **Reauthorize** in the **⋯** menu for local-CLI connectors. **Retry** only rechecks an unreachable service and does not re-authorize.
- Check the selected account if the service has more than one workspace or identity.
- Ask for confirmation before consequential external actions when the task or current permission mode requires it.

Disconnecting stops future use of the connection; it does not necessarily delete content held by the external service.
