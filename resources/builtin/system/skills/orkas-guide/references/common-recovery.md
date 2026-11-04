# Common recovery

## First identify the state

Choose the recovery path that matches what the user can see:

- **Waiting for input:** answer the question, confirmation, or form in the task.
- **Stopped:** review what completed, then send a focused continuation or start again.
- **Failed:** open the error summary, correct the likely cause, and retry.
- **Still working:** check current progress before creating a duplicate task.
- **Resource unavailable:** restore that resource or choose an available alternative.

The user can also ask **Commander** to check an Orkas app problem. When the
current build supports it, Commander can inspect sanitized model, connector,
Library, and running-task status and offer a click-to-open shortcut to the
relevant screen. This support path cannot read credentials or replace a
protected sign-in, secret-entry, payment, permission, or deletion flow.

After a restart, an interruption notice means the app stopped before that task
finished. A task whose final reply was already completed should reopen with that
result and no interruption notice.

## Sign-in page does not open (commercial edition only)

On the sign-in screen, select **Copy** and paste the link into a browser to
finish signing in. Keep Orkas open to receive the result. This uses the same
login attempt as the automatic browser opening.

## Model or account problem

Open the sidebar account menu, choose **Account settings > Models**, and confirm the selected model is ready for the active account. Complete sign-in or credential setup through the protected settings flow, check required credits or access, then retry with an available model.

## Agent, skill, or connector problem

- Confirm the resource is installed or enabled.
- For a connector, confirm its connected state and reconnect if authorization expired.
- For connected Feishu/Lark, DingTalk, WeCom or Xero, **card three-dot menu > Reauthorize** is always available to complete authorization with the service when needed. The connection and selected capabilities are retained; other authorized features remain usable. Return to the task afterward; failed actions are not replayed automatically. If access is still denied, check the service's account or administrator permissions.
- Check that the intended external account or workspace is selected.
- Enable only the connector capabilities the task needs.
- Return to the task, select the restored resource, and retry.

Do not solve a connection problem by posting credentials or tokens into the conversation.

## Task failure after an external action

Before retrying, inspect the external service or result history to see whether the action already succeeded. If the outcome is uncertain, ask Orkas to verify state first. This avoids duplicate messages, records, purchases, or destructive actions.

## Missing Project, task, Library item, or app

1. Confirm the active account and check the Project or resource's normal sidebar area.
2. Use sidebar **Search** (Cmd/Ctrl+K) with a known title or phrase.
3. Check filters, the original Project, and the relevant device.
4. Let sync finish if the item changed on another device.
5. Check **Recycle Bin** in **Account settings > Data** if it may have been deleted.

Restore a recoverable item before permanently deleting its recycle-bin batch.

## Sync does not settle (commercial edition only)

Keep Orkas open and online, then check the status under **Account settings > Data > Cloud sync** (use **Sync now** to retry) and the active account on each device. Avoid editing the same item in two places until sync finishes. Review **Conflict log** for competing versions. If the problem continues, let pending work finish before signing out, disabling sync, or deleting cloud data.

## Notifications, microphone, or update issue

For task notifications, check **Account settings > General** and the operating system's notification permission. For commercial voice input, confirm sign-in and credits; the open-source build uses its configured Orkas API Key. For either build, check that a microphone is available and allowed in system settings. For an official app update (commercial edition only), save current work, then use **Account settings > General > App & updates** to download it and **Restart to update**.

## When normal recovery is not enough

Preserve the task title, approximate time, visible error, and whether an external action may already have occurred. In the commercial edition, send that information with **Send feedback** in the sidebar account menu. Do not include passwords, secret keys, access tokens, or unrelated private content.
