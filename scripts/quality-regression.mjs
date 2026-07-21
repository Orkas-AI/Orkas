#!/usr/bin/env node
/**
 * Regression: run the quality validator over every locally-installed skill +
 * agent and report findings. Used during a Validator phase 0 / phase 1 PR
 * to confirm the rule set doesn't false-positive on official content.
 *
 * Usage: node scripts/quality-regression.mjs [--orkas-data <path>]
 *   default --orkas-data: ~/.orkas/data
 *
 * Exits 0 if every spec passes, 1 if any EXTREME violation is found.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_ROOT = (() => {
  const idx = process.argv.indexOf('--orkas-data');
  if (idx > 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return path.join(os.homedir(), '.orkas', 'data');
})();

if (!fs.existsSync(DATA_ROOT)) {
  console.error(`Data root not found: ${DATA_ROOT}`);
  process.exit(2);
}

// The validator is plain TS; import via tsx (the same loader the app uses).
process.env.ORKAS_WORKSPACE_ROOT = DATA_ROOT;
// We don't actually need the full module — just the validator entries.
// Use the tsx loader hook to import .ts source directly.
const tsxRegister = await import('tsx/esm/api');
tsxRegister.register();
const qualityUrl = pathToFileURL(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'main', 'quality', 'index.ts'),
).href;
const { validateSkillDir, validateAgentDir } = await import(qualityUrl);

let totalSkills = 0, totalAgents = 0, failed = 0;
const findings = [];

function* iterUserDirs() {
  for (const entry of fs.readdirSync(DATA_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'logs' || entry.name === 'user_workspaces') continue;
    if (entry.name.startsWith('.')) continue;
    yield path.join(DATA_ROOT, entry.name);
  }
}

function* iterSpecDirs(parent, what) {
  if (!fs.existsSync(parent)) return;
  for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    yield { id: e.name, dir: path.join(parent, e.name), source: what };
  }
}

for (const userDir of iterUserDirs()) {
  // Skill sources: cloud/skills (custom) + local/marketplace/skills (platform).
  for (const { id, dir, source } of [
    ...iterSpecDirs(path.join(userDir, 'cloud', 'skills'), 'custom-skill'),
    ...iterSpecDirs(path.join(userDir, 'local', 'marketplace', 'skills'), 'marketplace-skill'),
  ]) {
    totalSkills++;
    const r = validateSkillDir(dir, {
      // Marketplace installs are historical published bytes. The Runner
      // contract is enforced on custom authoring and republish, not install.
      enforceSkillRunner: source !== 'marketplace-skill',
    });
    const extreme = r.violations.filter((v) => v.level === 'EXTREME');
    const medium = r.violations.filter((v) => v.level === 'MEDIUM');
    if (extreme.length) {
      failed++;
      findings.push({ source, id, dir, extreme, medium });
      console.log(`✗ [${source}] ${id} — EXTREME × ${extreme.length}, MEDIUM × ${medium.length}`);
      for (const v of extreme) console.log(`    ${v.rule} @ ${v.field}: ${v.snippet.slice(0, 80)}`);
    } else if (medium.length) {
      console.log(`⚠ [${source}] ${id} — MEDIUM × ${medium.length}`);
    } else {
      console.log(`✓ [${source}] ${id}`);
    }
  }

  // Agent sources: cloud/agents (custom) + local/marketplace/agents (platform).
  for (const { id, dir, source } of [
    ...iterSpecDirs(path.join(userDir, 'cloud', 'agents'), 'custom-agent'),
    ...iterSpecDirs(path.join(userDir, 'local', 'marketplace', 'agents'), 'marketplace-agent'),
  ]) {
    totalAgents++;
    const r = validateAgentDir(dir, {
      enforceSkillRunner: source !== 'marketplace-agent',
    });
    const extreme = r.violations.filter((v) => v.level === 'EXTREME');
    const medium = r.violations.filter((v) => v.level === 'MEDIUM');
    if (extreme.length) {
      failed++;
      findings.push({ source, id, dir, extreme, medium });
      console.log(`✗ [${source}] ${id} — EXTREME × ${extreme.length}, MEDIUM × ${medium.length}`);
      for (const v of extreme) console.log(`    ${v.rule} @ ${v.field}: ${v.snippet.slice(0, 80)}`);
    } else if (medium.length) {
      console.log(`⚠ [${source}] ${id} — MEDIUM × ${medium.length}`);
    } else {
      console.log(`✓ [${source}] ${id}`);
    }
  }
}

console.log('');
console.log(`Scanned ${totalSkills} skills + ${totalAgents} agents from ${DATA_ROOT}`);
console.log(`Failed (EXTREME): ${failed}`);

process.exit(failed > 0 ? 1 : 0);
