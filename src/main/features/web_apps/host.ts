/** Native adapters for the Web-only runtime. Never forwards arbitrary IPC. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { dialog } from 'electron';
import { getActiveUserId } from '../users';
import { registerUserSwitchHook } from '../user-switch-hooks';
import { getLanguage } from '../config';
import { hasConfiguredModel } from '../auth';
import { t } from '../../i18n';
import * as artifacts from '../chat_artifacts';
import * as saved from '../saved_apps';
import { AppError, WebAppRuntime, type AppTool, type Bundle } from './runtime';
import { MANIFEST_FILE } from './catalog';
import type { AgentTool } from '#core-agent';
import { appResource as scopedAppResource } from './resources';
import { cancelForApp, type AppUsageScope } from '../connectors/action_confirm';
import { bundleRevision } from './bundle-revision';

let dialogBusy = false;
async function nativeDialog<T>(run: () => Promise<T>): Promise<T> {
  if (dialogBusy) throw new AppError('E_BUSY');
  dialogBusy = true;
  try { return await run(); } finally { dialogBusy = false; }
}

export async function appTools(uid: string, appUsage?: AppUsageScope): Promise<AppTool[]> {
  const [{ createLibraryTool }, { createConnectorMetaTools }] = await Promise.all([
    import('../../model/core-agent/kb-tools'), import('../../model/core-agent/connector-meta-tools'),
  ]);
  const library = createLibraryTool({ userId: uid });
  const connectors = await createConnectorMetaTools({ userId: uid, appUsage, allowCustomConnectorInstall: false }, 'full');
  const wrap = (tool: AgentTool, capability: 'library' | 'connectors'): AppTool => ({
    name: tool.name, capability, description: tool.description, inputSchema: tool.inputSchema,
    async execute(args, signal) {
      if (signal.aborted || getActiveUserId() !== uid) throw new AppError('E_CLOSED');
      // Read-only Library scope is always global. App source provenance never grants a project.
      if (capability === 'library' && args.scope !== undefined && args.scope !== 'global') throw new AppError('E_INPUT');
      const context = { signal, state: {} };
      const result = await tool.execute(args, context);
      if (signal.aborted || getActiveUserId() !== uid) throw new AppError('E_CLOSED');
      // Model-context budgets belong to AgentRunner, not application data.
      // Project only public tool content; never expose backing paths or observations.
      return { content: result.content, ...(result.isError ? { isError: true } : {}) };
    },
  });
  return [wrap(library, 'library'), ...connectors.map(tool => wrap(tool, 'connectors'))];
}

export const runtime = new WebAppRuntime({
  // Orkas keeps Web apps local; the private cloud-sync dirty marker is
  // intentionally absent while the runtime still receives its change hook.
  storageChanged: () => {},
  activeUser: getActiveUserId,
  language: getLanguage,
  modelAvailable: () => hasConfiguredModel().configured,
  closed: cancelForApp,
  pick: () => nativeDialog(async () => {
    const r = await dialog.showOpenDialog({ title: t('web_apps.pick'), properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0] || null;
  }),
  save: name => nativeDialog(async () => {
    const r = await dialog.showSaveDialog({ title: t('web_apps.save'), defaultPath: name });
    return r.canceled ? null : r.filePath || null;
  }),
  generate: async (uid, args, signal, progress) => {
    const { generateWebAppText } = await import('../../model/core-agent/runner');
    return generateWebAppText(uid, args, signal, progress);
  },
  tools: appTools,
});
registerUserSwitchHook('web-apps', previousUid => runtime.closeUser(previousUid));

export type Source = { appId: string } | { cid: string; artifactId: string };
export async function resolveBundle(uid: string, source: Source): Promise<{ bundle: Bundle | null; url: string; entry: string }> {
  const isSaved = 'appId' in source;
  const resolve = (rel: string) => {
    const result = isSaved ? saved.resolveSavedAppFilePath(uid, source.appId, rel)
      : artifacts.resolveArtifactFilePath(uid, source.cid, source.artifactId, rel);
    return result.ok ? result : null;
  };
  const initial = resolve('');
  if (!initial) throw new AppError('E_BUNDLE');
  const entry = 'entry' in initial && typeof initial.entry === 'string' ? initial.entry : 'index.html';
  const base = isSaved ? `chat-app://saved/${encodeURIComponent(source.appId)}`
    : `chat-app://cid/${encodeURIComponent(source.cid)}/${encodeURIComponent(source.artifactId)}`;
  const url = base + '/' + entry.split('/').map(encodeURIComponent).join('/');
  const manifestFile = resolve(MANIFEST_FILE);
  if (!manifestFile) return { bundle: null, url, entry };
  const stat = fs.statSync(manifestFile.absPath);
  if (stat.size > 16 * 1024) throw new AppError('E_MANIFEST');
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile.absPath, 'utf8')); } catch { throw new AppError('E_MANIFEST'); }
  const key = crypto.createHash('sha256').update(JSON.stringify(isSaved ? ['saved', source.appId] : ['artifact', source.cid, source.artifactId])).digest('hex');
  let title = t('artifact.title');
  try {
    const metaFile = path.join(path.dirname(manifestFile.absPath), '__orkas-meta.json');
    if (fs.statSync(metaFile).size > 64 * 1024) throw new AppError('E_BUNDLE');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (typeof meta.title === 'string') title = meta.title.slice(0, 120);
  } catch { /* A missing legacy title uses the localized default. */ }
  let revision: Awaited<ReturnType<typeof bundleRevision>>;
  try { revision = await bundleRevision(path.dirname(manifestFile.absPath), [initial.absPath, manifestFile.absPath]); }
  catch { throw new AppError('E_BUNDLE'); }
  return { url, entry, bundle: { kind: isSaved ? 'saved' : 'artifact', key, title, entry, manifest, valid: () => revision.valid(),
    resolve: rel => { const file = resolve(rel); return file && revision.accept(file.absPath) ? file : null; } } };
}
export async function openApp(uid: string, owner: number, source: Source) {
  const found = await resolveBundle(uid, source);
  return found.bundle ? runtime.open(uid, owner, found.bundle) : { url: found.url, entry: found.entry };
}
export { sdkScript, APP_CSP } from './resources';
export function appResource(request: Request) { return scopedAppResource(request, runtime); }
export function safeFailure(err: unknown) {
  const code = err instanceof AppError ? err.code : (err as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'E_EXISTS' : 'E_FAILED';
  return { code, message: t(`web_apps.error_${code}`) };
}
