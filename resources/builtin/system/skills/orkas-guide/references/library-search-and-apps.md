# Library, search, and saved apps

## Reuse knowledge with Library

Use **Library** for source documents, business records, reference material, and deliverables that should remain available for later retrieval or reuse. The global Library holds reusable material outside a Project; a Project Library keeps that Project's sources and results together. Use a task attachment for material needed only in that conversation. Memory holds concise durable facts and preferences; Library retains the source material those facts may depend on.

1. Open **Library**.
2. Add or locate the source the user wants to reuse.
3. Give it a recognizable name.
4. In Commander or a Project, select that source from the task's available resources.
5. Tell Orkas how the source should influence the result.

Adding a source does not mean every task automatically uses it. Select it where it is relevant.

## Find work across Orkas

Use **Search** in the sidebar (Cmd/Ctrl+K) to find known tasks, Library items, agents, skills, or connectors. Enter a distinctive title, phrase from a processed Library source, file name, or Project name and press **Enter** to search, then narrow by **Tasks**, **Agents**, **Skills**, **Library**, **Automation**, **To-do**, or **Connectors** when needed. From outside a Project, Library search covers processed sources across Projects; inside a Project, it searches the current Project plus the global Library. Task and Library results can show the Project they belong to. Automation and To-do search covers personal and Project items by title or content, including disabled automations and completed to-dos. Open a result to reveal its entry. Connector search covers catalog names and descriptions plus your custom connector names; opening a result reveals its card.

If an item does not appear:

- confirm the active account in the commercial edition;
- check whether it belongs to another Project or device-only location;
- clear an overly narrow filter;
- allow a newly added Library source to finish processing;
- check **Recycle Bin** in **Account settings > Data** if it may have been deleted;
- in the commercial edition, allow sync to finish if the item was recently changed elsewhere.

## Create an app

Open **Apps > Create**, describe the app you want, or choose a starter and edit its description. Select **Create** to start generation immediately in a new task. Review the result in that task and use **Save as app** when it is ready. If creation cannot start, retry with the preserved description; configure a model first if prompted.

## Open and save interactive results

An App is a reusable interactive tool, such as a calculator, dashboard, or tracker, with its own saved code and private data. Interactive results offer **Save as app** before the first save, then **Update original app** and **Save new app**. Save them to **Apps** for later use; a static report can instead remain a file or Library deliverable.

- Open **Apps** to launch saved apps.
- Use **Apps > Edit** to revise an app in a new task. On the new result, choose **Update original app** to keep its identity, or **Save new app** for an independent copy.
- Updating overwrites the saved code and retains compatible data. A deleted original is saved as a new app. After **Save new app**, further saves from that result update the copy.
- Export important data when the app offers an export option.

Not every artifact or file is eligible to become an app. The available actions on the result show what can be opened, saved, downloaded, or shared.

Treat a saved app as an interface to its own data and capabilities. Review any requested external action before confirming it.

## Publish an app (commercial edition only)

Open the app's menu in **Apps** and choose **Publish**. The Apps page and publishing dialog show your publication allowance. Desktop-only dependencies block publication. **Modify app for web publishing** opens a new editing task with the source and a prepared request to remove or replace those dependencies; review and send the request yourself. Membership and available account cloud storage are required. Visitors use the public link without signing in. Local edits require an explicit publication update. The published app menu offers **Update publication** and **Unpublish**; updating requires the source on this device. **Publication details** opens an app page with its link, PV, publication status and online data. Query records by time, edit or delete a record, and export data. **Clear all data** (or **Clear this table**) removes online records while keeping the app and table definitions.

Published files and online data share your account cloud storage with sync and project collaboration. Publication details show file, database and total usage. Deleting records frees space only after storage is reclaimed. There is no separate per-app size allowance. A full account blocks growth; reading and deleting remain available.

Local and online data are independent. The first publication starts with an empty online database; updating preserves compatible online records. Previews use temporary data. Personal cloud sync restores local records across devices and never transfers online records. Resolve competing device versions in **Account settings > Data**, then close and reopen the app.

Platform suspension closes public access; data is retained and details show the reason. Author export and cleanup remain available. **Unpublish** and expiration cleanup delete online records, files and PV; **Delete** is hidden until unpublishing completes, including for suspended apps. Local code and data remain after unpublishing. Follow the displayed seven-day deadline after expiration or an over-quota downgrade. Suspended apps still count toward the publication limit.

## Use Orkas capabilities inside an app

Local apps built for the Orkas host can use the configured model, app-private storage,
selected local files, text exports, the global Library and enabled connectors.
Availability depends on what the app requests and what is configured in Orkas;
older apps do not gain these abilities automatically. Ask for a revision in the
source task if an app lacks the needed feature. A standalone HTML export does
not carry Orkas capabilities into an ordinary browser.

- Use the app's file control to select a file. It reads a snapshot and cannot
  edit the original. Export text to a new filename; existing files are protected.
- Model generation can incur charges and does not ask for separate app consent.
  It receives the app's submitted text, without
  automatically using the task's conversation, Agent or Project context.
- Library access needs no separate app consent. Connected-service actions use
  the existing tool permissions and can cause external changes or fees. Sensitive
  actions ask in the Orkas dialog; **Allow for this use** covers the approved
  connector account and kind of sensitive action while this app stays open.
  Closing and reopening requires a new approval; other apps do not share it.
  **Trusted** runs available actions without confirmation. Prohibited actions
  remain unavailable.
- Each app has private data and file storage, separate from its source code.
  Apps can put business data in cloud storage and caches in device-local
  storage. Cloud storage syncs (commercial edition only) when the same account enables sync on each
  device; a successful save does not mean upload has finished. Older apps keep
  their existing local storage unless revised; data is not moved automatically.
  Reopening the same app restores its data; a newly saved copy has independent
  data. Export important data before switching copies. Resolve competing edits
  through the existing conflicts view in Account settings > Data.
- App language can follow the Orkas language setting. Reopen after changing it;
  an app with a fixed language needs a revision in its source task.
- Apps can load external scripts, styles, images, fonts and media, and call
  external services directly. Those services receive the data the app sends;
  direct calls do not use the connector permission dialog. External scripts have
  the app's capabilities. Service authentication and browser cross-origin rules
  still apply.

If permission is denied or a picker is cancelled, the user can continue using
the app and retry the action when ready. If the model is unavailable, configure
one in Orkas and reopen the app. After an account switch or app source change,
close and reopen it for a fresh session. Cancelling cannot undo an external
action or guarantee that a model request incurred no charge; check the result
before repeating it. For an export failure, choose a new filename on a supported
local filesystem.
