import { rmSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/orkas';

test.describe('recycle-bin recovery', () => {
  test('a corrupt snapshot reports failure without recreating an empty project', async ({ orkas }) => {
    const created = await orkas.invoke<{
      project: { project_id: string };
    }>('projects.create', { name: 'E2E Corrupt Recovery Project' });
    const projectId = created.project.project_id;
    await orkas.invoke('projects.delete', { projectId });

    const listed = await orkas.invoke<{
      batches: Array<{ id: string; items: Array<{ path: string }> }>;
    }>('recycle.list');
    const batch = listed.batches.find((item) => (
      item.items.some((entry) => entry.path === `cloud/projects/${projectId}/project.json`)
    ));
    if (!batch) throw new Error('project recycle batch was not created');

    for (const item of batch.items) {
      rmSync(path.join(
        orkas.workspaceRoot,
        'account-e2e',
        'local',
        'recycle',
        batch.id,
        'files',
        ...item.path.slice('cloud/'.length).split('/'),
      ), { recursive: true, force: true });
    }

    const restored = await orkas.invoke<{
      ok: boolean;
      restored: number;
      failed_paths: string[];
      reactivated_paths: string[];
    }>('recycle.restore', { id: batch.id });
    expect(restored.ok).toBe(true);
    expect(restored.restored).toBe(0);
    expect(restored.failed_paths.sort()).toEqual(batch.items.map((item) => item.path).sort());
    expect(restored.reactivated_paths).toEqual([]);

    const projects = await orkas.invoke<{
      projects: Array<{ project_id: string }>;
    }>('projects.list');
    expect(projects.projects).not.toContainEqual(expect.objectContaining({ project_id: projectId }));
  });
});
