import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

type Reply = { status: number; body: Record<string, unknown> | Buffer };
type CatalogRow = Record<string, any>;

/** A frozen, local catalog with the versions already bundled into this test account.
 * No new default installs are offered. Assets stay available if reconciliation
 * actually requests them; neither install manifests nor local hashes are patched.
 */
export class BackgroundServices {
  private catalog?: { agents: CatalogRow[]; skills: CatalogRow[] };
  private assets = new Map<string, Buffer>();
  readonly uploads: Array<Record<string, unknown>> = [];

  constructor(private workspace: string, private userId: string) {}

  asset(route: string): Buffer | undefined { return this.assets.get(route); }

  marketplace(route: string, bytes: Buffer, origin: string): Reply {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bytes.toString('utf8'));
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('invalid');
    } catch { return { status: 400, body: { code: 1, msg: 'invalid_payload' } }; }
    const allowed = ['/agents/list', '/skills/list', '/agents/detail', '/skills/bundle', '/defaults'];
    if (!allowed.includes(route)) return { status: 404, body: { code: 404, msg: 'e2e_stub_route_not_found' } };
    if (!this.catalog) {
      const manifest = JSON.parse(readFileSync(path.join(this.workspace, this.userId, 'cloud/marketplace/installs.json'), 'utf8'));
      this.catalog = { agents: [], skills: [] };
      for (const kind of ['agents', 'skills'] as const) {
        for (const row of manifest[kind] || []) {
          const dir = path.join(this.workspace, this.userId, 'local/marketplace', kind, row.id);
          const assetPath = `/e2e-background/${kind}/${row.id}/${kind === 'agents' ? 'agent.json' : 'bundle.zip'}`;
          let name = row.id;
          let privateSkillsUrl = '';
          if (kind === 'agents') {
            const content = readFileSync(path.join(dir, 'agent.json'));
            name = JSON.parse(content.toString('utf8')).name || row.id;
            this.assets.set(assetPath, content);
            const skillsDir = path.join(dir, 'skills');
            if (existsSync(skillsDir) && readdirSync(skillsDir).some((id) => existsSync(path.join(skillsDir, id, 'SKILL.md')))) {
              const zip = new AdmZip();
              zip.addLocalFolder(skillsDir);
              const privatePath = `/e2e-background/agents/${row.id}/skills.zip`;
              this.assets.set(privatePath, zip.toBuffer());
              privateSkillsUrl = `${origin}${privatePath}`;
            }
          } else {
            const zip = new AdmZip();
            zip.addLocalFolder(dir);
            this.assets.set(assetPath, zip.toBuffer());
          }
          this.catalog[kind].push({
            id: row.id, name, version: row.version, published_at: row.published_at,
            updated_at: row.updated_at, create_uid: '0', status: 'approved', default_install: false,
            ...(kind === 'agents'
              ? { agent_json_url: `${origin}${assetPath}`, agent_skills_bundle_url: privateSkillsUrl }
              : { bundle_url: `${origin}${assetPath}` }),
          });
        }
      }
    }
    if (route === '/defaults') return { status: 200, body: { code: 0, agents: [], skills: [] } };
    const rows = route.startsWith('/agents/') ? this.catalog.agents : this.catalog.skills;
    if (route.endsWith('/list')) {
      const selected = rows.filter((row) => (!Array.isArray(body.ids) || body.ids.includes(row.id))
        && (typeof body.q !== 'string' || row.name.includes(body.q)));
      return { status: 200, body: { code: 0, list: selected, total: selected.length } };
    }
    const row = rows.find((item) => item.id === body.id);
    return row ? { status: 200, body: { code: 0, ...row } }
      : { status: 404, body: { code: 404, msg: 'e2e_catalog_item_not_found' } };
  }

  upload(bytes: Buffer, userId: string, contentType: string): Reply {
    try {
      if (userId !== this.userId || contentType !== 'application/octet-stream'
        || bytes.length < 29 || bytes[0] !== 1) throw new Error('invalid');
      const key = createHash('sha256').update('orkas-client-data-key-derivation-v1\0')
        .update('orkas:client-data:stable-upload-v1:2026-08').digest();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
      decipher.setAAD(Buffer.from(`orkas-client-data-v1\0${userId}`));
      decipher.setAuthTag(bytes.subarray(-16));
      const decoded = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(13, -16)), decipher.final()]).toString('utf8'));
      if (decoded.schema !== 1 || decoded.kind !== 'runtime-diagnostic-v1'
        || !decoded.payload || typeof decoded.payload !== 'object' || Array.isArray(decoded.payload)) throw new Error('invalid');
      this.uploads.push(decoded.payload);
      return { status: 200, body: { code: 0 } };
    } catch { return { status: 400, body: { code: 1, msg: 'invalid_payload', retryable: false } }; }
  }
}
