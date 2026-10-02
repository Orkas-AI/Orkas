'use strict';
// Same source/ASAR TypeScript bootstrap as the existing history worker.
require('tsx/cjs');
const { parentPort, workerData } = require('node:worker_threads');
const { parseOperatorPolicy, validateSkillFile, validateSkillDir, validateAgentSpec } = require('./index');
const { checkDirectoryBudget } = require('./operator-worker-budget');
try {
  const parsed = parseOperatorPolicy(workerData.policy);
  if (parsed.errors.length) {
    parentPort.postMessage({ error: 'config', errors: parsed.errors });
  } else {
    const request = workerData.request;
    let reports;
    if (request.kind === 'config') reports = [];
    else if (request.kind === 'files') reports = request.files.map(file => validateSkillFile({ ...file, operatorRules: parsed.rules }));
    else if (request.kind === 'agent') reports = [validateAgentSpec({ ...request.args, operatorRules: parsed.rules })];
    else {
      checkDirectoryBudget(request.dir);
      reports = [validateSkillDir(request.dir, { ...request.options, operatorRules: parsed.rules })];
    }
    if (reports.reduce((count, report) => count + report.violations.length, 0) > 512) {
      parentPort.postMessage({ error: 'size' });
    } else parentPort.postMessage({ reports, ruleCount: parsed.rules.length });
  }
} catch {
  parentPort.postMessage({ error: 'scan' });
}
