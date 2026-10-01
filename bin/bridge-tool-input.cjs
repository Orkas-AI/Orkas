'use strict';

/** Strict tools reject before effects; tolerant tools disclose discarded names. */
exports.bridgeToolInput = (z, description, shape, handler, strict = false) => {
  if (strict) return [{ description, inputSchema: z.object(shape).strict() }, handler];
  const fields = new Set(Object.keys(shape));
  return [{
    description,
    inputSchema: z.object(shape).passthrough(),
  }, async (input, extra) => {
    const effective = {};
    const ignored = [];
    let ignoredCount = 0;
    let truncated = false;
    for (const key of Object.keys(input)) {
      if (fields.has(key)) {
        Object.defineProperty(effective, key, { value: input[key], enumerable: true, writable: true, configurable: true });
      } else {
        ignoredCount++;
        if (ignored.length < 10) {
          ignored.push(key.length > 80 ? `${key.slice(0, 80)}…` : key);
          if (key.length > 80) truncated = true;
        } else truncated = true;
      }
    }
    let result;
    try { result = await handler(effective, extra); }
    catch (error) {
      // Match the MCP server's existing thrown-error envelope.
      result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
    if (!ignoredCount) return result;
    const receipt = {
      ignored_fields: ignored,
      ...(truncated ? { ignored_field_count: ignoredCount, ignored_fields_truncated: true } : {}),
    };
    return { ...result, content: [...(result.content || []), { type: 'text', text: JSON.stringify(receipt) }] };
  }];
};
