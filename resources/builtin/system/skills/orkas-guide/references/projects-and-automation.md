# Projects and automation
## Use a Project for ongoing work

A Project suits related tasks that need shared goals, rules or resources over time. Reuse a suitable existing Project; a one-off request can stay in a normal conversation. A Project does not start work merely because it exists. Depending on the current Project view, it can bring together:

- **Goal** (optional) states what the Project should achieve; **Rules** express standing constraints and preferred output shared by Project conversations;
- **Memory** retains durable Project facts that remain useful across those conversations;
- agents for specialist work (every built-in agent is available in every Project; add other agents it needs) and **Library** material for evidence, source documents, and saved deliverables;
- **Tasks** and conversations hold execution, follow-up discussion, and results;
- **To-do** records specific planned work, status, responsibility, due dates, dependencies, attachments, and links to execution; opt-in auto-advance is separate from scheduled Automation;
- **Automation** starts saved work at specified times with the Project context.
- **Rules** support up to 4000 characters. They are standing instructions; keep them stable and outcome-focused, and put temporary directions in the individual task. Within a Project conversation, Commander can update these instructions on request.
- The **Goal** tab is off by default. When it is visible, use **Set a goal** or **Edit** to describe what the Project should achieve (up to 400 characters), with up to five optional success criteria. The tab's **⋯** menu marks it achieved or in progress again, or clears it. A goal is not a metric dashboard: writing a numeric target does not calculate business-metric progress. Completing to-dos measures work progress; evaluating a sales or other business target needs the relevant evidence. When that evidence shows the goal is reached, Commander proposes marking it achieved and does so only after you agree. Projects created earlier keep any goal written in their **Rules**.

When **What's new** is available and the Project has changes since the page last showed you, the Project opens on that tab, left of **Tasks**, which counts and lists it: what is stuck and what it needs, what was started but not finished, what waits for your review, what was done, automations that failed or did not finish, and to-dos Commander or an Agent added; select one to open it. The tab is off by default. When enabled, it appears while there is something new. A to-do's Project link opens **To-do**. Commander in a Project conversation opens its reply with the changes made outside that conversation, or answers your question first and adds one line about them. Commander does not repeat a change it told you in a delivered reply or one the Project page already showed you. When available, **What's new** also lists changes Commander told you until the page has shown them. Statuses you set yourself do not count. With no earlier record on this device, the last 7 days are shown.

## Create useful Project context

1. Create a Project with **+** next to **Projects** in the sidebar (it needs only a name), or select one.
2. In **Rules**, add the instructions that should apply across tasks. When **Goal** is visible, record a clear target there.
3. Add the other agents and the sources the Project regularly needs; built-in agents need no adding. In the **Agents** list and its picker, built-in agents show as already available.
4. Send the first message from the Project page to open a new task conversation in that Project. Review memory as the work evolves.

Projects are scoped to the active Orkas account in the commercial edition; the open-source build keeps local Projects without Orkas desktop sign-in. If an expected Project is missing, check the sidebar and, in the commercial edition, confirm the active account and let cloud sync finish when enabled. A deleted Project can be restored from **Recycle Bin** in **Account settings > Data**; do not recreate it first.

Deleting a Project (its **⋯** menu > **Delete**) also deletes its tasks and its Project automations, all restorable from **Recycle Bin**; stop running tasks first. A shared Project shows **End sharing** to its owner and **Leave shared project** to members instead of **Delete**.
## Share a Project with members (commercial edition only)

In the signed-in desktop app, the owner opens **Members > Invite members**, reviews what will be shared, and selects **Start sharing and create link**. Available member seats and cloud storage depend on the owner's account; check the current in-app allowance. The member count includes the owner. Copy the invitation link after it is ready; its expiry is shown before copying. Recipients open the link, check their signed-in account, open Orkas, and confirm **Join project**. If the invitation is unavailable, ask the owner to reopen **Invite members** and send the current link.

Members share Project instructions, memory, files, to-dos and to-do attachments. By default in 2.8.0, shared goal sync and shared to-do result or blocker notes are unavailable. If a project already contains a saved goal or a to-do with one of these notes, initial sharing can stay in preparation. Check the sharing status in **Members** before assuming others have received the content. **Tasks** and **Automation** remain private. Adding a custom Agent does not by itself publish it: use **Share**, review its files, and wait for publication to finish. External CLI Agents remain private. Within a shared Project, a lock marks private content; ordinary Projects do not show these locks.

Invitation links do not wait for uploads. Uploads can resume after interruption or restart; use Pause sync or Retry in Project members. While content syncs, members can work with local Agents. Closing the invitation dialog does not stop background uploads. Keep Orkas running with task notifications and system notification permission enabled to receive background reminders for new shared to-dos assigned to you by other members. Click a reminder to locate and highlight its row on **To-do**. The first sync does not alert for existing items; ordinary edits and reassignments do not trigger new-to-do reminders.

Ordinary content edits save on this device first and publish in the background. Saved does not mean other members have received the update. Sharing, joining and membership changes still need online confirmation. Personal cloud sync and Project collaboration are separate; turning off personal sync does not stop collaboration. Pending changes retry in the background, including after restart, and compatible concurrent edits merge automatically. Keep Orkas running; if access or storage is unavailable, saved changes wait for those conditions to recover. **Refresh** at the upper right retrieves updates immediately. Only conflicts that cannot safely merge appear in **Project conflicts**; compare the highlighted differences before choosing a version.

Members can edit, change the status of, or delete to-dos assigned to themselves or another member. On **To-do**, **All / Mine** at the toolbar's right filters shared responsibilities while keeping personal work visible. **By project** shows it for the selected shared Project; **By status**, when any Project is shared. **All** restores filtered-out work; auto-advance stays unchanged. **Auto** (auto-advance) in a shared Project only processes to-dos assigned to the current user; in an ordinary Project it processes all eligible to-dos. To preview an attachment, click the card's attachment icon or an attachment chip in the editor. Attachment removals in the editor take effect on **Save**; **Cancel** discards them.

Use the Project menu to **Leave shared project**, or **End sharing** as its owner. After leaving or being removed, the downloaded Project becomes a personal copy, with other members' Agents and to-dos not assigned to you removed. Shared updates stop and Project automations are paused. Joining again creates a separate shared Project instead of merging into that personal copy. Ending sharing stops it for everyone and removes the shared cloud data; downloaded copies remain on members' devices.
## Add an existing task to a Project

For a task that does not yet belong to a Project:

1. Open its three-dot menu and choose **Add to project**.
2. Review the task's participating agents. They are selected by default; uncheck any you do not want to add. A Commander-only task has no agent section. Unchecking an agent does not remove a member already in the Project.
3. Choose an existing Project and select **Move**, or choose **New project** and confirm its name to create it and move the task.

The action is disabled while the task is running; wait for completion, or stop it and wait for remaining work to finish. History and attachments stay with the moved task.

A task that already belongs to a Project shows **Remove from project** in the same menu instead. It returns the task to the list outside any Project, and it is disabled during a running task for the same reason. The Project stays as it is, including its to-dos and members.

If some selected agents cannot be added, the task stays in the Project and successful additions are kept. The message reports how many agents could not be added; open the Project to check its members.
## When Commander sets this up for you

Commander creates a Project or Automation when the user asks for one or accepts its offer. A clear creation request does not require a second confirmation of that same action:

- an explicit request for recurring delivery already requests its schedule; merely describing repeatable work can lead to an offer;
- an agreed new Project can include initial to-dos and this conversation filed under it. When **Goal** is available, Commander can also save a goal and success criteria you stated or agreed to.

It reports what was actually saved, including any goal or initial to-dos that failed to save. Commander cannot create a separate conversation in an existing Project for you. Commander can also rename this conversation's Project on request; shared Projects require the owner. In a conversation outside a Project, ask Commander to move it into an existing private Project by its exact name. This moves the conversation without creating a Project or changing its goals, to-dos or members. Use **Add to project** above for a shared destination or to choose participating agents; use the Project view to add reusable agents or sources. Project filing finishes as the reply ends, so the task appears under the Project a moment later. To undo filing, say so in the same conversation or use **Remove from project**; the Project itself stays until you delete it in **Projects**. If a move fails, the conversation stays in place; retry through its menu. Ask Commander to add existing Agents to the current or a named Project and report each result.

## Manage Project to-dos from chat

Open a conversation within the Project and ask Commander to add, read, update, or complete its to-dos. A to-do can carry one short note: its latest result and where it is, or what it needs from you. When available, **What's new** shows the note with the change. In the commercial edition, shared Project members using an older Orkas version do not see result notes or the goal. When Commander creates a Project for this conversation, later to-do operations in the same reply default to that new Project; explicitly request global to-dos for global work. Outside a Project, ask Commander how another Project is going and it reads that Project's to-dos and any saved goal when **Goal** is available. Open a conversation in that Project to add or update its to-dos. A saved task result confirms the change; opening a Projects card alone does not.

Saving or editing a to-do leaves its task link as it was. For an unlinked to-do, choose **Process now** on its card to start a new task conversation. A successful start from the card or through **Auto** links that conversation. In a Project conversation, explicitly assigning that to-do for execution can link it there after the dispatch is accepted. Use **Task** on the card to reopen a linked conversation. Processing a linked to-do from its card continues in that conversation while it stays in the same scope. If it is still working, the card takes you there. A successful new start updates the link. A failed start or a status change leaves it as it was.

**Auto** on **To-do** enables backlog auto-advance and is off by default. It selects pending work whose dependencies are satisfied, with earlier deadlines first, subject to the daily limit. Keep Orkas running on the assigned device with the required resources available. A due date is a deadline, not a scheduled start; use the sidebar's **Auto** for time-based runs. Saving a to-do alone does not enable auto-advance.
## Clean up to-dos

Desktop **To-do > Clean up** (right of **Create**) filters Project, last update age, and status, with matching counts and a scrollable list. Age choices are 7/14/30/60/90/180 days; Project and status include **All**. A Project entry locks its scope. Default: completed, over 30 days old. Confirmation permanently deletes the reviewed to-dos and attachments, keeping linked conversations; changed work is skipped. **Stop** finishes the current deletion, then stops. Check deleted/skipped/failed counts and review remaining work before retrying.

The open-source build uses global and local Project scopes. The commercial edition additionally filters responsible members and shares deletions in the background; conflicts and pending deletions remain.
## Schedule recurring work with Auto

Use **Auto** for an instruction that should run once later or on a repeating schedule. An automation created in chat runs in that conversation; one created in Auto opens a conversation on its first run and reuses it. Older automations continue in their latest run's conversation. If that conversation was deleted or no longer shares the automation's Project scope, a new one is opened and reused. A busy conversation queues the scheduled message behind its current work.

The user can also ask Commander to create or change a clearly specified automation. Outside a Project, Commander changes only global automations and one for a Project it just created in that conversation; another Project's automations are changed in a conversation in that Project or on **Auto**. Commander must use the same Auto business workflow, report success only after the saved task is returned, and provide a way to review the resulting automation. Use the Auto screen when the user needs to inspect or adjust fields before saving.

1. Open **Auto** in the sidebar and choose **+ Create**.
2. Write the instruction as if handing the job to Orkas at run time, including where the result should go.
3. Choose a one-time, every-x-hours, daily, weekly, or monthly schedule. For a repeating task, optionally stop it on a local date or after a set number of scheduled runs. Weekly/monthly dropdowns default to one day; enable **Multiple selection** to choose separate days, marked with right-side checks only in that mode. **Workdays** means Monday–Friday and is single-mode only. Short months use the last day without duplicate runs. Update the assigned device before using these new schedules; older versions cannot read them.
4. Create it on the device that should run it.
5. Keep **Enabled** checked and choose **Create**.
6. Review the first result in its **Runs** list before relying on it.

Each automation is assigned to one device and uses that device's local time. To move an existing automation, open it on the new device and switch its run target to **This device** when that option is shown. The assigned device must be available with Orkas running when the automation is due. Closing the window keeps Orkas running in the background. Use the menu-bar or system-tray icon > **Open Orkas** to return, or **Quit Orkas** to exit and stop execution. For automatic startup with the window hidden, enable **Account settings > General > Launch at startup**; it is off by default. The installed app also offers a one-time startup prompt on entering **Auto** with enabled automations: **Enable** requests startup; **Not now** leaves it off. Complete system approval if requested. Sleep or shutdown can interrupt execution, and the required account, model, connector, and Project access must still work at run time.

An end date includes the selected day in the assigned device's local time. A run-count cutoff advances only for scheduled runs; **Run now** does not consume the count or change the next scheduled time.
## Change or stop an automation

The automation's **More** menu offers **Run now**, **Disable**/**Enable**, **Edit**, and **Delete**.

- Edit the instruction or schedule when the desired outcome changes.
- **Disable** it when runs should stop temporarily; **Enable** resumes it. Disabling an automation does not delete the Project or previous task results.
- Review recent **Runs** before retrying a failed automation.
- Delete it only when its schedule and saved configuration are no longer needed.
