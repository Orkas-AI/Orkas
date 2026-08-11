# Task notifications regression

## Scope

Native notifications are an attention layer for tasks that reach a terminal
state while Orkas is still running but no app window is focused. The app-level
preference and the operating-system permission are independent authorities:
the checkbox stores the user's choice, while the recovery row explains when the
system prevents visible delivery. Notifications do not change task execution,
window-close, or process-exit behavior.

Unread task replies are a separate in-app attention layer. Their red dots are
sidebar-only: next to the Tasks/Projects section labels, the owning project,
and each unread task row. No project header, project tab, or content task list
may mirror those dots.

## Scenario matrix

| User goal / scenario | Starting state and variation | Expected observable outcome | Consequential failure and recovery | Layer and independent oracle | Current risk or coverage gap |
| --- | --- | --- | --- | --- | --- |
| Keep the notification choice across restarts | Preference missing, enabled, or disabled | Missing defaults to enabled; an explicit choice survives a full relaunch | A stale checkbox misleads the user about delivery; reopening Settings must recover from disk | Config unit plus Electron E2E reads the persisted preference after relaunch | Renderer-only checks cannot prove real IPC and persistence wiring |
| Enable notifications while OS permission is refreshing | Saved preference is off, a focus/load permission read is pending, and the user enables notifications | The new preference remains enabled while a denied OS result still shows the actionable recovery row | Treating the whole read as stale can overwrite the user choice or hide recovery | Renderer race harness independently controls read/write completion and observes the final checkbox and warning | Preference and permission have different authorities and completion order |
| Recover from a failed write | The setter rejects, returns a mismatched value, or throws | The checkbox rolls back to the actual/previous value, is re-enabled, and can be retried | False success leaves notification delivery different from the UI | Renderer harness injects each failure and observes final state and bounded local logs | Optimistic UI must not become the persisted source of truth |
| Recover from blocked system presentation | App preference enabled; permission denied or badge-only; settings route available or unavailable | Warning appears only while blocked, the button appears only when actionable, and focus return refreshes status | The app claims delivery is enabled without a recovery path | Renderer permission-state harness plus platform manual matrix | Real OS presentation state is platform-owned and cannot be fully simulated portably |
| Notice a finished background task | Completed, failed, waiting for input, or cancelled; app focused or backgrounded | Supported background terminal states create one generic native notification; focused/cancelled states do not | Missing notification hides completed work; a false notification distracts the user | Main feature tests observe the native-notification adapter and prohibited calls | Actual banners require platform manual verification |

## Automated coverage

- `test/e2e/settings_e2e_persistence.spec.ts`
  - changes the real Settings checkbox through renderer, preload, Main IPC, and
    persisted configuration;
  - verifies the value after a full Electron relaunch.
- `test/renderer/settings-task-notifications.test.ts`
  - proves the enabling-write versus permission-read race in both completion
    orders;
  - rolls back rejected, mismatched, and thrown writes without disabling retry;
  - shows denied and badge-only recovery only while the app preference is on;
  - refreshes permission after returning from System Settings;
  - verifies all shipped locales provide badge-only recovery copy.
- `test/main/features/config.test.ts`
  - proves default enabled behavior plus explicit disable/re-enable persistence.
- `test/main/features/notification_permissions.test.ts`
  - covers macOS authorization/presentation normalization, Windows setting
    mapping, and platform settings URLs.
- `test/main/features/task_notifications.test.ts`
  - covers focused-window, unsupported-platform, cancelled, and inactive-user
    suppression; generic localized copy; click routing; handle retention; and
    synchronous/asynchronous delivery failure cleanup.
- `test/renderer/task-notification-navigation.test.ts`
  - holds cold-start clicks until initialization, rejects malformed navigation,
    and opens the originating conversation.

## Manual matrix

1. Open Settings → General → Task notifications.
   - A new user sees the checkbox enabled.
   - Turning it off suppresses completed, failed, and waiting-for-input system
     notifications without changing task execution or in-app results.
   - Turning it on restores notifications without restarting.
2. Relaunch after each checkbox state.
   - Settings shows the last saved state.
3. Disable Orkas notifications in macOS or Windows settings while the app
   checkbox remains enabled, then return to Settings.
   - A permission warning appears below the checkbox.
   - **Open system settings** is present only when the platform exposes a route.
   - Enabling permission and returning to Orkas hides the stale warning.
   - Turning the app checkbox off hides the warning without changing OS state.
4. On macOS, leave only the app-icon badge enabled and disable banners/alerts
   plus Notification Center.
   - Settings reports that visible presentation is disabled.
   - Restoring banners/alerts or Notification Center clears the warning after
     Orkas regains focus.
5. Start a task and keep the Orkas window focused until completion.
   - No native notification appears.
6. Start a task, then minimize Orkas or focus another application.
   - Exactly one generic notification appears after the entire task finishes.
   - It contains no prompt, conversation title, attachment name, generated
     content, path, or other private user data.
7. Click the notification.
   - A minimized or hidden window is restored and focused.
   - The originating conversation opens and its latest history loads.
8. Stop a running task.
   - No native completion notification appears.

## Synchronization protection

The source synchronization rules declare five required shared regions for this
capability: configuration persistence, Main IPC preference handling, Settings
DOM, renderer state handling, and permission-warning styles. Every region is
checked on every synchronization run even when its surrounding multi-feature
file has an accepted whole-file adaptation. Region drift or a missing/ambiguous
anchor must fail closed, repair from the commercial source, and select the
owning focused tests above.

This regression matrix is itself an explicitly inventoried test support file.
That exact declaration overrides the source repository's broad private-docs
filter; unrelated commercial process and design documents remain excluded.

## Residual gap

Automated tests cannot portably force every real macOS/Windows notification
presentation configuration. Release verification must retain manual steps 3–7
and inspect application/runtime logs for delivery rejection, fallback, timeout,
or an unexpected error before reporting the platform path as verified.
