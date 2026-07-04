'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PLAN_PATH = 'project/plan.json';
const OPS = new Set(['validate', 'summarize', 'promise_check', 'rank_takes']);
const { validateEdl, summarizeEdl, assessDelivery } = require('./lib/video_edl_core.cjs');
const { rankTakes } = require('./lib/video_decide_core.cjs');

function fail(code, message, extra = {}) {
  process.stderr.write(JSON.stringify({ ok: false, code, message, ...extra }) + '\n');
  process.exit(1);
}

function parseArgs(args) {
  const out = { op: '', planPath: DEFAULT_PLAN_PATH, takesPath: '', probeProduced: false };
  const nextValue = (i, name) => {
    if (i + 1 >= args.length) fail('E_ARGS', `${name} requires a value`);
    return args[i + 1];
  };

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--op' || a === '-o') {
      out.op = nextValue(i, a);
      i += 1;
    } else if (a.startsWith('--op=')) {
      out.op = a.slice('--op='.length);
    } else if (a === '--plan' || a === '--plan-path' || a === '-p') {
      out.planPath = nextValue(i, a);
      i += 1;
    } else if (a.startsWith('--plan=')) {
      out.planPath = a.slice('--plan='.length);
    } else if (a.startsWith('--plan-path=')) {
      out.planPath = a.slice('--plan-path='.length);
    } else if (a === '--takes' || a === '--takes-path' || a === '-t') {
      out.takesPath = nextValue(i, a);
      i += 1;
    } else if (a.startsWith('--takes=')) {
      out.takesPath = a.slice('--takes='.length);
    } else if (a.startsWith('--takes-path=')) {
      out.takesPath = a.slice('--takes-path='.length);
    } else if (a === '--probe-produced') {
      out.probeProduced = true;
    } else if (!out.op) {
      out.op = a;
    } else if (out.op === 'rank_takes' && !out.takesPath) {
      out.takesPath = a;
    } else if (out.planPath === DEFAULT_PLAN_PATH) {
      out.planPath = a;
    } else {
      fail('E_ARGS', `unexpected argument: ${a}`);
    }
  }

  out.op = String(out.op || '').trim();
  if (!OPS.has(out.op)) {
    fail('E_ARGS', `op must be one of: ${[...OPS].join(', ')}`);
  }
  return out;
}

function resolvePath(raw) {
  const p = String(raw || '').trim();
  if (!p) fail('E_ARGS', 'path is required');
  return path.resolve(process.cwd(), p);
}

function readJson(rawPath, label) {
  const abs = resolvePath(rawPath);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    fail('E_READ', `could not read ${label}: ${err.message}`, { path: abs });
  }
  try {
    return { path: abs, value: JSON.parse(text) };
  } catch (err) {
    fail('E_PARSE', `${label} is not valid JSON: ${err.message}`, { path: abs });
  }
}

function fmtIssues(issues) {
  return issues.map((x) => `  - [${x.code}] ${x.path}: ${x.message}`).join('\n');
}

function normalizeTakes(raw) {
  if (!Array.isArray(raw)) fail('E_TAKES', 'rank_takes input must be a JSON array');
  return raw.map((t, i) => {
    const obj = t && typeof t === 'object' && !Array.isArray(t) ? t : {};
    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `take_${i + 1}`;
    return {
      id,
      text: typeof obj.text === 'string' ? obj.text : undefined,
      quality_score: typeof obj.quality_score === 'number' ? obj.quality_score : undefined,
      duration_sec: typeof obj.duration_sec === 'number' ? obj.duration_sec : undefined,
    };
  });
}

function loadProbeMediaDurationSec() {
  try {
    return require('../../stage-edit/scripts/lib/video_edit_core.cjs').probeMediaDurationSec;
  } catch (err) {
    fail('E_PRODUCED_PROBE_UNAVAILABLE', `could not load media probe helper: ${err.message}`);
  }
}

function resolveProducedPath(rawPath, planPath) {
  const raw = String(rawPath || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;
  const cwdPath = path.resolve(process.cwd(), raw);
  if (fs.existsSync(cwdPath)) return cwdPath;
  const planRelative = path.resolve(path.dirname(planPath), raw);
  if (fs.existsSync(planRelative)) return planRelative;
  return cwdPath;
}

async function collectProducedSec(plan, planPath) {
  const segments = Array.isArray(plan?.segments) ? plan.segments : [];
  const primary = segments.filter((s) => s && typeof s === 'object' && s.layer === 'primary');
  if (!primary.length) {
    fail('E_PRODUCED_SEGMENTS', 'plan has no primary segments to probe', { plan_path: planPath });
  }

  const probeMediaDurationSec = loadProbeMediaDurationSec();
  const producedSec = {};
  const producedPaths = {};

  for (const segment of primary) {
    const id = String(segment.id || '').trim();
    if (!id) {
      fail('E_PRODUCED_SEGMENT_ID', 'primary segment is missing id', { plan_path: planPath });
    }
    const producedPath = resolveProducedPath(segment.produced_path, planPath);
    if (!producedPath) {
      fail('E_PRODUCED_PATH_MISSING', `primary segment ${id} has no produced_path; cannot gate-D check the real cut`, {
        plan_path: planPath,
        segment_id: id,
      });
    }
    if (!fs.existsSync(producedPath)) {
      fail('E_PRODUCED_PATH_MISSING', `primary segment ${id} produced_path is not a file: ${producedPath}`, {
        plan_path: planPath,
        segment_id: id,
        produced_path: producedPath,
      });
    }
    const duration = await probeMediaDurationSec(producedPath);
    if (!(typeof duration === 'number' && Number.isFinite(duration) && duration > 0)) {
      fail('E_PRODUCED_PROBE_FAILED', `could not probe duration for primary segment ${id}: ${producedPath}`, {
        plan_path: planPath,
        segment_id: id,
        produced_path: producedPath,
      });
    }
    producedSec[id] = duration;
    producedPaths[id] = producedPath;
  }

  return { producedSec, producedPaths };
}

module.exports = async function videoPlan({ args }) {
  const opts = parseArgs(args || []);

  if (opts.op === 'rank_takes') {
    if (!opts.takesPath) fail('E_ARGS', 'rank_takes requires --takes <takes.json>');
    const { path: takesPath, value } = readJson(opts.takesPath, 'takes');
    const takes = normalizeTakes(value);
    const ranking = rankTakes(takes);
    const text = ranking.clusters
      .map((c, i) => (
        c.take_ids.length > 1
          ? `${i + 1}. repeats [${c.take_ids.join(', ')}] -> KEEP ${c.best_id} (${c.reason}); drop the rest.`
          : `${i + 1}. ${c.best_id} - ${c.reason}.`
      ))
      .join('\n');
    return { ok: true, op: opts.op, takes_path: takesPath, clusters: ranking.clusters, text };
  }

  const { path: planPath, value: plan } = readJson(opts.planPath, 'plan');
  const result = validateEdl(plan);

  if (opts.op === 'validate') {
    const valid = result.ok;
    const text = [
      valid
        ? `plan VALID${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}.`
        : `plan INVALID: ${result.errors.length} error(s) must be fixed before gate B.`,
      result.errors.length ? `Errors:\n${fmtIssues(result.errors)}` : '',
      result.warnings.length ? `Warnings:\n${fmtIssues(result.warnings)}` : '',
    ].filter(Boolean).join('\n');
    const payload = { ok: valid, op: opts.op, plan_path: planPath, valid, errors: result.errors, warnings: result.warnings, text };
    if (!valid) {
      process.stderr.write(JSON.stringify(payload) + '\n');
      process.exit(1);
    }
    return payload;
  }

  if (!result.ok) {
    fail('E_PLAN_INVALID', `plan has ${result.errors.length} error(s); run --op validate and fix them first`, {
      plan_path: planPath,
      errors: result.errors,
      warnings: result.warnings,
    });
  }

  if (opts.op === 'promise_check') {
    const produced = opts.probeProduced ? await collectProducedSec(plan, planPath) : null;
    const assessment = assessDelivery(plan, produced ? { producedSec: produced.producedSec } : {});
    const text = `promise_check: ${assessment.verdict.toUpperCase()} - motion ${Math.round(assessment.motion_ratio * 100)}% of ${assessment.total_primary_sec}s primary`
      + (assessment.motion_min_ratio > 0 ? ` (floor ${Math.round(assessment.motion_min_ratio * 100)}%)` : '')
      + (assessment.source_required ? `, source ${assessment.source_present ? 'present' : 'MISSING'}` : '')
      + (produced ? ', using produced_path durations' : ', using planned target_sec durations')
      + '.'
      + (assessment.issues.length ? `\nIssues:\n${assessment.issues.map((x) => `  - ${x}`).join('\n')}` : '')
      + (assessment.verdict === 'fail' ? '\nDo NOT deliver - re-plan or re-assemble to honor the promise.' : '');
    const payload = {
      ok: assessment.verdict !== 'fail',
      op: opts.op,
      plan_path: planPath,
      assessment,
      ...(produced ? { produced_sec: produced.producedSec, produced_paths: produced.producedPaths } : {}),
      text,
    };
    if (assessment.verdict === 'fail') {
      process.stderr.write(JSON.stringify(payload) + '\n');
      process.exit(1);
    }
    return payload;
  }

  const summary = summarizeEdl(plan);
  const warnNote = result.warnings.length ? `\n\nWarnings:\n${fmtIssues(result.warnings)}` : '';
  return {
    ok: true,
    op: opts.op,
    plan_path: planPath,
    summary,
    warnings: result.warnings,
    text: `Gate B - plan summary (present this to the user in their language):\n${summary}${warnNote}`,
  };
};
