import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MARKETPLACE_TREE_HASH_ALGORITHM = 'sha256-tree-v1';
export const MARKETPLACE_RESOURCE_MANIFEST_NAME = '_resource_manifest.json';

// Codepoint order, NOT localeCompare: this digest is a CROSS-LANGUAGE contract
// with the Python hasher in Resource/sync-resource-marketplace.py (which sorts by
// codepoint), and the committed online-hashes.json baselines are Python-computed.
// ICU collation (localeCompare) is case-insensitive-first and ICU-build dependent,
// so mixed-case trees hashed differently across the two sides / across Node builds.
function _codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const MARKETPLACE_TREE_HASH_SKIP_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  '__MACOSX',
  '__pycache__',
  '.git',
  'node_modules',
  '_install.json',
  '_cache.json',
  '_marketplace.json',
  MARKETPLACE_RESOURCE_MANIFEST_NAME,
]);

export function marketplaceContentTreeHash(root: string): string {
  return marketplaceContentTreeHashForFiles(root, marketplaceContentTreeFiles(root));
}

export function marketplaceContentTreeHashForFiles(root: string, files: Iterable<string>): string {
  const normalized = Array.from(new Set(Array.from(files)
    .map((rel) => _normalizeRelFile(rel))
    .filter((rel): rel is string => !!rel)))
    .sort(_codepointCompare);
  if (normalized.length === 0) return '';
  return _hashFiles(root, normalized);
}

export function marketplaceContentTreeFiles(root: string): string[] {
  return _listHashFiles(root);
}

function _hashFiles(root: string, files: string[]): string {
  if (files.length === 0) return '';
  const h = crypto.createHash('sha256');
  h.update(`${MARKETPLACE_TREE_HASH_ALGORITHM}\0`);
  for (const rel of files) {
    const abs = path.join(root, rel);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      return '';
    }
    h.update(rel.replace(/\\/g, '/'));
    h.update('\0');
    h.update(String(bytes.length));
    h.update('\0');
    h.update(bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

function _normalizeRelFile(rel: string): string | null {
  const text = String(rel || '').replace(/\\/g, '/').trim();
  if (!text || path.isAbsolute(text)) return null;
  const parts = text.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '..' || part === '.')) return null;
  if (parts.some((part) => MARKETPLACE_TREE_HASH_SKIP_NAMES.has(part) || part.startsWith('.'))) return null;
  return parts.join('/');
}

function _listHashFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const dir = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => !MARKETPLACE_TREE_HASH_SKIP_NAMES.has(e.name) && !e.name.startsWith('.'))
        .sort((a, b) => _codepointCompare(a.name, b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out.sort(_codepointCompare);
}
