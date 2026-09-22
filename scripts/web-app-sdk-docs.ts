/** Both authoring references are generated from the executable API registry. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { catalogDocument } from '../src/main/features/web_apps/catalog';

const targets = [
  'resources/builtin/system/skills/web-app-sdk/references/api.json',
];
export function syncWebAppSdkDocs(root: string, check: boolean): void {
  const expected = JSON.stringify(catalogDocument(), null, 2) + '\n';
  for (const relative of targets) {
    const target = path.resolve(root, relative);
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== expected) {
        throw new Error(`Web SDK reference is stale: ${relative}. Run npm run web-app-sdk:docs.`);
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, expected);
    }
  }
}
if (require.main === module) {
  const check = process.argv.includes('--check');
  syncWebAppSdkDocs(path.resolve(__dirname, '..'), check);
  console.log(check ? 'Web SDK references match the executable registry.' : 'Updated both Web SDK references.');
}
