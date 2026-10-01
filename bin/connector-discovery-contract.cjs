/** Shared discovery parameters for native tools and all external CLI bridges. */
'use strict';

exports.description = 'Discover visible connectors. With connector_id, small catalogs return all schemas; large catalogs return a bounded page. query searches visible action names, descriptions and argument names with BM25 (keywords, no embeddings); omit connector_id to search across connectors. tool_name expands one exact schema before calling the connector.';
exports.callSuitability = 'Call only when the action description supports the requested operation. Matching argument types, similar names or shared record numbers do not establish suitability.';
exports.emptySearchGuidance = 'No keyword matches in the entire visible action catalog for this scope; pagination cannot find more matches for this query. This does not prove the capability is absent. Try provider-language action terms if not tried. If those also find no action whose description supports the request, stop and explain that no suitable action was found in the current visible scope. Do not call an unrelated action.';
exports.inputSchema = {
  type: 'object',
  properties: {
    connector_id: { type: 'string', description: 'Visible connector id; omit for inventory or cross-connector query.' },
    tool_name: { type: 'string', description: 'Exact action name; requires connector_id. Use alone to expand its complete input schema.' },
    query: { type: 'string', minLength: 1, maxLength: 1024, description: 'Find capabilities using provider-language action/argument keywords, not record ids. Put connector ids in connector_id; business ids belong in call arguments. No semantic translation.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Page size: default 8 for search, 20 for browsing; maximum 50.' },
    offset: { type: 'integer', minimum: 0, description: 'Continuation offset from next_offset; default 0. Reuse the same query and connector_id.' },
  },
  additionalProperties: false,
};
exports.shape = z => Object.fromEntries(Object.entries(exports.inputSchema.properties).map(([key, field]) => {
  let value = field.type === 'string' ? z.string() : z.number().int().safe();
  if (field.minLength !== undefined) value = value.min(field.minLength);
  if (field.maxLength !== undefined) value = value.max(field.maxLength);
  if (field.minimum !== undefined) value = value.min(field.minimum);
  if (field.maximum !== undefined) value = value.max(field.maximum);
  return [key, value.optional().describe(field.description)];
}));
