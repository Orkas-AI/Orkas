/** User/device-local opt-in policy. No model/tool API and no cloud sync. */
import * as fs from 'node:fs/promises';
import { userLocalConfigDir, userOperatorPolicyFile as policyFile, userOperatorPolicyEnabledFile as enabledFile } from '../paths';
import { writeJson } from '../storage';
import { t } from '../i18n';
import {
  runOperatorPolicy, validateSkillFile, validateSkillDir, validateAgentSpec,
  VALIDATOR_VERSION, type PolicyRequest, type ValidationReport,
} from '../quality';

async function readBounded(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error('policy size');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
async function isEnabled(uid: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readBounded(enabledFile(uid)));
    if (typeof value.enabled !== 'boolean') throw new Error('policy setting');
    return value.enabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function incomplete(): ValidationReport {
  return { ok: false, validator_version: VALIDATOR_VERSION, validated_at: new Date().toISOString(), violations: [{
    rule: 'operator:incomplete', level: 'EXTREME', source: 'operator-policy', field: '', snippet: '',
    suggested_fix: t('quality.operator.incomplete'),
  }] };
}
export function hasBlockingOperatorPolicy(report: ValidationReport): boolean {
  return report.violations.some(v => v.source === 'operator-policy' && v.level === 'EXTREME');
}
export async function validateWithOperatorPolicy(uid: string, request: Exclude<PolicyRequest, { kind: 'config' }>): Promise<ValidationReport[]> {
  try {
    const enabled = await isEnabled(uid);
    if (!enabled) {
      if (request.kind === 'files') return request.files.map(validateSkillFile);
      if (request.kind === 'agent') return [validateAgentSpec(request.args)];
      return [validateSkillDir(request.dir, request.options)];
    }
    const result = await runOperatorPolicy(await readBounded(policyFile(uid)), request);
    if (!('reports' in result)) return [incomplete()];
    return result.reports;
  } catch { return [incomplete()]; }
}
export async function operatorPolicyStatus(uid: string): Promise<{ enabled: boolean; state: string; ruleCount: number }> {
  try {
    if (!(await isEnabled(uid))) return { enabled: false, state: 'disabled', ruleCount: 0 };
    const result = await runOperatorPolicy(await readBounded(policyFile(uid)), { kind: 'config' });
    return !('reports' in result) ? { enabled: true, state: 'invalid', ruleCount: 0 }
      : { enabled: true, state: 'ready', ruleCount: result.ruleCount };
  } catch { return { enabled: true, state: 'invalid', ruleCount: 0 }; }
}
export async function setOperatorPolicyEnabled(uid: string, enabled: boolean): Promise<void> {
  // Disabling must work even when the policy is missing or malformed.
  await writeJson(enabledFile(uid), { enabled });
}
export async function prepareOperatorPolicyFile(uid: string): Promise<string> {
  await fs.mkdir(userLocalConfigDir(uid), { recursive: true });
  try { await fs.writeFile(policyFile(uid), JSON.stringify({ version: 1, rules: [] }, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return policyFile(uid);
}
