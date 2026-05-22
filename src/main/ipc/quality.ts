/**
 * IPC handlers for the quality validator.
 *
 * Renderer reads persisted ValidationReports to display the violation list
 * when a write / install rejection happens. The validator runs in-process at
 * the chokepoints (see `features/skills.ts` + `features/agents.ts` +
 * `features/marketplace.ts`); these channels are read-only — never run the
 * validator on demand from the renderer.
 *
 * Logical channels:
 *   - `quality.readSkillReport`  → latest report for a skill id
 *   - `quality.readAgentReport`  → latest report for an agent id
 */

import { readReport } from '../quality/report';
import { getActiveUserId } from '../features/users';

type InvokeHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export const invokeHandlers: Record<string, InvokeHandler> = {
  'quality.readSkillReport': async ({ id }) => {
    if (typeof id !== 'string' || !id) throw new Error('id required');
    const report = await readReport({ uid: getActiveUserId(), kind: 'skill', id });
    return { report };
  },

  'quality.readAgentReport': async ({ id }) => {
    if (typeof id !== 'string' || !id) throw new Error('id required');
    const report = await readReport({ uid: getActiveUserId(), kind: 'agent', id });
    return { report };
  },
};
