/** Account-bound application discovery. Navigation uses the existing saved-app resolver. */
import { safeId } from '../storage';
import { isBuiltinAppId, listBuiltinApps, syncBuiltinApps } from './builtin_apps';
import { listSavedApps, resolveSavedAppIndex } from './saved_apps';

export interface AppCatalogLifetime {
  isActive: () => boolean;
  signal?: AbortSignal;
}

function failure(code: string, error: string) { return { ok: false as const, code, error }; }

export async function listAppCatalog(userId: string, input: Record<string, unknown>, lifetime: AppCatalogLifetime) {
  const source = input.source === undefined ? 'all' : input.source;
  const limit = input.limit === undefined ? 20 : input.limit;
  const offset = input.offset === undefined ? 0 : input.offset;
  if (!safeId(userId) || Object.keys(input).some(key => !['source', 'limit', 'offset'].includes(key))
    || !['all', 'builtin', 'custom'].includes(source as string)
    || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50
    || !Number.isSafeInteger(offset) || (offset as number) < 0) {
    return failure('E_APP_CATALOG_INPUT', 'Use source all, builtin, or custom; limit must be an integer from 1 to 50 and offset a non-negative safe integer. Account and project selectors are not supported.');
  }
  const active = () => !lifetime.signal?.aborted && lifetime.isActive();
  const closed = () => failure('E_CLOSED', 'This application lookup is no longer active.');
  if (!active()) return closed();
  let refresh: 'ready' | 'deferred' = 'ready';
  try {
    if (source !== 'custom') {
      try {
        const result = await syncBuiltinApps(userId, active);
        if (result.deferred) refresh = 'deferred';
      } catch { refresh = 'deferred'; }
    }
    if (!active()) return closed();
    const builtin = source === 'custom' ? [] : listBuiltinApps(userId);
    // Reserved identities always belong to the built-in resolver, even if a
    // malformed saved directory happens to use that identity.
    const custom = source === 'builtin' ? [] : listSavedApps(userId).filter(row => !isBuiltinAppId(row.id));
    const rows = [
      ...builtin.map(row => ({ ...row, source: 'builtin' as const })),
      ...custom.map(row => ({ ...row, source: 'custom' as const })),
    ].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const start = offset as number;
    const page = rows.slice(start, start + (limit as number));
    const apps = page.map(row => {
      const available = resolveSavedAppIndex(userId, row.id).ok;
      const title = row.title.slice(0, 160);
      const description = typeof row.description === 'string' ? row.description.slice(0, 240) : '';
      const truncated = [
        ...(title !== row.title ? ['title'] : []),
        ...(typeof row.description === 'string' && description !== row.description ? ['description'] : []),
      ];
      return {
        id: row.id, title, description, source: row.source, app_type: row.appType || 'local', available,
        navigation: available ? { surface_id: 'apps' as const, action: 'configure' as const, target_id: row.id } : null,
        ...(truncated.length ? { truncated_fields: truncated } : {}),
      };
    });
    if (!active()) return closed();
    return {
      ok: true as const, apps, total: rows.length, offset: start, limit: limit as number,
      next_offset: start + apps.length < rows.length ? start + apps.length : null,
      ...(source !== 'custom' ? { builtin_refresh: refresh } : {}),
    };
  } catch {
    if (!active()) return closed();
    return failure('E_APP_CATALOG_UNAVAILABLE', 'Could not read the application list. Try again or open Apps from the sidebar.');
  }
}
