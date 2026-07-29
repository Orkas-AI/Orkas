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
import { safeId, writeJson } from '../storage';
import { createLogger } from '../logger';

import { ValidationReport } from './types';

const log = createLogger('quality');
const reportWriteTails = new Map<string, Promise<void>>();
const pendingReportWrites = new Set<Promise<void>>();

export type SpecKind = 'skill' | 'agent';

function _reportFile(uid: string, kind: SpecKind, id: string): string {
  if (!safeId(uid)) throw new Error('invalid quality report user id');
  if (!safeId(id)) throw new Error('invalid quality report id');
  return kind === 'skill'
    ? qualitySkillReportFile(uid, id)
    : qualityAgentReportFile(uid, id);
}

function isValidationReport(value: unknown): value is ValidationReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Partial<ValidationReport>;
  if (
    typeof report.ok !== 'boolean'
    || typeof report.validated_at !== 'string'
    || typeof report.validator_version !== 'string'
    || !Array.isArray(report.violations)
  ) return false;
  const violationsValid = report.violations.every((violation) => (
    !!violation
    && typeof violation === 'object'
    && ['EXTREME', 'MEDIUM', 'LOW'].includes(violation.level)
    && typeof violation.rule === 'string'
    && typeof violation.field === 'string'
    && typeof violation.snippet === 'string'
    && typeof violation.suggested_fix === 'string'
  ));
  if (!violationsValid) return false;
  return report.ok === !report.violations.some((violation) => violation.level === 'EXTREME');
}

/**
 * Write the latest report for a spec. Best-effort: a write failure is logged
 * but does not throw — persistence is informational, not load-bearing.
 * Invalid account/spec identifiers are rejected before any write is queued.
 */
function enqueueReportMutation(file: string, mutation: () => Promise<void>): Promise<void> {
  const previous = reportWriteTails.get(file) || Promise.resolve();
  const run = previous.catch(() => undefined).then(mutation);
  let tracked!: Promise<void>;
  tracked = run.finally(() => {
    pendingReportWrites.delete(tracked);
    if (reportWriteTails.get(file) === tracked) reportWriteTails.delete(file);
  });
  reportWriteTails.set(file, tracked);
  pendingReportWrites.add(tracked);
  return tracked;
}

export async function persistReport(args: {
  uid: string;
  kind: SpecKind;
  id: string;
  report: ValidationReport;
}): Promise<void> {
  const file = _reportFile(args.uid, args.kind, args.id);
  return enqueueReportMutation(file, async () => {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await writeJson(file, args.report);
    } catch (err) {
      log.warn(`persist ${args.kind} report id=${args.id} failed: ${(err as Error).message}`);
    }
  });
}

/** Wait for fire-and-forget report writes to settle. Tests call this before
 * deleting a temporary workspace; shutdown paths may also use it when they
 * need report durability. */
export async function drainReportWrites(): Promise<void> {
  while (pendingReportWrites.size) {
    await Promise.all(Array.from(pendingReportWrites));
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
  await reportWriteTails.get(file)?.catch(() => undefined);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    if (!isValidationReport(parsed)) {
      log.warn(`read ${args.kind} report id=${args.id} ignored invalid payload`);
      return null;
    }
    return parsed;
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
  await enqueueReportMutation(file, async () => {
    try { await fsp.rm(file, { force: true }); }
    catch (err) {
      log.warn(`delete ${args.kind} report id=${args.id} failed: ${(err as Error).message}`);
    }
  });
}
