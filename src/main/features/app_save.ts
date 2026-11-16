/** Account/conversation-bound application saving; publication is a separate operation. */
import * as path from 'node:path';
import { safeId } from '../storage';
import { isPathAllowed } from '../util/path-sandbox';
import * as artifacts from './chat_artifacts';
import * as saved from './saved_apps';

export interface AppSaveScope {
  userId: string;
  cid: string;
  workspace: string;
  roots: string[];
  isActive: () => boolean;
}

const messages: Record<string, string> = {
  app_save_input: 'Choose exactly one current-conversation artifact_id or workspace path, and a supported action and mode.',
  app_save_closed: 'This application save is no longer active.',
  app_save_source: 'The application source is unavailable in this task. Use an existing app artifact or a dedicated application folder in this workspace.',
  app_edit_target_missing: 'The source has no available saved destination. An update cannot create a new application.',
  app_edit_conflict: 'The saved application or its source binding changed. Inspect the destination again before updating.',
  app_save_inspection_required: 'Updating requires the app_id and expected_revision returned by inspection.',
  app_save_binding_unavailable: 'The saved destination cannot be resolved. Restore its source binding or explicitly save a new copy.',
  app_edit_data_migration: 'The update is incompatible with existing data. Use the source task save action to review export and recovery options.',
  app_save_failed: 'The application could not be saved. Its existing saved version is retained.',
};
function failure(code: string) {
  const known = Object.hasOwn(messages, code) ? code : 'app_save_failed';
  return { ok: false as const, status: 'blocked' as const, code: known, message: messages[known] };
}

export async function saveApplication(scope: AppSaveScope, input: Record<string, unknown>) {
  const active = () => scope.isActive();
  if (!active()) return failure('app_save_closed');
  const action = input.action ?? 'save';
  const artifact = input.artifact_id;
  const file = input.path;
  if (!safeId(scope.userId) || !safeId(scope.cid)
    || !['inspect', 'save'].includes(action as string)
    || (artifact === undefined) === (file === undefined)
    || (artifact !== undefined && (typeof artifact !== 'string' || !safeId(artifact)))
    || (file !== undefined && (typeof file !== 'string' || !file.trim() || file.includes('\0'))))
    return failure('app_save_input');
  const mode = input.mode ?? 'auto';
  if (action === 'save' && (!['auto', 'new', 'update'].includes(mode as string)
    || (mode === 'new' && (input.app_id !== undefined || input.expected_revision !== undefined))))
    return failure('app_save_input');
  try {
    let source: { artifactId: string } | { rootDir: string };
    let targetPath: string | undefined;
    if (typeof artifact === 'string') {
      if (!artifacts.resolveArtifactDir(scope.userId, scope.cid, artifact).ok) return failure('app_save_source');
      source = { artifactId: artifact };
    } else {
      targetPath = path.resolve(scope.workspace, file as string);
      if (!scope.roots.length || !isPathAllowed(targetPath, scope.roots)) return failure('app_save_source');
      const inspected = await saved.inspectBundleFromPath(targetPath, { fenceRoots: scope.roots });
      if (!inspected.ok || !inspected.canSave) return failure('app_save_source');
      source = { rootDir: inspected.rootDir };
    }
    if (!active()) return failure('app_save_closed');
    // An explicit copy does not depend on the source's saved destination.
    const target = action === 'save' && mode === 'new' ? null
      : await saved.getSaveTarget(scope.userId, scope.cid, source, { requireExisting: true });
    if (!active()) return failure('app_save_closed');
    if (action === 'inspect' || (target && (input.app_id === undefined || input.expected_revision === undefined))) {
      const inspected = target ? await saved.inspectSaveTarget(scope.userId, scope.cid, source) : null;
      if (!active()) return failure('app_save_closed');
      const destination = inspected ? { app_id: inspected.appId, title: inspected.title.slice(0, 160), revision: inspected.revision } : null;
      return action === 'inspect' ? { ok: true as const, status: 'ready' as const, target: destination }
        : { ...failure('app_save_inspection_required'), target: destination };
    }
    if (mode === 'update' && !target) return failure('app_edit_target_missing');
    if (target ? input.app_id !== target.appId || typeof input.expected_revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_revision)
      : input.app_id !== undefined || input.expected_revision !== undefined) return failure('app_edit_conflict');
    const guard: saved.SaveGuard = { isActive: active, target: target ? { appId: target.appId, revision: input.expected_revision as string } : null };
    const result = typeof artifact === 'string'
      ? await saved.saveFromArtifact(scope.userId, scope.cid, artifact, mode as 'auto' | 'new' | 'update', undefined, undefined, guard)
      : await saved.saveFromPath(scope.userId, targetPath!, { sourceCid: scope.cid,
        mode: mode as 'auto' | 'new' | 'update', fenceRoots: scope.roots, guard });
    if (result.ok === false) return failure(result.error);
    // A completed durable write stays successful even if its task stops afterward.
    return { ok: true as const, status: 'saved' as const, action: target ? 'updated' as const : 'created' as const,
      app: { id: result.id, title: result.title.slice(0, 160) },
      navigation: { surface_id: 'apps' as const, action: 'configure' as const, target_id: result.id } };
  } catch (error) {
    return failure(active() ? (error as Error)?.message : 'app_save_closed');
  }
}
