# Getting started

## What each feature is for

Start in **Commander** to describe the outcome, provide context, follow the work, and receive results. Use the features below where the work needs them.

| Feature | Purpose and suitable use | Relationship and boundary |
|---|---|---|
| **Task / conversation** | Carry out a concrete request and retain its discussion, execution and results; enough for a one-off request. | Follow up in the same task when its context still applies. |
| **Project** | Group related tasks when they need shared goals, rules, sources or specialist resources over time. | Reuse an existing suitable Project; creating one does not itself start work. |
| **Goals & rules** | State the intended outcome and requirements that should apply across Project conversations. | A numeric target does not automatically track business progress; temporary directions belong in the current task. |
| **To-do** | Track specific work that needs a status, responsible Agent or member, deadline or materials. | Can link to an execution conversation and run manually or through enabled auto-advance; a deadline is not a scheduled start. |
| **Auto** | Start a saved instruction at a future time or on a repeating schedule. | Each run opens a task; the assigned device and required access must be available. |
| **Agent** | Use a specialist from **AI Team** when work benefits from its role, workflow or delivery standards. | Its reusable role can serve different tasks; Orkas-run roles and the task model are separate choices. |
| **Skill** | Use an established method or deliverable pattern when it fits the task. | Commander or an Agent follows it using that caller's available capabilities. |
| **Connector** | Read information or perform actions in a supported external service. | Requires a working authorized connection and the applicable operation permissions. |
| **Library** | Keep source documents, business records and deliverables for later retrieval and reuse. | Use global or Project material as appropriate; a one-task input can remain an attachment. |
| **Memory** | Retain concise facts and preferences that remain useful across conversations in their scope. | Keep explicit Project requirements in Goals & rules and source documents in Library. |
| **App** | Keep an eligible interactive result, such as a calculator or tracker, for repeated use. | Saved code and app-private data have their own lifecycle; a static report can remain a file. |
| **Model** | Supply the reasoning or generation service that runs the task. | Selected separately from the Agent role and Skill method; external CLI Agents use their CLI's runtime. |
| **Workspace** | Identify the working folder for task files and permitted file operations. | Separate from Library and attachments; attaching a file does not switch the working folder. |

When organizing work toward an ongoing goal, prioritize evidence-backed actions that advance the goal or reduce a key uncertainty, and make their expected results and evaluation criteria clear. Use delivered results and actual changes toward the goal to decide whether subsequent work should continue, change direction, or stop. When evidence is insufficient, first arrange work that fills the critical gap.

**Commercial edition only:** the account entry at the bottom of the sidebar shows the active account. Its menu exposes **Plan**, **Credits left**, **Account settings**, and **Send feedback**. Use **Account settings** for models, permissions, memory, data, notifications, and other account options.

The user does not need to configure every area before starting. A normal first task begins in Commander.

Commander is also the in-app support entry point. Ask it any Orkas usage question; when an exact destination is supported, it can include a shortcut that opens only after the user clicks. For supported create, edit, install, or configuration requests, Commander can use the owning workflow and return its success evidence. If a protected credential, authorization, payment, permission, or destructive confirmation is required, the user still completes that step in the dedicated Orkas screen.

## Complete a first task

1. Open **Commander** and start a new task.
2. Describe the desired result and any important constraints.
3. Add a file or select an available Orkas resource if the task needs context.
4. Send the request and follow the task status.
5. Respond if Orkas asks for a decision, missing detail, permission, or form input.
6. Review the final message and open or download any result files.

The task composer separates three choices:

- **Model:** use one of the **Orkas built-in models** (commercial edition only) or a model the user configured under **Bring your own API Key**. Open the control to **view models**, **switch models**, or choose **Configure models** to **add a model** and manage providers in **Account settings > Models**.
- **Recipient:** choose one or more Agents with @ mentions or the recipient panel. Panel selections and explicit mentions stay synchronized. Selected Agents have a checkmark and appear at the top of the panel; remove one there or select its row again to remove the corresponding mention. A selected Skill or Connector is task context/capability, not another recipient.
- **Workspace:** choose the folder the task may read from and save or change files in. Attaching a file does not change the Workspace.

Write each instruction as **@Agent + description**. An opening @ overrides the current recipient; text before the first @ belongs to the current recipient. Later mentions start new instructions, and adjacent mentions share the following description. The panel inserts mentions at the cursor and shows every recipient, including the owner of an unaddressed first instruction. Quoted mentions remain context.

After a message is accepted, one recipient stays selected; multiple recipients reset the next message to Commander. A failed send keeps the draft. A manual single-Agent choice stays selected through normal completion. A Commander handoff selects its Agent. Temporary delegation keeps the current recipient until an Agent requests your input; a pending input form selects its owner. You can ask that Agent to explain the form without submitting it. Automatic selection ends when the task completes, is cancelled, or hands back; an explicit transfer to Commander selects Commander, while a newer user choice takes precedence. Automation setup keeps its single-recipient selection.

The current controls and settings rows are authoritative for the available choices.
When explaining these controls, keep **view models**, **switch models**, and **add a model** as three explicit model actions; “manage models” alone does not explain the control completely.

**Commercial edition only:** in the first-user welcome card, **Local Agents** appears when supported CLIs are installed on this device. Version checks run beside each name without blocking the welcome. Select the compatible tools you want, then choose **Connect** to add them to **AI Team** with their default configuration. You can deselect tools; connected checkboxes stay locked. **View** beside the success message opens AI Team and highlights the saved cards. A failed check has its own **Retry**; a failed connection can be retried with **Connect**. OpenCode starts unselected and requires accepting its full access setting. Connecting creates the Agent definition; it does not start a task or sign in to the CLI.

The external CLI action is separate from Orkas model selection. Open **AI Team** and choose **Connect an agent**, or use the **@** agent picker in the task composer. Install and sign in to the corresponding supported CLI on this device before connecting it. In the external CLI Agent's details, **Runtime settings** shows the model, thinking, and permission controls that CLI supports. Model or thinking **Default** choices clear that Agent's override; **Use CLI default** leaves permissions at the CLI's own default. OpenCode instead runs with fixed **Full access** and does not show a permission selector. For CLIs that support **Ask for permission**, native approval requests appear in the shared Orkas confirmation dialog and return the decision to that CLI. These choices do not change global CLI settings or other Agents. The shared Orkas model control stays visible but disabled when all recipients are external CLI Agents. It is available when Commander or an Orkas-run Agent will also handle the message.

When related tasks need shared instructions and reusable material, use a **Project** to keep that context together.

For Project goals, to-dos and scheduled work, see [projects-and-automation.md](projects-and-automation.md). For specialist roles, methods and service access, see [agents-skills-and-connectors.md](agents-skills-and-connectors.md).
