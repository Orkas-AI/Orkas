import type { CatalogConnectionField, CatalogEntry } from './types';

const PLACEHOLDER_RE = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const NETSUITE_ACCOUNT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/;
const NETSUITE_DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ResolvedCatalogConnection {
  entry: CatalogEntry;
  parameters?: Record<string, string>;
}

function _isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function _normalizeField(
  field: CatalogConnectionField,
  value: unknown,
): { stored: string; template: string } {
  if (value === undefined || value === null || value === '') {
    throw new Error(`connector parameter required: ${field.key}`);
  }
  if (typeof value !== 'string') throw new Error(`invalid connector parameter: ${field.key}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`connector parameter required: ${field.key}`);

  if (field.format === 'netsuite_account_id') {
    if (!NETSUITE_ACCOUNT_ID_RE.test(trimmed)) {
      throw new Error('invalid NetSuite account ID');
    }
    const domainLabel = trimmed.toLowerCase().replace(/_/g, '-');
    if (!NETSUITE_DOMAIN_LABEL_RE.test(domainLabel)) {
      throw new Error('invalid NetSuite account ID');
    }
    return { stored: trimmed.toUpperCase(), template: domainLabel };
  }
  throw new Error(`unsupported connector parameter format: ${String(field.format)}`);
}

/** Validate user-controlled connection fields and materialize an account-specific HTTP target.
 *  The resolved URL is still catalog-owned: users can only fill named, format-restricted slots. */
export function resolveCatalogConnection(
  entry: CatalogEntry,
  rawParameters?: unknown,
): ResolvedCatalogConnection {
  const setup = entry.connection_setup;
  if (!setup) {
    if (rawParameters !== undefined && rawParameters !== null) {
      if (!_isPlainObject(rawParameters) || Object.keys(rawParameters).length > 0) {
        throw new Error(`connector '${entry.id}' does not accept connection parameters`);
      }
    }
    return { entry };
  }
  if (!_isPlainObject(rawParameters)) throw new Error('connector connection parameters required');
  if (!entry.transport_template || entry.transport_template.kind !== 'streamable-http') {
    throw new Error('connector connection setup requires a streamable-http transport');
  }

  const fields = new Map(setup.fields.map((field) => [field.key, field]));
  if (!fields.size || fields.size !== setup.fields.length) {
    throw new Error('invalid connector connection setup');
  }
  for (const key of Object.keys(rawParameters)) {
    if (!fields.has(key)) throw new Error(`unknown connector parameter: ${key}`);
  }

  const stored: Record<string, string> = {};
  const replacements = new Map<string, string>();
  for (const field of setup.fields) {
    const normalized = _normalizeField(field, rawParameters[field.key]);
    stored[field.key] = normalized.stored;
    replacements.set(field.key, normalized.template);
  }

  const seen = new Set<string>();
  const resolvedUrl = entry.transport_template.url.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const replacement = replacements.get(key);
    if (!replacement) throw new Error(`unknown connector URL placeholder: ${key}`);
    seen.add(key);
    return replacement;
  });
  if (seen.size !== replacements.size || /\{\{[^}]+\}\}/.test(resolvedUrl)) {
    throw new Error('connector URL template does not match its connection fields');
  }
  const parsed = new URL(resolvedUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('resolved connector URL must be credential-free HTTPS');
  }

  return {
    parameters: stored,
    entry: {
      ...entry,
      transport_template: { ...entry.transport_template, url: parsed.toString() },
    },
  };
}
