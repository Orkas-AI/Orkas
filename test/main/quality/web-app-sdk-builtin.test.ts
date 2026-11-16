import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSkillDir } from '../../../src/main/quality';
import { catalogDocument, manifestSchema, METHODS } from '../../../src/main/features/web_apps/catalog';
import { syncWebAppSdkDocs } from '../../../scripts/web-app-sdk-docs';

const root = path.resolve(__dirname, '../../..');
const relative = 'resources/builtin/system/skills/web-app-sdk';
const skill = path.join(root, relative);
describe('Web app authoring package', () => {
  it('separates existing presentation edits from API selection without dropping source inspection or verification', () => {
    const body = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
    expect(body).toContain('inspect its source and `orkas-app.json` first');
    expect(body).toContain('only presentation');
    expect(body).toContain('do not need the API references or starter');
    expect(body).toContain('choosing or changing SDK APIs, data definitions or capabilities');
    expect(body).toContain('Verify visible actions');
    expect(body).toContain('close/reopen');
  });
  it.each(['local', 'web'] as const)('explains system-field authority in the generated %s contract and links both starter files', appType => {
    const catalog = catalogDocument(appType) as any;
    const table = catalog.dataDefinition.properties.tables.items.properties;
    expect(table.fields.description).toMatch(/id.*createdAt/);
    expect(table.access.properties.read.description).toMatch(/id.*createdAt/);
    expect(table.access.properties.insert.description).toMatch(/id.*createdAt/);
    const query = catalog.methods.find((method: any) => method.name === 'data.query');
    expect(query.inputSchema.properties.fields.description).toContain('access.read');
    expect(query.inputSchema.properties.fields.description).toMatch(/id.*createdAt/);
    expect(query.inputSchema.properties.order.description).toMatch(/id/);
    const links = [...fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8').matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
    for (const logical of Object.values(catalog.manifest.starter) as string[])
      expect(links).toContain(logical.replace('@skill/web-app-sdk/', ''));
  });
  it.each(['local', 'web'] as const)('requires a data definition in the documented %s manifest only when data is declared', appType => {
    const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
    const validate = new AjvJsonSchemaValidator().getValidator(catalogDocument(appType).manifest.schema);
    expect(validate({sdkVersion: 1, capabilities: ['data']}).valid).toBe(false);
    expect(validate({sdkVersion: 1, capabilities: []}).valid).toBe(true);
    expect(validate({sdkVersion: 1, capabilities: ['data'], data: {version: 1, tables: []}}).valid).toBe(true);
  });

  it.each(['storage', 'appFiles', 'files', 'ai', 'library', 'connectors', 'data'])('describes the actual web manifest capability boundary for %s while retaining local support', capability => {
    const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
    const validator = new AjvJsonSchemaValidator();
    const manifest = {sdkVersion: 1, capabilities: [capability], data: {version: 1, tables: []}};
    expect(validator.getValidator(catalogDocument('local').manifest.schema)(manifest).valid).toBe(true);
    expect(validator.getValidator(catalogDocument('web').manifest.schema)(manifest).valid).toBe(capability === 'data');
  });

  it.each(['local', 'web'] as const)('exposes the complete %s bundle contract and paired starter before authoring', appType => {
    const catalog = catalogDocument(appType) as any;
    expect(catalog.manifest?.file).toBe('orkas-app.json');
    const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
    const validate = new AjvJsonSchemaValidator().getValidator(catalog.manifest.schema);
    const starter = catalog.manifest.starter;
    const resolve = (logical: string) => path.join(skill, logical.replace('@skill/web-app-sdk/', ''));
    expect(fs.readFileSync(resolve(starter.entry), 'utf8')).toContain('/__orkas/sdk.js');
    const example = JSON.parse(fs.readFileSync(resolve(starter.manifest), 'utf8'));
    expect(validate(example).valid).toBe(true);
    expect(manifestSchema.safeParse(example).success).toBe(true);
    // Historical generated shapes must fail independently in the published
    // JSON schema and the host validator, rather than only in a text rubric.
    for (const invalid of [
      { capabilities: ['data'] }, { sdkVersion: 2, capabilities: [] },
      { sdkVersion: 1, capabilities: { data: true } },
      { sdkVersion: 1, capabilities: ['shell'] },
      { ...example, appType }, { ...example, name: 'Notes', version: '1' },
      { sdkVersion: 1, interfaces: { data: {} } },
    ]) {
      expect(validate(invalid).valid).toBe(false);
      expect(manifestSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('rejects malformed common definitions before an author can create or publish them',()=>{
    const fixture=JSON.parse(fs.readFileSync(path.resolve(root,'test/fixtures/app-data-v1.json'),'utf8'));for(const data of fixture.invalidDefinitions)expect(manifestSchema.safeParse({sdkVersion:1,capabilities:['data'],data}).success).toBe(false);
  });
  it('generates the standalone SDK package without creating a sibling Server directory',()=>{
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-sdk-standalone-'));const standalone=path.join(temporary,'Orkas');fs.mkdirSync(standalone);
    try{syncWebAppSdkDocs(standalone,false);expect(fs.existsSync(path.join(temporary,'Server'))).toBe(false);expect(()=>syncWebAppSdkDocs(standalone,true)).not.toThrow();}finally{fs.rmSync(temporary,{recursive:true,force:true});}
  });
  it('provides runnable examples and explicit result contracts for every common data operation',()=>{
    for(const [name,method] of Object.entries(METHODS))if(name.startsWith('data.')){expect(method.input.safeParse(method.example).success,name).toBe(true);expect(method.result,name).not.toBe('Structured data result.');}
  });
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
  // 2026-10-15 live regression: authors omitted orkas-app.json. The entry owns
  // the same-call declaration rule once; the web reference no longer mirrors it.
  it('states the same-call declaration rule once, in the entry every app type reads',()=>{
    const body=fs.readFileSync(path.join(skill,'SKILL.md'),'utf8').replace(/\s+/g,' ');
    expect(body).toContain('Include `orkas-app.json` in that same call, declaring every SDK capability the app uses');
    for(const reference of ['common.md','local.md','web.md'])
      expect(fs.readFileSync(path.join(skill,'references',reference),'utf8').replace(/\s+/g,' ')).not.toMatch(/in orkas-app\.json when using data|orkas-app\.json[^.]*same call/);
  });
  it('the documented timestamp query uses declared read authority and returned fields', async () => {
    const text = fs.readFileSync(path.join(skill, 'references/common.md'), 'utf8');
    const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]);
    const { LocalAppData } = await import('../../../src/main/features/web_apps/data');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sdk-query-example-'));
    const definition = { version: 1, tables: [{ id: 'messages', name: 'messages',
      fields: [{ id: 'body', name: 'body', type: 'string' }], access: example.access }] };
    const db = new LocalAppData(path.join(dir, 'data.sqlite'), dir, definition as any);
    try {
      await db.call('data.insert', { table: 'messages', values: { body: 'Retained' } });
      const response: any = await db.call('data.query', example.query);
      expect(response.records).toHaveLength(1);
      expect(response.records[0].body).toBe('Retained');
      expect(Number.isFinite(Date.parse(response.records[0].createdAt))).toBe(true);
      expect(response.records[0].id).toBeTypeOf('string');
      await db.close();
      const restrictedDefinition = structuredClone(definition);
      restrictedDefinition.tables[0].access.read = example.access.read.filter((field: string) => field !== 'id');
      const restricted = new LocalAppData(path.join(dir, 'data.sqlite'), dir, restrictedDefinition as any);
      try {
        await expect(restricted.call('data.query', example.query)).rejects.toMatchObject({ code: 'E_PERMISSION' });
        const sorted: any = await restricted.call('data.query', { table: 'messages', fields: ['body'], order: {field: 'id', direction: 'asc'} });
        expect(sorted.records).toEqual([{body: 'Retained'}]);
      } finally { await restricted.close(); }
    } finally { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('cloud guidance and generated contract contain only actually common interfaces',()=>{
    const cloud=JSON.parse(fs.readFileSync(path.join(skill,'references/web-api.json'),'utf8'));
    expect(cloud.methods.map((method:any)=>method.name)).toContain('data.insert');
    expect(cloud.methods.map((method:any)=>method.name)).not.toContain('ai.generate');
    expect(cloud.methods.map((method:any)=>method.name)).not.toContain('tools.call');
    expect(fs.readFileSync(path.join(skill,'SKILL.md'),'utf8')).toContain('references/web.md');
  });

  it.each(['docs/reference/web-app-sdk.json', `${relative}/references/api.json`])('rejects stale %s and restores it from the executable registry', target => {
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-sdk-docs-'));
    const isolated=path.join(temporary,'Orkas');fs.mkdirSync(isolated);
    try {
      syncWebAppSdkDocs(isolated, false);
      fs.writeFileSync(path.join(isolated, target), '{"sdkVersion":999}');
      expect(() => syncWebAppSdkDocs(isolated, true)).toThrow(`Web SDK reference is stale: ${target}`);
      syncWebAppSdkDocs(isolated, false);
      expect(() => syncWebAppSdkDocs(isolated, true)).not.toThrow();
      expect(JSON.parse(fs.readFileSync(path.join(isolated, target), 'utf8'))).toEqual(catalogDocument());
    } finally { fs.rmSync(temporary, {recursive:true, force:true}); }
  });
});
