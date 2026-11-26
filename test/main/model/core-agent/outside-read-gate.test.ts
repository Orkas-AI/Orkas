import { expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/util/path-sandbox', () => ({
  isPathAllowed: () => false,
  resolveSandboxRoot: () => '/material/target',
}));
vi.mock('../../../../src/main/features/permissions', () => ({
  localAccessAllowsOutsideWorkspace: () => true,
  localAccessRequiresSensitiveApproval: () => true,
}));
vi.mock('../../../../src/main/features/local_access_policy', () => ({
  sensitivePathReasons: (name: string) => name === '/material/target' ? ['sensitive_path'] : [],
  locationOnlyRead: () => undefined,
}));
vi.mock('../../../../src/main/model/core-agent/bash-permissions', () => ({
  requestBashDecision: vi.fn().mockResolvedValue('deny'),
}));

import { gateOutsideRead } from '../../../../src/main/model/core-agent/outside-read-gate';
import { requestBashDecision } from '../../../../src/main/model/core-agent/bash-permissions';

it('uses the sensitivity of the resolved outside file for the approval decision', async () => {
  const result = await gateOutsideRead({
    userId: 'review-user', operation: 'office_read', abs: '/material/selection', roots: ['/workspace'],
  });
  expect(requestBashDecision).toHaveBeenCalledWith(expect.objectContaining({
    subject: '/material/target', reasons: ['sensitive_path'],
  }));
  expect(result).toMatchObject({ ok: false, code: 'E_SENSITIVE_PATH_DENIED' });
});
