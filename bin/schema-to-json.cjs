'use strict';

const { z } = require('zod');

/** Preserve the existing input contracts while using Zod's native converter. */
exports.schemaToJson = schema => z.toJSONSchema(schema, {
  target: 'draft-7',
  io: 'input',
  unrepresentable: ({ zodSchema }) => {
    const def = zodSchema._zod.def;
    // A dynamic catch defers action-specific validation to the executor. As
    // before, advertise its declared validator rather than inventing a default.
    if (def.type !== 'catch') return 'throw';
    const { $schema, ...inner } = exports.schemaToJson(def.innerType);
    return inner;
  },
  override: ({ zodSchema, jsonSchema }) => {
    const def = zodSchema._zod.def;
    // Discriminators make these branches disjoint. Retain the previous anyOf
    // representation consumed by the portable automation projection.
    if (def.type === 'union' && def.discriminator && jsonSchema.oneOf) {
      jsonSchema.anyOf = jsonSchema.oneOf;
      delete jsonSchema.oneOf;
    }
    if (def.type === 'object' && def.catchall?._zod.def.type === 'unknown') {
      jsonSchema.additionalProperties = true;
    }
  },
});
