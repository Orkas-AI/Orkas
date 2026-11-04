# Settings, data, and safety
## Find the right Settings area
Open the account entry at the bottom of the sidebar, choose **Account settings**, then choose the area that matches the outcome:

- **Account**: sign-in status, credits, membership status, and the actions currently available for the account.
- **Data**: memory, cloud sync, conflicts, recoverable deletions, and other data controls.
- **Models**: official and user-configured chat models plus search, image, video, and text-to-speech services.
- **General**: language, task notifications, tool permissions, automatic Agent review, software updates, and other app behavior.

Some areas appear only when the current build, account, or device supports them.
## Credits (commercial edition only)
Credits can be used directly by eligible official Orkas services, including task conversations, image and video creation, and speech. They are deducted according to actual use. The amount can depend on the work performed, so use the account's current records rather than estimating it from the task alone.

1. Open the sidebar account menu and choose **Credits left** for usage details, **Buy** for the Web credit-pack area, or **Account settings > Account** for the full account view.
2. Check the current balance, warnings, **Credit details**, and active account.
3. If credits are low or unavailable, use only the purchase or membership action currently shown by Orkas, then retry the blocked work.

Balances, included amounts, reset timing, prices, and available actions can change by account and over time. Treat the current Account card and the message shown at the blocked feature as the source of truth.
## Membership (commercial edition only)
Membership can affect whether an account may use some hosted features. Give the user a path to their own current status instead of listing plans or promising a particular entitlement. After returning from a purchase, **Account settings > Account** shows its confirmation. If unconfirmed or paid benefits are still updating, choose **Refresh status** to check the same purchase without another payment. Unconfirmed alone does not mean payment failed.

1. Open the sidebar account menu and choose **Plan** for the Account area or **Upgrade** for the Web subscription area. **Account settings** also shows unresolved renewal notices.
2. Review the displayed status or notice, then use the action shown there to manage, resume, renew, or start membership.
3. Return to the blocked feature and try again after the account status refreshes.

Do not compare membership tiers, prices, quotas, included credits, or benefit matrices. These can change; the current Account card and feature-specific prompt are authoritative.
## Models and account availability
Open **Account settings > Models** to review the models and services available in the current edition. The page is split by purpose into **Chat**, **Search**, **Image**, **Video**, and **Speech**; each lists its configured entries in priority order, and its **Add** button opens the protected setup dialog for that purpose. A model may require sign-in, credentials, credits, or account access before it can be selected. Enter model API keys only in the protected fields of those dialogs; never ask the user to paste an API key into an ordinary task. Orkas-run chat models require a context window of at least **32000 tokens**. Smaller saved models remain in Settings for removal or replacement but are unavailable for selection and rotation. A task may need a larger window for its input and output.

Each input that runs through an Orkas model includes a compact model control. In the commercial edition, it lists **Orkas built-in models** before **Bring your own API Key** models and follows the order managed in **Account settings > Models**. Open it to view or switch models; choose **Configure models** to add a model, review providers, and manage their order. The current control and settings rows are authoritative for the available model names and options.

Commander and Orkas-run Agents have no per-Agent model setting: they use the model selected in the task input. Using a Skill keeps that same task model. Orkas has no per-Agent or per-Skill binding for its underlying model or model API key; naming a model in a persona, Skill instruction, or prerequisite does not select it. To use another configured model, switch it in the task input. A Skill's tool or script may separately call an external API; that does not change the model running the Orkas task. An external CLI Agent instead uses its bound CLI. Its **Runtime settings** show the model, thinking, and permission controls that the installed CLI currently exposes and can save supported per-Agent overrides. A model or thinking choice marked **Default** clears that override; **Use CLI default** leaves permissions at the CLI's own default. OpenCode instead uses fixed **Full access** and hides the permission selector. Overrides do not change global CLI settings or other Agents. When all recipients are external CLI Agents, the shared Orkas model control stays visible but disabled. It is available when Commander or an Orkas-run Agent will also handle the message.

To use OpenAI or another model provider, add it in **Account settings > Models** or use an available **Official model** (commercial edition only). In **Chat > Add model**, each provider shows whether it accepts an API key, **Authorize account**, or both. To use an existing ChatGPT plan, choose **OpenAI Codex** and complete **Authorize account** in the browser; usage then follows that plan's limits set by OpenAI. The **OpenAI** entry instead takes an OpenAI API key, billed separately from any ChatGPT plan. For a Claude plan, choose **Anthropic**, then **Authorize account**; its **API Key** option is billed separately. Do not present a service connector or a custom Agent as if it changed the model provider: a connector adds external service actions, while an Agent changes how work is organized. Without a working official model or valid provider credentials, Orkas cannot truthfully claim that an Agent is running ChatGPT, Claude, DeepSeek, or another external model.

Search, image generation, video generation, and text-to-speech are separate tabs in **Models**. Search and image providers use their own protected setup dialogs (the tab's **Add** button); when no separate image service is configured, Orkas may use the selected chat model only if that API-key model supports image generation. **Commercial edition only:** after sign-in, the **Video** tab lists the built-in **Orkas · Video**; it needs no API key and uses credits. When the user wants to make an AI video or asks which services to connect, lead with this path: they describe the video to **VideoStudio**, which shows the credit quote for the planned generated clips and waits for approval before any paid generation; a failed **Orkas · Video** generation is not charged. Offer a provider API key only when the user asks for one or prefers to pay that provider directly.  **Both editions:** for provider-owned video access, open the **Video** tab's **Add** dialog, choose one of the service/model options currently shown, and enter its API key. A configured provider is then used instead of **Orkas · Video** and bills generated clips to the provider account, which needs its own balance and model access; narration, images, or the task's model in the same production can still use credits. Do not present adding a key as a way to stop using credits. This flow does not expose a separate model picker or a **Test** action. Save the credential, then validate it with a small real generation. If that fails, use the exact provider message to check the API key, provider credits, input requirements, and service availability; do not direct the user to chat-model controls.

**Commercial edition only:** the managed **Orkas · Voice** row can be enabled or disabled, but it is not deleted; a disabled row stays visible and marked **Disabled** so it can be enabled again, while user-configured speech providers remain independently removable. If narration reports that Orkas Voice is turned off, enable that row or configure another speech provider before retrying—waiting or retrying without changing the setting will not restore a user-disabled service.

To use an OpenAI Chat, OpenAI Responses, or Anthropic-compatible endpoint that is not listed:

1. In **Account settings > Models > Chat**, choose **Add model**, then the provider **Custom**.
2. Select the gateway’s **Protocol**: **OpenAI-compatible** (Chat Completions), **OpenAI Responses**, or **Anthropic-compatible**. Choose Responses when the service supports reasoning with tools. Enter the API Base URL, exact model ID, and API key in the protected form. The label and maximum output tokens are optional; enter an explicit token limit only when the provider requires one. For OpenAI, a `/chat/...` URL is converted to its API base. For Responses, enter the API base (for example `https://orkas.ai/v1`); a final `/responses` is removed automatically. For Anthropic, use the server base URL with any gateway prefix; a final `/v1` or `/v1/messages` is removed automatically. Existing configurations without a protocol continue to use OpenAI.
3. Save, then use **Test** on the model's priority-list row before important work.

The saved model is shown by its model ID, like other model configurations.

When a task cannot use the current model, check its status in **Account settings > Models**, complete the provided sign-in or credential flow, confirm credits or account access, then select an available model and retry. If Orkas reports that another official model handled the request, the task has already continued; retry only if it later ends without a usable result.
## Tool permissions
Permission modes in **Account settings > General > Agent behavior > Local operation permissions** balance convenience and control:

- **Cautious**: workspace files only; sensitive actions ask for confirmation.
- **Standard**: all files; sensitive actions ask for confirmation.
- **Trusted**: all files; most sensitive actions run without confirmation, but local system changes, external writes or launches, and irreversible actions still ask.

These modes govern Orkas-run local operations and connector actions, including connectors used by external CLI agents. Recognized reads and ordinary edits, such as fetching mail or saving a draft, need no connector confirmation. In Cautious and Standard, sensitive actions such as sending, publishing, payments, permission changes, and deletion require confirmation; unclassified and custom-server actions also require confirmation. In Trusted, available connector actions run without confirmation. Prohibited actions remain unavailable in every mode. Connecting an account still requires the service's authorization. Expand View details to inspect the operation and parameters. Allow once approves only the current operation; Allow for this task approves all subsequent operations for this connector account, including deletion, until the task ends or stops. Reconnecting clears that approval; global permissions stay unchanged.

When an external CLI supports selectable permissions, its **AI Team > Agent details > Runtime settings > Permission level** control governs native CLI requests independently: **Use CLI default** follows that CLI; **Ask for permission** forwards native approval requests to the shared Orkas confirmation dialog, shows the CLI action or selected path, and returns the decision to the CLI; **Full access** automatically accepts supported native requests for that Agent. The dialog can save a different supported level for the Agent, but it does not change the CLI's global configuration or connector operation permissions. OpenCode is fixed to **Full access** and does not show this control.
## Memory
Memory carries concise, durable facts and preferences into later conversations within its scope. It complements explicit **Goals & rules**, source documents in **Library**, and work tracked in **To-do**. Open **Account settings > Data**, then open **Memory** to review the preferences and facts kept across conversations. Add or edit an entry, import supported `.md`, `.txt`, or `.json` content, or export the current memory when needed. Project memory remains in the Project's **Memory** tab and applies to that Project.

- Review and correct saved memory when it becomes inaccurate.
- Remove sensitive or no-longer-useful items.
- Put temporary instructions in the current task rather than saving them as lasting memory.
- Do not assume deleting a conversation removes separately saved memory.
## Sync and cloud data (commercial edition only)
Cloud sync requires an eligible membership; without one, **Account settings > Data** shows a subscribe prompt rather than an error. It can make supported data, including app-private business data and files in supported apps, available on other signed-in devices. App caches remain device-local; older app storage is not migrated automatically.

- When membership ends, **Sync paused** stops automatic sync. Open **Account settings > Data** to check the server deletion date and choose **Renew to resume sync**; pricing recommends the previous tier. Local data is kept. Renewal resumes sync after the account refresh while cloud data remains; if it was cleared, review the notice and enable sync again. Before deletion, app reminders appear once at three days and one day remaining when Orkas is open.
- Wait for sync to finish before editing the same item on another device. When versions cannot be merged, **Conflict log** in **Account settings > Data** lists them: **Use local version** keeps this device's copy, **Use cloud version** replaces it and deletes the local copy, and **Resolve with AI** opens a task to merge them.
- Keep the app open and connected when a large change still needs to upload. If sync shows **Lots of local deletions detected**, it pauses: choose **Confirm delete** only if the deletions were intended; otherwise **Cancel & restore**.
- Task attachments do not sync with their task. Add a supported file to Library when it should be reusable on another synced device.
- Model API keys stay on the device where they were configured and are not cloud-synced.
- Disabling sync on one device stops future synchronization there; it is not the same as deleting cloud data.
- Signing out switches Orkas to a signed-out space, so that account's local data is no longer shown until you sign in again; let sync finish first. **Sign out** is in the sidebar account menu and in **Account settings > Account**; both ask for confirmation.

To remove cloud data, turn off cloud sync in **Account settings > Data** and choose **Turn off and delete cloud data**. This stops sync and deletes cloud data for every device and may not be reversible; **Turn off this device** keeps cloud data.
## Clean up task history
Open **Account settings > Data > Clean up task history**, below **Data directory**. Choose tasks last active more than **7, 14, 30, 60, 90, or 180 days** ago (default **30**). Tasks of all statuses are listed, including pinned and unread tasks, tasks with drafts, and automation runs. These labels appear beside task titles. Running or queued tasks can be selected and are stopped automatically after cleanup is confirmed. If stopping fails, the task is kept and reported as failed. Tasks whose activity cannot be verified are temporarily unavailable for cleanup. Projects themselves and their other content are kept.
1. Choose **View** to inspect the list; no tasks are selected initially. You can view a task’s conversation from this list, then return to continue cleanup. Select a Project or individual tasks; project-wide selection includes all pages. Project rows show a shared or private icon, name and expand/collapse control. Tasks without a Project appear at the top level. Choose **Clean up tasks**, read the inline confirmation, then **Move to recycle bin** on the same page.
2. Watch progress; **Stop** leaves already moved items in the recycle bin. Failed items can be retried. Tasks that become active or change during backup are skipped. Restore an item from **Recycle Bin > Local > Restore** below; project tasks return to their original Project.
Task history, attachments and embedded results move to the local recycle bin; unsent drafts are deleted. Cleaning automation runs keeps the automation configuration. With cloud sync enabled, task deletion also propagates to other devices. Recycle copies are not automatically removed; disk space is only freed after permanently deleting or emptying them.
## Recycle bin and deletion
**Recycle Bin** in **Account settings > Data** keeps deleted items (tasks, Projects, Library files, apps, Agents, Skills and more) as restorable batches.

1. Choose the **Cloud** or **Local** tab and find the batch by its contents and date; **View** shows details.
2. Choose **Restore**. Existing files are skipped and the recycle-bin copy is kept.
3. Confirm the item is back where expected.

**Delete** or **Empty** removes batches permanently; they cannot be restored afterward.

**Background running and quitting.** On macOS and Windows, closing the window keeps tasks and automations running in the background without a prompt. Click the menu-bar or system-tray icon and choose **Open** to return to the same window, or **Quit** to exit directly without confirmation. macOS Dock and application-menu Quit also exit. Quitting stops active work and scheduled execution until Orkas runs again. Sleep, shutdown, or forced termination can interrupt execution.

**Launch at startup.** The installed app offers **Account settings > General > Launch at startup**, off by default. Enabling it requests this operating-system user's startup item; if approval is needed, use **Open system settings** and allow Orkas. System startup runs Orkas with its window hidden; opening Orkas manually shows the window. Disabling startup does not quit the current app. On entering **Auto** with enabled automations and startup off, a one-time prompt offers **Not now** or **Enable**. Dismissal keeps startup off and is remembered on this device. System-side changes take precedence; account switching and cloud sync do not re-enable startup. It does not wake the computer or replace task access and permissions.

**Notifications, microphone, and updates.** Task notifications require both the **General** setting and operating-system notification permission. When no Orkas window is focused, they cover task completion or failure and permission, confirmation, or interactive-input gates that need your action; selecting one returns to the originating task. Commercial voice input requires sign-in and available credits; the open-source build uses its configured Orkas API Key. Both need a working microphone and operating-system microphone permission; Orkas shows which condition blocked it.

**Commercial edition only:** install app updates from **Account settings > General > App & updates** (**Check for updates**, **Download update**, **Restart to update**) or the update button in the sidebar. Finish or save important work before restarting the app.
