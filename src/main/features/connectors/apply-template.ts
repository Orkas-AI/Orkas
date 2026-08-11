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
import { resolveBackgroundNodeRuntime, withBackgroundNodeEnv } from '../../util/background-node';
import type { CatalogEntry, OAuthGrant, Transport } from './types';

type EnvSynth = (access_token: string) => Record<string, string>;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const OBJECT_META_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// Cache the app-owned adapter runtime once per process. Packaged/dev runtime
// preparation guarantees bundled Node; on macOS the resolver deliberately
// refuses to fall back to the GUI Electron executable because every direct
// Electron helper launch can produce a separate App Data privacy prompt.
let _adapterRuntime: {
  node: string;
  pcDir: string;
  electronAsNode: boolean;
} | null = null;
function _adapterRuntimeVars(): { node: string; pcDir: string; electronAsNode: boolean } {
  if (_adapterRuntime) return _adapterRuntime;
  const isPackaged = !!app && app.isPackaged;
  // Packaged builds: rewrite `app.asar` → `app.asar.unpacked` so the spawned child can read the
  // adapter script as a real file on disk (asar contents aren't visible to a child process that
  // doesn't have the asar mount logic). Mirrors `client.ts::buildSkillSandboxEnv`.
  const pcDir = isPackaged
    ? paths.PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
    : paths.PC_ROOT;
  const runtime = resolveBackgroundNodeRuntime();
  _adapterRuntime = { node: runtime.executable, pcDir, electronAsNode: runtime.electronAsNode };
  return _adapterRuntime;
}

/** Resolve `${ORKAS_NODE}` / `${ORKAS_PC_DIR}` placeholders inside a stdio template's
 *  command / args. Lets connector catalog entries reference our adapter scripts by symbolic
 *  path without hard-coding absolute paths at catalog-author time. Unknown placeholders throw
 *  to surface typos at install — silent passthrough would let `${ORKS_NODE}` slip through and
 *  spawn a literal-named binary that doesn't exist. */
function _resolvePlaceholders(s: string): string {
  const vars = _adapterRuntimeVars();
  return s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, key) => {
    if (key === 'ORKAS_NODE') return vars.node;
    if (key === 'ORKAS_PC_DIR') return vars.pcDir;
    throw new Error(`unknown placeholder \${${key}} in transport template`);
  });
}

function _hasAppOwnedNodePlaceholder(tpl: { command: string; args: string[] }): boolean {
  if (/\$\{ORKAS_NODE\}/.test(tpl.command)) return true;
  return tpl.args.some((a) => /\$\{ORKAS_NODE\}/.test(a) || /\$\{ORKAS_PC_DIR\}/.test(a));
}

function _assertMappingKey(
  value: string,
  kind: 'environment variable' | 'HTTP header',
  pattern: RegExp,
): void {
  if (!pattern.test(value) || OBJECT_META_KEYS.has(value.toLowerCase())) {
    throw new Error(`invalid OAuth ${kind} name in transport template`);
  }
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
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('OAuth grant has no access_token');
  }
  if (tpl.kind === 'stdio') {
    if (tpl.env_synthesizer && tpl.oauth_env_key) {
      throw new Error('OAuth stdio template cannot set both oauth_env_key and env_synthesizer');
    }
    let env: Record<string, string> = {};
    if (tpl.env_synthesizer) {
      const synth = _SYNTHESIZERS[tpl.env_synthesizer];
      if (!synth) throw new Error(`unknown env_synthesizer: ${tpl.env_synthesizer}`);
      env = { ...synth(token) };
    } else if (tpl.oauth_env_key) {
      _assertMappingKey(tpl.oauth_env_key, 'environment variable', ENV_KEY_RE);
      env[tpl.oauth_env_key] = token;
    } else {
      throw new Error('OAuth stdio template needs either oauth_env_key or env_synthesizer');
    }
    // App-owned adapter templates use the stock bundled Node runtime. Keep
    // third-party stdio commands env-clean and preserve the Electron marker
    // only for the non-macOS emergency fallback described by the resolver.
    if (_hasAppOwnedNodePlaceholder(tpl)) {
      const vars = _adapterRuntimeVars();
      env = withBackgroundNodeEnv(
        { ...env, ORKAS_PC_DIR: vars.pcDir },
        { executable: vars.node, electronAsNode: vars.electronAsNode },
      );
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
  const headerName = tpl.oauth_header_key === undefined
    ? 'Authorization'
    : tpl.oauth_header_key;
  _assertMappingKey(headerName, 'HTTP header', HEADER_NAME_RE);
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
