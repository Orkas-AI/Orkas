import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const catalogs = [
  ['Orkas', 'src/main/data/avatars.json'],
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
    expect(icon.svg.trim(), `${label}.icons has invalid SVG root for ${icon?.id}: ${relPath}`)
      .toMatch(/^<svg(?:\s|>)[\s\S]*<\/svg>$/);
    expect(icon.svg, `${label}.icons has executable SVG for ${icon?.id}: ${relPath}`)
      .not.toMatch(/<(?:script|style|foreignObject|iframe|object|embed|image|use|a)\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=|javascript:|url\s*\(/i);
    if (label === 'Orkas') {
      expect(typeof icon?.description, `${label}.icons missing semantic metadata for ${icon?.id}: ${relPath}`).toBe('string');
      expect(icon.description.trim().length, `${label}.icons has empty semantic metadata for ${icon?.id}: ${relPath}`).toBeGreaterThan(0);
    }
    if ('auto_seed' in icon) {
      expect(typeof icon.auto_seed, `${label}.icons contains invalid auto_seed: ${relPath}`).toBe('boolean');
    }
    expect(iconIds.has(icon.id), `${label}.icons duplicate id "${icon.id}": ${relPath}`).toBe(false);
    iconIds.add(icon.id);
  }

  const colorIds = new Set<string>();
  for (const color of catalog.colors || []) {
    expect(typeof color?.id, `${label}.colors contains invalid entry: ${relPath}`).toBe('string');
    expect(typeof color?.label, `${label}.colors contains invalid entry: ${relPath}`).toBe('string');
    expect(typeof color?.bg, `${label}.colors contains invalid entry: ${relPath}`).toBe('string');
    expect(typeof color?.fg, `${label}.colors contains invalid entry: ${relPath}`).toBe('string');
    expect(color.bg, `${label}.colors has unsafe bg for ${color?.id}: ${relPath}`)
      .toMatch(/^#[0-9a-f]{6}$/i);
    expect(color.fg, `${label}.colors has unsafe fg for ${color?.id}: ${relPath}`)
      .toMatch(/^#[0-9a-f]{6}$/i);
    expect(colorIds.has(color.id), `${label}.colors duplicate id "${color.id}": ${relPath}`).toBe(false);
    colorIds.add(color.id);
  }

  expect(iconIds.has(catalog.commander_default.icon), `${label}.commander_default.icon is not in icons: ${relPath}`).toBe(true);
  expect(colorIds.has(catalog.commander_default.color), `${label}.commander_default.color is not in colors: ${relPath}`).toBe(true);
}

describe('avatar catalogs', () => {
  it('keeps the bundled avatar resource valid', () => {
    const rows = catalogs.map(([label, relPath]) => {
      const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
      validateCatalog(label, relPath, catalog);
      // Semantic descriptions are metadata rather than part of the renderer contract.
      const renderCatalog = {
        ...catalog,
        icons: catalog.icons.map(({ description: _description, ...icon }: any) => icon),
      };
      return { label, relPath, normalized: stableStringify(renderCatalog) };
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

  it('keeps agent-creator icon candidates aligned with the runtime catalog', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, catalogs[0][1]), 'utf8'));
    const creatorSkill = fs.readFileSync(
      path.join(repoRoot, 'resources/builtin/system/skills/agent-creator/SKILL.md'),
      'utf8',
    );
    const candidateLine = creatorSkill.match(/^Avatar icon candidates \(exact IDs\): (.+)$/m)?.[1] || '';
    const skillIds = [...candidateLine.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const catalogIds = catalog.icons
      .filter((icon: any) => icon.id !== catalog.commander_default.icon)
      .map((icon: any) => icon.id);

    expect(skillIds).toEqual(catalogIds);
    expect(new Set(skillIds).size).toBe(skillIds.length);
    expect(skillIds).not.toContain('crown');
  });

  it('provides opt-in role icons while keeping legacy seed-derived colors stable', async () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, catalogs[0][1]), 'utf8'));
    const roleIconIds = [
      'search', 'film', 'document', 'spreadsheet', 'presentation', 'image',
      'chart', 'graduation-cap', 'book-open', 'calculator', 'users',
      'megaphone', 'shopping-bag', 'archive', 'activity',
      'git-pull-request', 'briefcase', 'clipboard',
    ];
    expect(catalog.icons.some((icon: any) => icon.id === 'leaf')).toBe(false);
    expect(catalog.icons.filter((icon: any) => icon.id !== catalog.commander_default.icon)).toHaveLength(32);
    for (const id of roleIconIds) {
      expect(catalog.icons.find((icon: any) => icon.id === id), id)
        .toMatchObject({ id, auto_seed: false });
    }
    const film = catalog.icons.find((icon: any) => icon.id === 'film');
    const search = catalog.icons.find((icon: any) => icon.id === 'search');
    expect(film).toMatchObject({ id: 'film', label: 'Film', auto_seed: false });
    expect(search).toMatchObject({ id: 'search', label: 'Search', auto_seed: false });
    expect(film.svg).toContain('<rect x="3" y="3" width="18" height="18"');
    expect(search.svg).toContain('<circle cx="11" cy="11" r="7"');

    const context: any = {
      window: {
        orkas: {
          invoke: async () => ({ catalog }),
        },
      },
    };
    vm.createContext(context);
    vm.runInContext(
      fs.readFileSync(path.join(repoRoot, 'src/renderer/modules/avatar.js'), 'utf8'),
      context,
      { filename: 'avatar.js' },
    );
    await context.initAvatarCatalog();

    const legacyIcons = catalog.icons.filter((icon: any) => (
      icon.id !== catalog.commander_default.icon && icon.auto_seed !== false
    ));
    const legacyColors = catalog.colors.filter((color: any) => color.id !== catalog.commander_default.color);
    const legacyAvatar = (seed: string) => {
      let hash = 5381;
      for (const char of seed) hash = ((hash << 5) + hash) + char.charCodeAt(0);
      hash >>>= 0;
      return {
        icon: 'bot',
        color: legacyColors[Math.floor(hash / 15) % legacyColors.length].id,
      };
    };

    for (const seed of ['legacy-agent-a', 'legacy-agent-b', '79df9cc89f5f']) {
      expect(JSON.parse(JSON.stringify(context.avatarFromSeed(seed)))).toEqual(legacyAvatar(seed));
    }
    expect(JSON.parse(JSON.stringify(context.resolveAvatar('film', 'violet', 'video-studio'))))
      .toMatchObject({ icon: 'film', color: 'violet' });
    expect(JSON.parse(JSON.stringify(context.resolveAvatar('search', 'sky', 'deep-researcher'))))
      .toMatchObject({ icon: 'search', color: 'sky' });

    for (const relPath of ['src/renderer/modules/avatar.js']) {
      const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
      expect(source, relPath).toContain("i.id === 'bot'");
      expect(source, relPath).toContain('LEGACY_AVATAR_COLOR_STRIDE');
    }
  });

  it('keeps the avatar picker wide and responsive', () => {
    const platforms = [
      ['src/renderer/style.css', 'src/renderer/modules/avatar-picker.js'],
    ];
    for (const [relPath, pickerRelPath] of platforms) {
      const css = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
      const picker = css.match(/\.avatar-picker\s*\{([\s\S]*?)\}/)?.[1] || '';
      const grid = css.match(/\.avatar-picker-grid\s*\{([\s\S]*?)\}/)?.[1] || '';
      expect(picker, relPath).toContain('width: 380px');
      expect(picker, relPath).toContain('max-width: calc(100vw - 24px)');
      expect(grid, relPath).toContain('repeat(8, 30px)');
      const pickerSource = fs.readFileSync(path.join(repoRoot, pickerRelPath), 'utf8');
      expect(pickerSource, pickerRelPath).toContain('const colors = AVATAR_COLORS;');
      expect(pickerSource, pickerRelPath).not.toMatch(/AVATAR_COLORS\.filter/);
    }
  });

  it('keeps builtin agent icons semantically aligned with their roles', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, catalogs[0][1]), 'utf8'));
    const knownIcons = new Set(catalog.icons.map((icon: any) => icon.id));
    const knownColors = new Set(catalog.colors.map((color: any) => color.id));
    const expected = [
      ['resources/builtin/marketplace/agents/79df9cc89f5f/agent.json', 'VideoStudio', 'film', 'violet'],
      ['resources/builtin/marketplace/agents/814b61b027f0/agent.json', 'ImageStudio', 'image', 'violet'],
      ['resources/builtin/marketplace/agents/a19101ba698a/agent.json', 'OfficeWorker', 'briefcase', 'sky'],
      ['resources/builtin/marketplace/agents/7e91cb9ec9e9/agent.json', 'PptMaker', 'presentation', 'violet'],
      ['resources/builtin/marketplace/agents/78900d8758bc/agent.json', 'DeepResearcher', 'search', 'sky'],
      ['resources/builtin/marketplace/agents/bcfcb4921dce/agent.json', 'UIDesigner', 'palette', 'violet'],
      ['resources/builtin/marketplace/agents/e064dca9e1bd/agent.json', 'SeoGeoAgent', 'target', 'gold'],
      ['resources/builtin/marketplace/agents/173d4235a431/agent.json', 'ContentWriter', 'document', 'lavender'],
      ['resources/builtin/marketplace/agents/a316881746f9/agent.json', 'ProductDeveloper', 'code', 'sage'],
    ] as const;

    const officialAgentFiles = [
      ...fs.readdirSync(path.join(repoRoot, 'resources/builtin/marketplace/agents'))
        .map((id) => path.join(repoRoot, 'resources/builtin/marketplace/agents', id, 'agent.json')),
    ].filter((file) => fs.existsSync(file));
    expect(expected).toHaveLength(officialAgentFiles.length);
    expect(expected.map(([relPath]) => relPath).sort()).toEqual(
      officialAgentFiles
        .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
        .sort(),
    );

    for (const [relPath, name, icon, color] of expected) {
      const agent = JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
      expect(agent, relPath).toMatchObject({ name, icon, color });
      expect(knownIcons.has(agent.icon), `${name} uses unknown icon ${agent.icon}`).toBe(true);
      expect(knownColors.has(agent.color), `${name} uses unknown color ${agent.color}`).toBe(true);
    }
  });

  it('uses semantic model selection instead of random avatars during creation', () => {
    const renderer = fs.readFileSync(path.join(repoRoot, 'src/renderer/modules/agents.js'), 'utf8');
    const avatarRenderer = fs.readFileSync(path.join(repoRoot, 'src/renderer/modules/avatar.js'), 'utf8');
    expect(renderer).not.toContain('randomAgentAvatar()');
    expect(avatarRenderer).not.toContain('function randomAgentAvatar');
    expect(renderer).toMatch(/icon:\s*'code',\s*color:\s*'sage'/);
  });

  it('uses bot when the local catalog does not recognize an icon', async () => {
    const current = JSON.parse(fs.readFileSync(path.join(repoRoot, catalogs[0][1]), 'utf8'));
    const legacyCatalog = {
      ...current,
      icons: current.icons.filter((icon: any) => icon.auto_seed !== false),
    };
    const context: any = {
      window: { orkas: { invoke: async () => ({ catalog: legacyCatalog }) } },
    };
    vm.createContext(context);
    vm.runInContext(
      fs.readFileSync(path.join(repoRoot, 'src/renderer/modules/avatar.js'), 'utf8'),
      context,
      { filename: 'avatar.js' },
    );
    await context.initAvatarCatalog();

    const resolved = JSON.parse(JSON.stringify(
      context.resolveAvatar('spreadsheet', 'sky', 'legacy-excel-agent'),
    ));
    expect(resolved.icon).toBe('bot');
    expect(resolved.color).toBe('sky');

    const missing = JSON.parse(JSON.stringify(
      context.resolveAvatar('', 'sky', 'legacy-excel-agent'),
    ));
    expect(missing.icon).toBe('bot');
    expect(missing.color).toBe('sky');
  });
});
