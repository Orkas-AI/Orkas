import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONNECTOR_SETUP_GUIDES_DIR, PC_ROOT } from '../../../../src/main/paths';
import { CONNECTOR_CATALOG } from '../../../../src/main/features/connectors/catalog';
import { readConnectorSetupGuide, setupGuideId } from '../../../../src/main/features/connectors/setup-guides';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), statSync: vi.fn(actual.statSync) };
});

const xhs = CONNECTOR_CATALOG.find(entry => entry.id === 'xiaohongshu-seller')!;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
  vi.mocked(fs.statSync).mockImplementation(actual.statSync);
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe('bundled connector setup notes', () => {
  it('routes JD onboarding to the migrated platform without changing existing connector credentials', () => {
    const jd = CONNECTOR_CATALOG.find(entry => entry.id === 'jd-seller')!;
    const guide = readConnectorSetupGuide(jd);
    expect(jd.local_api?.provider).toBe('jd_jos');
    expect(jd.auth_mode).toBe('local_api');
    expect(jd.connection_setup!.fields.map(field => field.key)).toEqual(['app_key', 'app_secret']);
    expect(jd.connection_setup!.guide_url).toBe('https://open.jd.com/');
    expect(guide).toMatchObject({ available: true, entry_url: 'https://open.jd.com/' });
    if (!guide.available) throw new Error('Missing JD notes');
    expect(guide.sources).toContain('https://jos.jd.com/platformdetail?listId=0&itemId=2291');
    expect(guide.content).toContain('enterprise account');
    expect(guide.content).toContain('existing migrated application');
    expect(guide.content).not.toContain('[JD JOS](https://jos.jd.com/)');
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      const setup = jd.connection_setup as unknown as Record<string, string>;
      expect(setup[`guide_label_${lang}`]).toBeTruthy();
      expect(setup[`guide_label_${lang}`]).not.toMatch(/宙斯|Zeus|JOS/);
    }
  });

  it('gives every extra-configuration method compatible, concise notes with resolvable field references', () => {
    const entries = CONNECTOR_CATALOG.filter(entry => entry.connection_setup || entry.auth_mode === 'local_cli');
    expect(entries.length).toBeGreaterThan(30);
    const used = new Set(['oauth']);
    for (const entry of entries) {
      expect(entry.setup_guide_id, entry.id).toBeTruthy();
      const guide = readConnectorSetupGuide(entry);
      expect(guide, entry.id).toMatchObject({ available: true, id: entry.setup_guide_id });
      if (!guide.available) throw new Error(`Missing notes for ${entry.id}`);
      used.add(guide.id);
      expect(guide.content.length, entry.id).toBeLessThan(2000);
      for (const section of ['Entry', 'Configure', 'Credentials', 'Verify']) {
        expect(guide.content, entry.id).toContain(`## ${section}\n`);
      }
      expect(guide.content).not.toContain('[[');
      if (entry.connection_setup?.guide_url) expect(guide.sources).toContain(entry.connection_setup.guide_url);
      expect(guide).not.toHaveProperty('verified');
    }
    const authored = fs.readdirSync(CONNECTOR_SETUP_GUIDES_DIR)
      .filter(name => name.endsWith('.md') && name !== 'README.md').map(name => name.slice(0, -3));
    expect([...used].sort()).toEqual(authored.sort());
  });

  it('shares OAuth only for simple routes and never disguises an unauthored complex integration', () => {
    const notion = CONNECTOR_CATALOG.find(entry => entry.id === 'notion')!;
    expect(readConnectorSetupGuide(notion)).toMatchObject({ available: true, id: 'oauth' });
    expect(readConnectorSetupGuide({ ...xhs, setup_guide_id: undefined })).toEqual({
      available: false, reason: 'not_authored',
    });
    const netsuite = CONNECTOR_CATALOG.find(entry => entry.id === 'netsuite')!;
    expect(readConnectorSetupGuide({ ...netsuite, setup_guide_id: undefined })).toMatchObject({ available: false });
    const feishu = CONNECTOR_CATALOG.find(entry => entry.id === 'feishu')!;
    const lark = CONNECTOR_CATALOG.find(entry => entry.id === 'lark')!;
    expect(readConnectorSetupGuide(feishu)).toEqual(readConnectorSetupGuide(lark));
  });

  it('separates the verified console entry from reference documents without guessing entries for other methods', () => {
    expect(readConnectorSetupGuide(xhs)).toMatchObject({
      available: true, entry_url: 'https://ark.xiaohongshu.com/',
      sources: expect.arrayContaining([xhs.connection_setup!.guide_url]),
    });
    const notion = CONNECTOR_CATALOG.find(entry => entry.id === 'notion')!;
    expect(readConnectorSetupGuide(notion)).not.toHaveProperty('entry_url');
  });

  it.each([
    ['shopify-admin', 'https://dev.shopify.com/dashboard/'],
    ['square', 'https://developer.squareup.com/apps'],
    ['constant-contact', 'https://v3.developer.constantcontact.com/login/index.html'],
    ['douyin-shop-seller', 'https://op.jinritemai.com/'],
  ])('uses the official public console for %s, separate from documentation', (id, url) => {
    const entry = CONNECTOR_CATALOG.find(candidate => candidate.id === id)!;
    expect(readConnectorSetupGuide(entry)).toMatchObject({ available: true, entry_url: url });
    expect(url).not.toBe(entry.connection_setup!.guide_url);
  });

  it('keeps tenant and app-owned login routes dynamic', () => {
    for (const id of ['netsuite', 'woocommerce', 'notion', 'dingtalk']) {
      const entry = CONNECTOR_CATALOG.find(candidate => candidate.id === id)!;
      const guide = readConnectorSetupGuide(entry);
      expect(guide, id).toMatchObject({ available: true });
      expect(guide, id).not.toHaveProperty('entry_url');
    }
  });

  it('distinguishes production Ark evidence from the legacy sandbox menu', () => {
    const guide = readConnectorSetupGuide(xhs);
    if (!guide.available) throw new Error('Missing Ark notes');
    expect(guide.content).toContain('sandbox-only evidence, not a verified production menu');
    expect(guide.content).toContain('missing sandbox-style menu alone does not prove missing API approval');
    expect(guide.content).not.toContain('With an approved production account, locate Developer');
    expect(guide.sources).toContain('https://school.xiaohongshu.com/en/open/quick-start/how-to-get-app-key.html');
    expect(xhs.connection_setup!.guide_url).toBe('https://school.xiaohongshu.com/en/open/quick-start/workflow.html');
  });

  it('includes the prerequisite that previously left Shopify apps uninstalled and NetSuite roles unusable', () => {
    const content = (id: string) => {
      const guide = readConnectorSetupGuide(CONNECTOR_CATALOG.find(entry => entry.id === id)!);
      if (!guide.available) throw new Error(`Missing ${id} notes`);
      return guide.content;
    };
    const shopify = content('shopify-admin');
    expect(shopify).toContain('Release the version and install the app on the target store');
    expect(shopify).toContain('merchant approval in Shopify admin');
    expect(shopify).toContain('`client_id` help');
    expect(shopify).not.toContain('read_products'); // Scope facts stay in shared field help.
    const netsuite = content('netsuite');
    for (const fact of ['Server SuiteScript', 'OAuth 2.0', 'REST Web Services',
      'MCP Server Connection', 'Log in using OAuth 2.0 Access Tokens', 'non-Administrator',
      'DCR Public Client', 'Client Name: Orkas']) expect(netsuite).toContain(fact);
    expect(netsuite).toContain('Administrator and full-permission roles cannot use this service');
    expect(content('square')).toContain('Personal tokens have full account access');
    expect(content('constant-contact')).toContain('only the creating Constant Contact user');
    expect(content('constant-contact')).toContain('does not require a client secret or callback URL');
  });

  it.each([
    'http://console.example/', 'javascript:alert(1)', '/console',
    'https://secret@console.example/', 'https://console.example/?token=private',
    'https://console.example/#private', ' https://console.example/',
    123, '', `https://console.example/${'x'.repeat(2048)}`,
  ])('rejects unsafe or non-static entry metadata (%s) without returning it to the model', entryUrl => {
    const original = vi.mocked(fs.readFileSync).getMockImplementation()!;
    const file = path.join(CONNECTOR_SETUP_GUIDES_DIR, 'xiaohongshu-ark.md');
    const source = original(file, 'utf8').replace(
      /"entry_url":"[^"]+"/, `"entry_url":${JSON.stringify(entryUrl)}`,
    );
    vi.mocked(fs.readFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, ...args: any[]) => (
      String(target) === file ? source : (original as any)(target, ...args)
    )) as typeof fs.readFileSync);
    expect(readConnectorSetupGuide(xhs)).toEqual({ available: false, reason: 'resource_unavailable' });
  });

  it('rejects another adapter or a removed field instead of presenting plausible but wrong steps', () => {
    expect(readConnectorSetupGuide({ ...xhs, setup_guide_id: 'taobao-tmall-seller' })).toEqual({
      available: false, reason: 'incompatible_guide',
    });
    expect(readConnectorSetupGuide({ ...xhs, auth_mode: 'local_cli' })).toMatchObject({ available: false });
    const changed = { ...xhs, connection_setup: {
      ...xhs.connection_setup!, fields: xhs.connection_setup!.fields.filter(field => field.key !== 'app_key'),
    } };
    expect(readConnectorSetupGuide(changed)).toMatchObject({ available: false });
    expect(readConnectorSetupGuide(xhs)).toMatchObject({ available: true });
  });

  it.each(['../oauth', '/tmp/private', 'a/b', 'oauth.md', 'oauth%2f..', 'OAuth'])(
    'rejects the non-catalog basename %s before reading a resource', id => {
      const read = vi.spyOn(fs, 'readFileSync');
      expect(readConnectorSetupGuide({ ...xhs, setup_guide_id: id })).toEqual({
        available: false, reason: 'incompatible_guide',
      });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('keeps missing resources recoverable without leaking package paths or falling back to another guide', () => {
    expect(readConnectorSetupGuide({ ...xhs, setup_guide_id: 'missing-resource' })).toEqual({
      available: false, reason: 'resource_unavailable',
    });
    expect(readConnectorSetupGuide(xhs)).toMatchObject({ available: true, id: 'xiaohongshu-ark' });
  });

  it.each(['bad_json', 'unsafe_source', 'empty', 'unknown_reference', 'missing_date'])(
    'rejects %s content without leaking partial notes', fault => {
      const file = path.join(CONNECTOR_SETUP_GUIDES_DIR, 'xiaohongshu-ark.md');
      const original = vi.mocked(fs.readFileSync).getMockImplementation()!;
      let source = original(file, 'utf8');
      if (fault === 'bad_json') source = '<!-- setup-guide: {invalid} -->\nPRIVATE';
      if (fault === 'unsafe_source') source = source.replace('https://school.', 'https://secret@school.');
      if (fault === 'empty') source = source.split('\n')[0] + '\n';
      if (fault === 'unknown_reference') source += '\n[[field:unknown_secret]] PRIVATE';
      if (fault === 'missing_date') source = source.replace('catalog_reviewed_at', 'unrelated_date');
      vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...args: any[]) => (
        String(target) === file ? source : (original as any)(target, ...args)
      )) as typeof fs.readFileSync);
      expect(readConnectorSetupGuide(xhs)).toEqual({ available: false, reason: 'resource_unavailable' });
    },
  );

  it('rejects oversized resources before loading their contents', () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 6001 } as fs.Stats);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(readConnectorSetupGuide(xhs)).toMatchObject({ available: false });
    expect(read).not.toHaveBeenCalled();
  });

  it('ships the same read-only resource path for packaged macOS and Windows, not a dev-only directory', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PC_ROOT, 'package.json'), 'utf8'));
    expect(pkg.build.files).toContain('resources/connectors/setup/*.md');
    expect(pkg.build.files).toContain('bin/**/*');
    expect(pkg.build.asarUnpack).toContain('bin/**/*');
    expect(fs.statSync(path.join(PC_ROOT, 'bin', 'shopify-setup-requirements.cjs')).isFile()).toBe(true);
    expect(CONNECTOR_SETUP_GUIDES_DIR).toBe(path.join(PC_ROOT, 'resources', 'connectors', 'setup'));
    for (const entry of CONNECTOR_CATALOG) {
      const id = setupGuideId(entry);
      if (id) expect(fs.statSync(path.join(CONNECTOR_SETUP_GUIDES_DIR, `${id}.md`)).isFile()).toBe(true);
    }
  });
});
