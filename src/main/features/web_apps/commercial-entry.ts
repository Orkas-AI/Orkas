import * as fs from 'node:fs';
import * as path from 'node:path';
import { metadataAppType, type AppType } from './data-contract';

const message = 'Publishing apps requires the commercial version of Orkas.';
export function commercialWebAppFailure() {
  return { ok: false as const, code: 'E_COMMERCIAL_REQUIRED' as const, feature: 'web_apps' as const, message, error: message };
}
export function isCommercialWebAppFailure(value: unknown): boolean {
  const receipt = value as { code?: unknown; feature?: unknown } | null;
  return receipt?.code === 'E_COMMERCIAL_REQUIRED' && receipt?.feature === 'web_apps';
}
/** Publication is unavailable before preparing, uploading or changing app state. */
export function publishApp() { return commercialWebAppFailure(); }
/** Missing metadata remains compatible with legacy local HTML. Damaged or
 * explicitly invalid authority must never become a local capability grant. */
export function storedAppType(dir: string): AppType | undefined {
  const file = path.join(dir, '__orkas-meta.json');
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Invalid app metadata');
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid app metadata');
  const type = metadataAppType(metadata.appType);
  if (Object.hasOwn(metadata, 'appType') && !type) throw new Error('Invalid app metadata');
  return type;
}
