'use strict';

// Shared by native tools, the MCP bridge and the authoritative host writer.
const PROJECT_INSTRUCTIONS_CHAR_LIMIT = 4000;
const PROJECT_INSTRUCTIONS_TEXT_DESCRIPTION =
  `Complete replacement goal/rules text, including any existing content that still applies. Maximum ${PROJECT_INSTRUCTIONS_CHAR_LIMIT} UTF-16 code units; a supplementary Unicode character counts as two.`;

module.exports = { PROJECT_INSTRUCTIONS_CHAR_LIMIT, PROJECT_INSTRUCTIONS_TEXT_DESCRIPTION };
