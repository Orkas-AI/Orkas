'use strict';

const { schemaToJson } = require('./schema-to-json.cjs');

const { projectToolInput } = require('./tool-input-compat.cjs');
const { formatParameterError, zodParameterError } = require('./tool-parameter-errors.cjs');

/** Unknown envelope fields are ignored; declared fields retain Zod validation. */
exports.bridgeToolInput = (z, description, shape, handler, compatibilityFields = []) => {
  const fields = [...Object.keys(shape), ...compatibilityFields];
  const inputSchema = z.object(shape).passthrough();
  let inputJson;
  let outputJson;
  // SDK v2 consumes Standard Schema. Keep discovery's optional defaults and
  // preferred numeric bounds aligned with the existing execution contract.
  inputSchema['~standard'] = {
    ...inputSchema['~standard'],
    // Keep discovery unchanged. The callback runs this same owning parser once
    // so its final rejection can use our shared receipt instead of SDK prose.
    validate: value => ({ value }),
    jsonSchema: {
      input: () => inputJson ||= schemaToJson(inputSchema),
      output: () => outputJson ||= schemaToJson(inputSchema),
    },
  };
  return [{
    description,
    inputSchema,
  }, async (input, extra) => {
    let parsed;
    try { parsed = inputSchema.safeParse(input); }
    catch (error) {
      // Some existing compatibility catches deliberately rethrow ZodError.
      // Keep their rejection and exact issues; never replay a parser/handler.
      if (!(error instanceof z.ZodError)) throw error;
      parsed = { success: false, error };
    }
    const { input: effective, receipt } = projectToolInput(parsed.success ? parsed.data : input, fields);
    let result;
    try { result = parsed.success ? await handler(effective, extra)
      : { content: [{ type: 'text', text: zodParameterError(parsed.error.issues) }], isError: true }; }
    catch (error) {
      // Match the MCP server's existing thrown-error envelope.
      result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
    if (result.isError) result = { ...result, content: (result.content || []).map(block => block.type === 'text'
      ? { ...block, text: formatParameterError(block.text, true) } : block) };
    if (!receipt) return result;
    return { ...result, content: [...(result.content || []), { type: 'text', text: JSON.stringify(receipt) }] };
  }];
};
