import { shell } from 'electron';
import { operatorPolicyStatus, setOperatorPolicyEnabled, prepareOperatorPolicyFile } from '../features/operator-policy';
/** Quality reports and device-local custom-validation settings. */

import { readReport } from '../quality/report';
import { getActiveUserId } from '../features/users';
import { safeId } from '../storage';

type InvokeHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export const invokeHandlers: Record<string, InvokeHandler> = {
  'quality.operatorStatus': async () => operatorPolicyStatus(getActiveUserId()),
  'quality.setOperatorEnabled': async ({ enabled }) => {
    if (typeof enabled !== 'boolean') throw new Error('invalid enabled');
    const uid = getActiveUserId();
    await setOperatorPolicyEnabled(uid, enabled);
    return operatorPolicyStatus(uid);
  },
  'quality.openOperatorFile': async () => {
    const file = await prepareOperatorPolicyFile(getActiveUserId());
    shell.showItemInFolder(file);
    return { ok: true };
  },
  'quality.readSkillReport': async ({ id }) => {
    if (typeof id !== 'string' || !safeId(id)) throw new Error('invalid id');
    const report = await readReport({ uid: getActiveUserId(), kind: 'skill', id });
    return { report };
  },

  'quality.readAgentReport': async ({ id }) => {
    if (typeof id !== 'string' || !safeId(id)) throw new Error('invalid id');
    const report = await readReport({ uid: getActiveUserId(), kind: 'agent', id });
    return { report };
  },
};
