import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const catalogs = [
  ['PC', 'PC/src/main/data/avatars.json'],
  ['iOS', 'iOS/webui/data/avatars.json'],
  ['Web', 'Web/res/data/avatars.json'],
] as const;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateCatalog(label: string, relPath: string, catalog: any): void {
  expect(catalog && typeof catalog, `${label} must be an object: ${relPath}`).toBe('object');
  expect(typeof catalog.commander_default?.icon, `${label} missing commander_default.icon: ${relPath}`).toBe('string');
  expect(typeof catalog.commander_default?.color, `${label} missing commander_default.color: ${relPath}`).toBe('string');
  expect(Array.isArray(catalog.icons) && catalog.icons.length > 0, `${label}.icons must be non-empty: ${relPath}`).toBe(true);
  expect(Array.isArray(catalog.colors) && catalog.colors.length > 0, `${label}.colors must be non-empty: ${relPath}`).toBe(true);

  const iconIds = new Set<string>();
  for (const icon of catalog.icons || []) {
    expect(typeof icon?.id, `${label}.icons contains invalid entry: ${relPath}`).toBe('string');
    expect(typeof icon?.label, `${label}.icons contains invalid entry: ${relPath}`).toBe('string');
    expect(typeof icon?.svg, `${label}.icons contains invalid entry: ${relPath}`).toBe('string');
    expect(iconIds.has(icon.id), `${label}.icons duplicate id "${icon.id}": ${relPath}`).toBe(false);
    iconIds.add(icon.id);
  }

  const colorIds = new Set<string>();
  for (const color of catalog.colors || []) {
    expect(typeof color?.id, `${label}.colors contains invalid entry: ${relPath}`).toBe('string');
    expect(typeof color?.label, `${label}.colors contains invalid entry: ${relPath}`).toBe('string');
    expect(typeof color?.bg, `${label}.colors contains invalid entry: ${relPath}`).toBe('string');
    expect(typeof color?.fg, `${label}.colors contains invalid entry: ${relPath}`).toBe('string');
    expect(colorIds.has(color.id), `${label}.colors duplicate id "${color.id}": ${relPath}`).toBe(false);
    colorIds.add(color.id);
  }

  expect(iconIds.has(catalog.commander_default.icon), `${label}.commander_default.icon is not in icons: ${relPath}`).toBe(true);
  expect(colorIds.has(catalog.commander_default.color), `${label}.commander_default.color is not in colors: ${relPath}`).toBe(true);
}

describe('avatar catalogs', () => {
  it('keeps PC, iOS, and Web avatar resources consistent', () => {
    const rows = catalogs.map(([label, relPath]) => {
      const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
      validateCatalog(label, relPath, catalog);
      return { label, relPath, normalized: stableStringify(catalog) };
    });

    const first = rows[0];
    for (const row of rows.slice(1)) {
      expect(
        row.normalized,
        `${row.label} (${row.relPath}) differs from ${first.label} (${first.relPath})`,
      ).toBe(first.normalized);
    }
    expect(first.normalized.length).toBeGreaterThan(0);
  });
});
