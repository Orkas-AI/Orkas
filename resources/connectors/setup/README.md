# Connector setup notes

These are bundled connection-method references, not Skills or user-editable
conversation state. `CatalogEntry.setup_guide_id` binds an exact method to a
Markdown basename. Compatible entries may share a guide; ordinary OAuth uses
`oauth.md` only when no extra configuration is declared. New complex entries
without a binding report `not_authored`, not a fabricated generic procedure.

Keep each guide to four short sections: Entry, Configure, Credentials, Verify.
Prefer fewer than 200 words; keep only facts that change the next setup action.
Behavior/authority belongs to the shared setup prompt, not these files. Do not
copy field definitions, callback values, account state or secret values here.
Use `[[field:catalog_key]]` for field references; the reader validates them
against the selected connector and returns field keys alongside existing field
help. A renamed/removed field must update its guide in the same change.

The first line is a JSON metadata comment with the exact `setup-guide` marker:
`auth_modes`, optional `provider` and `entry_url`, `catalog_reviewed_at`, and `sources` (HTTPS
official references beyond the catalog's existing `guide_url`). Compatibility
is checked against the selected adapter, never inferred from a platform name.
The catalog review date means the notes were checked against repository-owned
configuration, not that a live account/console was tested. Initial notes derive
from those existing requirements and field help; platform-page freshness and
account eligibility still require verification. Never relabel a copied date as
live-provider verification. Unknown entries or changed pages need official
evidence, not guessed URLs or selectors.

`entry_url` is an optional, verified public console/login entry for this exact
method, separate from documentation. Use a static HTTPS URL without userinfo,
query or fragment; never an account-specific or generated authorization URL.
Omit it when the entry is tenant-specific or not established by official
evidence. `start` prefers it to the catalog documentation URL but preserves an
existing page. Missing/invalid notes keep the existing documentation fallback.
This selects a starting page, not a prescribed workflow or proof of API access.

Edit the matching notes when app type, auth flow, required permissions, field
mapping or verification changes. Keep the source links applicable to the exact
adapter; do not replace a legacy API's credentials with another platform
product's credentials. Review and release these files with the connector code.
The model has no write-back interface to this directory.

Shopify's exact scope requirements are owned by
`bin/shopify-setup-requirements.cjs`, shared by token validation and localized
catalog field help. The guide references that help rather than copying a scope
list. Changing these requirements must update runtime and guidance tests;
documentation alone must not broaden the adapter's required permissions.

`connector_setup.inspect/start` returns only the selected guide alongside the
existing shared behavior prompt and catalog facts. The assistance button binds
the same connector; hidden turn context carries its guide ID for discovery,
not every guide body on every follow-up. Neither inspection nor guide loading
starts authorization or changes grants. A missing/corrupt resource is reported
without exposing filesystem paths, while existing configuration remains usable.

The package includes these Markdown files inside app.asar through `build.files`;
the reader resolves them from PC_ROOT identically on macOS and Windows. No extra
runtime download or marketplace installation is needed. Owning tests cover
catalog completeness, binding compatibility, field drift, isolation, content
budgets, package inclusion and inspect/start parity. Those deterministic tests
do not prove that a model completes a real provider's setup.
