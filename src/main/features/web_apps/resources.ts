/** Shared resource contract for installed apps and isolated HTML previews. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SRC_ROOT } from '../../paths';
import * as artifacts from '../chat_artifacts';
import { METHODS, SDK_PATH, catalogDocument } from './catalog';
import { webContentCsp } from '../../util/web-content-policy';
import type { WebAppRuntime } from './runtime';

let sdk: string | null = null;
export function sdkScript() {
  if (!sdk) sdk = fs.readFileSync(path.join(SRC_ROOT, 'main/features/web_apps/sdk.js'), 'utf8')
    .replace('/* HOST_METHOD_NAMES */ []', JSON.stringify(Object.keys(METHODS)));
  return sdk;
}
export const APP_CSP = webContentCsp();
export function appResource(request: Request, runtime: WebAppRuntime) {
  const url = new URL(request.url);
  if (!/^app-[a-f0-9]{32}$/.test(url.host)) return null;
  let rel: string;
  try { rel = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/'); } catch { return { status: 400 }; }
  const scoped = runtime.resource(url.host, rel, request.headers.get('Origin'));
  if (!scoped) return { status: 403 };
  const headers = { 'Content-Security-Policy': APP_CSP, 'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' };
  if (rel === SDK_PATH) return { status: 200, body: sdkScript(), mime: 'text/javascript; charset=utf-8', headers };
  if (rel === artifacts.BRIDGE_RELPATH) return { status: 200, body: artifacts.BRIDGE_JS, mime: 'text/javascript; charset=utf-8', headers };
  if (rel === '__orkas/capabilities.json') return { status: 200, body: JSON.stringify(catalogDocument()), mime: 'application/json', headers };
  if (!scoped.resolved) return { status: 404 };
  return { status: 200, file: scoped.resolved.absPath, mime: scoped.resolved.mime, headers,
    source: scoped.bundle.kind === 'artifact' ? 'chat_app_artifact' as const : 'chat_app_saved' as const };
}
