# Deleting a file from a Skill

Delete only files inside the current Skill directory. Never simulate deletion with an empty `<<<skill-file>>>` block.

## Confirmation flow

1. Call `delete_file({ path: "<absolute-path>" })` without a token. The tool returns `requires_user_confirmation: true` and a confirmation token. For several intended deletions, make one tokenless call per exact path in the same turn.
2. Stop. Name the files and why they are unrelated, then ask the user to use the confirmation card. Do not call the tool again in that turn.
3. On a later user turn, call `delete_file` for each path with its matching token:
   - `granted` → deletion completed;
   - `E_AWAITING_USER` → stop and retain the same token for a later turn;
   - `E_USER_DENIED` → keep the file and do not retry;
   - `E_INVALID_TOKEN` → request a fresh token with a new tokenless call.

If the user explicitly names files, delete only those. An import/create/cleanup request authorizes proposing removal of unrelated files discovered inside the Skill, but every deletion still uses the confirmation card. Do not claim cleanup is complete before every approved deletion succeeds.
