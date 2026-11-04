import * as fsp from 'node:fs/promises';
import { userConnectorsConfigFile } from '../../paths';
import { FileSnapshotCache } from '../../util/file-snapshot';
import { connectorRecordsForScope } from './device-local';

interface SearchName { id: string; display_name: string }
const snapshots = new FileSnapshotCache<SearchName[]>(
  rows => rows.reduce((bytes, row) => bytes + 128 + 2 * (row.id.length + row.display_name.length), 0), 8,
);

/** Custom names are plaintext account metadata. Reading names must neither
 * hydrate grants/transport nor run the manager's auth repair/migration path.
 * Custom connectors are cloud-scoped; device-local catalog CLI rows are not
 * custom entries, even before their legacy storage migration completes. */
export async function listCustomSearchNames(userId: string): Promise<readonly SearchName[]> {
  if (!userId) return [];
  const file = userConnectorsConfigFile(userId);
  return await snapshots.read(file, async () => {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      return Object.values(connectorRecordsForScope<Record<string, unknown>>(raw?.connections, false))
        .filter(row => row?.origin === 'custom' && typeof row.id === 'string' && typeof row.display_name === 'string')
        .map(row => ({ id: row.id as string, display_name: row.display_name as string }));
    } catch { return null; }
  }) || [];
}
