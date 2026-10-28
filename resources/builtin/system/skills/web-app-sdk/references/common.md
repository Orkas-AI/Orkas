# Common data semantics

The generated API reference includes the exact version-1 data definition schema.
Use stable table/field IDs. Renaming a display name preserves data; removal,
constraint/type changes and incompatible references fail migration.

Records have a platform-generated id and UTC createdAt; do not redeclare these
names in table fields. Values are finite safe
numbers, booleans, UTF-8 strings, JSON objects/arrays or null on nullable fields.
Timestamp fields use UTC ISO strings, normalized to millisecond precision.
Omitted fields use explicit defaults or remain absent. Query comparisons use
SQLite BINARY strings; ordering adds id as a stable tie-breaker. Canonical JSON
UTF-8 record bytes meter the online 20 MiB limit, including id/createdAt. JSON
null and absent fields both match a null filter. User-provided SQL is rejected.

Queries, counts and aggregates apply the declared read fields and readFilters.
A query's selected fields, filters and non-id ordering require access.read;
createdAt ordering requires it too. Explicit query fields determine the returned
projection: granting read access alone does not add a field to that projection.
For example, reading message text and creation time in newest-first order:

```json
{
  "access": { "read": ["body", "createdAt"], "insert": ["body"] },
  "query": {
    "table": "messages", "fields": ["body", "createdAt"],
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

Personal desktop sync restores local data on another device; it never migrates
online data. Previews use temporary records. Handle unavailable/busy/permission/
capacity conditions visibly; do not fabricate successful records.

Use host.getContext().language for labels, errors, empty states, accessible names
and document lang unless the user requested a fixed application language. In a
public browser it reflects the visitor's language; desktop and preview use the
selected host language. Verify the visible controls in each intended language.
