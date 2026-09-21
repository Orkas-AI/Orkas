import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSkillDir } from '../../../src/main/quality';
import { catalogDocument, manifestSchema } from '../../../src/main/features/web_apps/catalog';
import { syncWebAppSdkDocs } from '../../../scripts/web-app-sdk-docs';

const root = path.resolve(__dirname, '../../..');
const relative = 'resources/builtin/system/skills/web-app-sdk';
const skill = path.join(root, relative);
describe('Web app authoring package', () => {
  it('ships a valid self-contained Skill, starter and exact current API reference', () => {
    const report = validateSkillDir(skill);
    expect(report.ok, JSON.stringify(report.violations)).toBe(true);
    const body = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
    const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
    expect(links.length).toBeGreaterThan(0);
    expect(body).toContain('200 MiB');
    expect(body).not.toMatch(/four concurrent|two host-wide|256 storage keys|512 KiB|16 selected files|five-minute/);
    for (const link of links) expect(fs.statSync(path.join(skill, link)).isFile()).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(skill, 'assets/starter/orkas-app.json'), 'utf8'));
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(skill, 'references/api.json'), 'utf8'))).toEqual(catalogDocument());
    expect(() => syncWebAppSdkDocs(root, true)).not.toThrow();
    expect(fs.existsSync(path.join(skill, '_meta.json'))).toBe(false);
  });

  it('rejects a stale public Skill API reference and restores it from the executable registry', () => {
    const target = `${relative}/references/api.json`;
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sdk-docs-'));
    try {
      syncWebAppSdkDocs(isolated, false);
      fs.writeFileSync(path.join(isolated, target), '{"sdkVersion":999}');
      expect(() => syncWebAppSdkDocs(isolated, true)).toThrow(`Web SDK reference is stale: ${target}`);
      syncWebAppSdkDocs(isolated, false);
      expect(() => syncWebAppSdkDocs(isolated, true)).not.toThrow();
      expect(JSON.parse(fs.readFileSync(path.join(isolated, target), 'utf8'))).toEqual(catalogDocument());
    } finally { fs.rmSync(isolated, {recursive:true, force:true}); }
  });
});
