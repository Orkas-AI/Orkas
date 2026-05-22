/**
 * Quality validator — report persistence.
 *
 * Local-only (per `PC/CLAUDE.md` §4): reports live under
 * `<uid>/local/quality_reports/{skills,agents}/<id>.json`. Only the latest
 * report per spec is retained — no history.
 *
 * This module is the SOLE writer/reader of those files. Callers must use
 * `persistReport()` / `readReport()` — never touch the JSON directly.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { qualitySkillReportFile, qualityAgentReportFile } from '../paths';
import { writeJson, readJson } from '../storage';
import { createLogger } from '../logger';

import { ValidationReport } from './types';

const log = createLogger('quality');

export type SpecKind = 'skill' | 'agent';

function _reportFile(uid: string, kind: SpecKind, id: string): string {
  return kind === 'skill'
    ? qualitySkillReportFile(uid, id)
    : qualityAgentReportFile(uid, id);
}

/**
 * Write the latest report for a spec. Best-effort: a write failure is logged
 * but does not throw — persistence is informational, not load-bearing.
 */
export async function persistReport(args: {
  uid: string;
  kind: SpecKind;
  id: string;
  report: ValidationReport;
}): Promise<void> {
  const file = _reportFile(args.uid, args.kind, args.id);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await writeJson(file, args.report);
  } catch (err) {
    log.warn(`persist ${args.kind} report id=${args.id} failed: ${(err as Error).message}`);
  }
}

/**
 * Read the latest report for a spec; returns null if none persisted.
 */
export async function readReport(args: {
  uid: string;
  kind: SpecKind;
  id: string;
}): Promise<ValidationReport | null> {
  const file = _reportFile(args.uid, args.kind, args.id);
  if (!fs.existsSync(file)) return null;
  try {
    return await readJson<ValidationReport>(file);
  } catch (err) {
    log.warn(`read ${args.kind} report id=${args.id} failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Drop the persisted report. Called when the spec is deleted.
 */
export async function deleteReport(args: {
  uid: string;
  kind: SpecKind;
  id: string;
}): Promise<void> {
  const file = _reportFile(args.uid, args.kind, args.id);
  try { await fsp.rm(file, { force: true }); }
  catch (err) {
    log.warn(`delete ${args.kind} report id=${args.id} failed: ${(err as Error).message}`);
  }
}
