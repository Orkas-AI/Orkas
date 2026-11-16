# Common data semantics

The generated API reference includes the exact version-1 data definition schema.
Use stable table/field IDs. Renaming a display name preserves data; removal,
constraint/type changes and incompatible references fail migration.

Records have platform-generated `id` and UTC `createdAt` fields. Do not define
these names in custom table `fields` or include them in `access.insert`.
Values are finite safe
numbers, booleans, UTF-8 strings, JSON objects/arrays or null on nullable fields.
Timestamp fields use UTC ISO strings, normalized to millisecond precision.
Omitted fields use explicit defaults or remain absent. Query comparisons use
SQLite BINARY strings; ordering adds id as a stable tie-breaker. Canonical JSON
UTF-8 record bytes meter the online 20 MiB limit, including id/createdAt. JSON
null and absent fields both match a null filter. User-provided SQL is rejected.

Queries, counts and aggregates apply the declared read fields and readFilters.
Every selected or visitor-filtered field must be in `access.read`, including
`id` and `createdAt`; otherwise the whole query fails with `E_PERMISSION`.
Ordering by `id` alone is allowed without that grant; selecting or filtering it
still requires the grant. Other ordering fields, including `createdAt`, require
read access. Omitted query `fields` defaults to `access.read`; explicit `fields`
returns only that selection. For example, reading IDs, text and creation time:

```json
{
  "access": { "read": ["id", "body", "createdAt"], "insert": ["body"] },
  "query": {
    "table": "messages", "fields": ["id", "body", "createdAt"],
    "order": { "field": "createdAt", "direction": "desc" }
  }
}
```

Declared references target stable table IDs; include performs one-hop reads under
the target's read permissions. References must identify an existing record;
author deletion refuses references instead of silently cascading.

insertIf atomically checks the whole table count and inserts within one database
transaction; caller maxCount can only tighten the declared maxCount. This is a
generic concurrency operation, not a domain-specific enrollment or inventory API.
requestId deduplicates the same insert across reopening; conflicting reuse fails.
Bounded retention covers the latest 2048 requests. Show an explicit outcome when
a retry is outside this window. Runtime update/delete are not supported in v1.

Previews use temporary records. Handle unavailable/busy/permission/
capacity conditions visibly; do not fabricate successful records.

Use host.getContext().language for labels, errors, empty states, accessible names
and document lang unless the user requested a fixed application language. In a
public browser it reflects the visitor's language; desktop and preview use the
selected host language. Verify the visible controls in each intended language.
