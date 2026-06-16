/**
 * Validation for user-supplied custom MCP server transports — the single
 * gate between raw renderer form input and a stored `ConnectorInstance`
 * (docs/plans/open-ecosystem-architecture.md §C2: every install entry point
 * funnels through ONE validated route).
 *
 * Security posture (§C3):
 *   - streamable-http: https only, except plain-http to loopback hosts
 *     (local dev servers). Header names/values length-capped.
 *   - stdio: the user-typed command IS the consent artifact — the renderer
 *     form shows exactly what will run, and `connectors.add_custom` stores
 *     it verbatim (no shell interpretation here; spawn uses argv arrays).
 *   - Everything lands inside `secrets_enc` via the registry (headers/env
 *     may carry API keys), so nothing here needs additional redaction.
 */

import type { Transport } from './types';

const MAX_STR = 4096;
const MAX_LIST = 64;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,128}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface CustomConnectorInput {
  display_name: string;
  transport: {
    kind: 'stdio' | 'streamable-http';
    /** stdio */
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** streamable-http */
    url?: string;
    headers?: Record<string, string>;
  };
}

export class CustomTransportError extends Error {
  /** Stable machine code for the renderer to i18n. */
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function _str(v: unknown, code: string, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new CustomTransportError(code, `${what} is required`);
  if (v.length > MAX_STR) throw new CustomTransportError(code, `${what} is too long`);
  return v.trim();
}

function _isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
    || h.endsWith('.localhost');
}

export function validateDisplayName(raw: unknown): string {
  const name = _str(raw, 'E_NAME', 'display name');
  if (!NAME_RE.test(name)) {
    throw new CustomTransportError('E_NAME', 'display name allows letters, digits, space, . _ / - (max 64)');
  }
  return name;
}

/** Derive the instance id from a display name. Always `custom-` prefixed so
 *  a custom id can never collide with (or skin itself as) a catalog entry. */
export function deriveCustomId(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `custom-${slug || 'server'}`;
}

function _validateHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CustomTransportError('E_HEADERS', 'headers must be a name→value map');
  }
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_LIST) throw new CustomTransportError('E_HEADERS', 'too many headers');
  for (const [name, value] of entries) {
    if (!HEADER_NAME_RE.test(name)) throw new CustomTransportError('E_HEADERS', `invalid header name: ${name}`);
    if (typeof value !== 'string' || value.length > MAX_STR || /[\r\n]/.test(value)) {
      throw new CustomTransportError('E_HEADERS', `invalid header value for: ${name}`);
    }
    out[name] = value;
  }
  return out;
}

function _validateEnv(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CustomTransportError('E_ENV', 'env must be a name→value map');
  }
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_LIST) throw new CustomTransportError('E_ENV', 'too many env entries');
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name)) throw new CustomTransportError('E_ENV', `invalid env name: ${name}`);
    if (typeof value !== 'string' || value.length > MAX_STR) {
      throw new CustomTransportError('E_ENV', `invalid env value for: ${name}`);
    }
    out[name] = value;
  }
  return out;
}

/** Validate + normalize raw form input into a storable Transport. Throws
 *  `CustomTransportError` with a stable code on any violation. */
export function validateCustomTransport(raw: CustomConnectorInput['transport']): Transport {
  if (!raw || typeof raw !== 'object') throw new CustomTransportError('E_TRANSPORT', 'transport is required');

  if (raw.kind === 'streamable-http') {
    const urlStr = _str(raw.url, 'E_URL', 'url');
    let url: URL;
    try { url = new URL(urlStr); }
    catch { throw new CustomTransportError('E_URL', 'url is not a valid URL'); }
    if (url.protocol === 'http:') {
      if (!_isLoopbackHost(url.hostname)) {
        throw new CustomTransportError('E_URL_INSECURE', 'plain http is allowed only for localhost');
      }
    } else if (url.protocol !== 'https:') {
      throw new CustomTransportError('E_URL', 'url must be https (or http on localhost)');
    }
    const headers = _validateHeaders(raw.headers);
    return {
      kind: 'streamable-http',
      url: url.toString(),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }

  if (raw.kind === 'stdio') {
    const command = _str(raw.command, 'E_COMMAND', 'command');
    if (/[\r\n]/.test(command)) throw new CustomTransportError('E_COMMAND', 'command must be a single line');
    const argsRaw = raw.args === undefined || raw.args === null ? [] : raw.args;
    if (!Array.isArray(argsRaw) || argsRaw.length > MAX_LIST) {
      throw new CustomTransportError('E_ARGS', 'args must be a list (max 64)');
    }
    const args = argsRaw.map((a, i) => {
      if (typeof a !== 'string' || a.length > MAX_STR) {
        throw new CustomTransportError('E_ARGS', `invalid arg at position ${i}`);
      }
      return a;
    });
    const env = _validateEnv(raw.env);
    // cwd intentionally NOT accepted from the form: the server runs with the
    // manager's default cwd; a user-chosen cwd adds confusion without a use
    // case (the command/args can encode paths explicitly).
    return {
      kind: 'stdio',
      command,
      args,
      ...(Object.keys(env).length ? { env } : {}),
    };
  }

  throw new CustomTransportError('E_TRANSPORT', 'transport.kind must be stdio or streamable-http');
}
