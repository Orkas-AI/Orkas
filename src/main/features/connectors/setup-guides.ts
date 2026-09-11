/** Read-only, packaged connector instructions. Catalog bindings select files;
 * neither user input nor model text supplies a path. Shared behavior stays in
 * connector_setup_guidance; these notes contain connection-method facts only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONNECTOR_SETUP_GUIDES_DIR } from '../../paths';
import type { CatalogEntry } from './types';

const MAX_GUIDE_BYTES = 6000;
const OAUTH_MODES = new Set(['server_bridge', 'mcp_dcr', 'composio']);

export type SetupGuide = {
  available: true;
  id: string;
  content: string;
  catalog_reviewed_at: string;
  sources: string[];
  entry_url?: string;
} | {
  available: false;
  reason: 'not_authored' | 'resource_unavailable' | 'incompatible_guide';
};

/** Exported for packaging/contract checks as well as the on-demand reader. */
export function setupGuideId(entry: CatalogEntry): string | undefined {
  return entry.setup_guide_id || (
    !entry.connection_setup && OAUTH_MODES.has(entry.auth_mode) ? 'oauth' : undefined
  );
}

export function readConnectorSetupGuide(entry: CatalogEntry): SetupGuide {
  const id = setupGuideId(entry);
  if (!id) return { available: false, reason: 'not_authored' };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    return { available: false, reason: 'incompatible_guide' };
  }
  try {
    const file = path.join(CONNECTOR_SETUP_GUIDES_DIR, `${id}.md`);
    if (fs.statSync(file).size > MAX_GUIDE_BYTES) throw new Error('Guide exceeds budget');
    const source = fs.readFileSync(file, 'utf8');
    const header = /^<!-- setup-guide: (\{[^\n]+\}) -->\r?\n/.exec(source);
    if (!header) throw new Error('Guide metadata is missing');
    const meta = JSON.parse(header[1]);
    const provider = entry.local_api?.provider || entry.local_cli?.provider;
    if (!Array.isArray(meta.auth_modes) || !meta.auth_modes.includes(entry.auth_mode)
      || (meta.provider !== undefined && meta.provider !== provider)) {
      return { available: false, reason: 'incompatible_guide' };
    }
    if (typeof meta.catalog_reviewed_at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(meta.catalog_reviewed_at)
      || !Array.isArray(meta.sources) || !meta.sources.every((value: unknown) => {
        if (typeof value !== 'string') return false;
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      })) throw new Error('Guide provenance is invalid');
    // This is a static public console entry, never a generated authorization
    // URL or a place to embed account credentials or callback state.
    if (meta.entry_url !== undefined) {
      if (typeof meta.entry_url !== 'string' || meta.entry_url.length > 2048
        || meta.entry_url !== meta.entry_url.trim()) throw new Error('Guide entry is invalid');
      const url = new URL(meta.entry_url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('Guide entry is invalid');
      }
    }
    const fields = new Set(entry.connection_setup?.fields.map(field => field.key) || []);
    const content = source.slice(header[0].length).trim().replace(
      /\[\[field:([a-z][a-z0-9_]*)\]\]/g,
      (_match, key: string) => {
        if (!fields.has(key)) throw new Error('Guide field is absent from catalog');
        return `\`${key}\``;
      },
    );
    if (!content || content.includes('[[')) throw new Error('Guide reference is invalid');
    return {
      available: true, id, content,
      ...(meta.entry_url ? { entry_url: meta.entry_url } : {}),
      catalog_reviewed_at: meta.catalog_reviewed_at,
      sources: [...new Set<string>([
        ...(entry.connection_setup?.guide_url ? [entry.connection_setup.guide_url] : []),
        ...meta.sources,
      ])],
    };
  } catch {
    // Missing or stale resources must not break ordinary connector discovery,
    // expose package paths, or pretend a generic workflow covers a complex app.
    return { available: false, reason: 'resource_unavailable' };
  }
}
