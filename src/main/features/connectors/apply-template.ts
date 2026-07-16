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
import { app } from 'electron';

import * as paths from '../../paths';
import type { CatalogEntry, OAuthGrant, Transport } from './types';

type EnvSynth = (access_token: string) => Record<string, string>;

// Cache the Electron-as-Node values once per process — `process.execPath` and PC_ROOT are
// immutable at runtime. Lazy because `app` is undefined in vitest paths that pull this module
// without an Electron context.
let _electronAsNode: { node: string; pcDir: string } | null = null;
function _electronAsNodeVars(): { node: string; pcDir: string } {
  if (_electronAsNode) return _electronAsNode;
  const isPackaged = !!app && app.isPackaged;
  // Packaged builds: rewrite `app.asar` → `app.asar.unpacked` so the spawned child can read the
  // adapter script as a real file on disk (asar contents aren't visible to a child process that
  // doesn't have the asar mount logic). Mirrors `client.ts::buildSkillSandboxEnv`.
  const pcDir = isPackaged
    ? paths.PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
    : paths.PC_ROOT;
  _electronAsNode = { node: process.execPath, pcDir };
  return _electronAsNode;
}

/** Resolve `${ORKAS_NODE}` / `${ORKAS_PC_DIR}` placeholders inside a stdio template's
 *  command / args. Lets connector catalog entries reference our adapter scripts by symbolic
 *  path without hard-coding absolute paths at catalog-author time. Unknown placeholders throw
 *  to surface typos at install — silent passthrough would let `${ORKS_NODE}` slip through and
 *  spawn a literal-named binary that doesn't exist. */
function _resolvePlaceholders(s: string): string {
  const vars = _electronAsNodeVars();
  return s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, key) => {
    if (key === 'ORKAS_NODE') return vars.node;
    if (key === 'ORKAS_PC_DIR') return vars.pcDir;
    throw new Error(`unknown placeholder \${${key}} in transport template`);
  });
}

function _hasElectronAsNodePlaceholder(tpl: { command: string; args: string[] }): boolean {
  if (/\$\{ORKAS_NODE\}/.test(tpl.command)) return true;
  return tpl.args.some((a) => /\$\{ORKAS_NODE\}/.test(a) || /\$\{ORKAS_PC_DIR\}/.test(a));
}

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
    // Electron-as-Node injection: templates pointing at our own bundled adapter scripts (e.g.
    // `${ORKAS_NODE}` + `${ORKAS_PC_DIR}/bin/gmail-mcp-server.cjs`) need `ELECTRON_RUN_AS_NODE=1`
    // in the child env so Electron boots as plain Node. Same pattern as `client.ts::
    // buildSkillSandboxEnv`. We only inject these when the template actually uses a
    // placeholder — third-party stdio servers like the legacy `npx @modelcontextprotocol/server-X`
    // pattern stay env-clean.
    if (_hasElectronAsNodePlaceholder(tpl)) {
      const vars = _electronAsNodeVars();
      env = { ...env, ELECTRON_RUN_AS_NODE: '1', ORKAS_NODE: vars.node, ORKAS_PC_DIR: vars.pcDir };
    }
    return {
      kind: 'stdio',
      command: _resolvePlaceholders(tpl.command),
      args: tpl.args.map((a) => _resolvePlaceholders(a)),
      env,
      ...(tpl.proxy_target_url ? { proxyTargetUrl: tpl.proxy_target_url } : {}),
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
