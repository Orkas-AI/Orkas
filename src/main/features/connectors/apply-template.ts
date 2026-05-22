/**
 * Materialize a concrete `Transport` from a catalog entry's `transport_template` + an OAuth grant.
 *
 * Called at install time AND at every reconnect after a refresh so the spawned MCP server
 * always sees the *current* access_token. The template's `oauth_env_key` / `oauth_header_key` /
 * `env_synthesizer` decides how the token shows up in the spawn env.
 *
 * Validation lives here because catalog entries don't know whether a token is still valid;
 * throw on missing pieces, the caller surfaces the error.
 */
import type { CatalogEntry, OAuthGrant, Transport } from './types';

type EnvSynth = (access_token: string) => Record<string, string>;

const _SYNTHESIZERS: Record<string, EnvSynth> = {
  // Notion OAuth: the official @notionhq/notion-mcp-server reads `OPENAPI_MCP_HEADERS`, a JSON
  // blob holding the Authorization + Notion-Version headers.
  notion_oauth_headers(access_token) {
    if (!access_token) throw new Error('notion_oauth_headers: missing access_token');
    return {
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${access_token}`,
        'Notion-Version': '2022-06-28',
      }),
    };
  },
};

export function applyTemplate(entry: CatalogEntry, grant: OAuthGrant): Transport {
  if (!entry.transport_template) {
    throw new Error('connector not installable (no transport_template)');
  }
  const tpl = entry.transport_template;
  const token = grant.access_token;
  if (!token) throw new Error('OAuth grant has no access_token');
  if (tpl.kind === 'stdio') {
    let env: Record<string, string> = {};
    if (tpl.env_synthesizer) {
      const synth = _SYNTHESIZERS[tpl.env_synthesizer];
      if (!synth) throw new Error(`unknown env_synthesizer: ${tpl.env_synthesizer}`);
      env = { ...synth(token) };
    } else if (tpl.oauth_env_key) {
      env[tpl.oauth_env_key] = token;
    } else {
      throw new Error('OAuth stdio template needs either oauth_env_key or env_synthesizer');
    }
    return {
      kind: 'stdio',
      command: tpl.command,
      args: [...tpl.args],
      env,
    };
  }
  // streamable-http
  const headers: Record<string, string> = {};
  const headerName = tpl.oauth_header_key || 'Authorization';
  // Always send `Bearer` per RFC 6750 — `grant.token_type` is descriptive metadata from the
  // provider (Slack returns "bot", Notion sometimes returns "bearer" lowercase), NOT a wire
  // hint for the HTTP Authorization header. Every MCP server we target treats anything but
  // the literal "Bearer" prefix as missing/invalid token (Slack rejects "bot" with
  // `missing_token`, Notion rejected lowercase "bearer" with `invalid_token`). If we ever
  // need a non-Bearer scheme, add `oauth_header_scheme?: string` to the transport template
  // and default to Bearer.
  headers[headerName] = `Bearer ${token}`;
  return {
    kind: 'streamable-http',
    url: tpl.url,
    headers,
  };
}
