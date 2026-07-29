#!/usr/bin/env node
/**
 * Run the deterministic quality validator over every locally installed Skill
 * and Agent. Official Marketplace bytes use their historical runner contract;
 * custom authoring keeps the current Skill Runner gate.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXCLUDED_DATA_DIRECTORIES = new Set(['logs', 'user_workspaces']);

export function parseQualityRegressionArgs(
  argv,
  { homeDirectory = os.homedir() } = {},
) {
  let dataRoot = path.join(homeDirectory, '.orkas', 'data');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--orkas-data') {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--orkas-data requires a path');
    }
    dataRoot = path.resolve(value);
    index += 1;
  }
  return { dataRoot };
}

export function qualityModuleUrl(scriptUrl = import.meta.url) {
  const scriptDirectory = path.dirname(fileURLToPath(scriptUrl));
  return pathToFileURL(
    path.resolve(scriptDirectory, '..', 'src', 'main', 'quality', 'index.ts'),
  ).href;
}

export function discoverUserDirectories(dataRoot, { fileSystem = fs } = {}) {
  return fileSystem.readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => (
      entry.isDirectory()
      && !EXCLUDED_DATA_DIRECTORIES.has(entry.name)
      && !entry.name.startsWith('.')
    ))
    .map((entry) => path.join(dataRoot, entry.name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export function discoverSpecDirectories(parent, source, { fileSystem = fs } = {}) {
  if (!fileSystem.existsSync(parent)) return [];
  return fileSystem.readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      dir: path.join(parent, entry.name),
      source,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

function reportCounts(report) {
  if (!report || !Array.isArray(report.violations)) {
    throw new Error('validator returned a malformed report');
  }
  return {
    extreme: report.violations.filter((violation) => violation?.level === 'EXTREME'),
    medium: report.violations.filter((violation) => violation?.level === 'MEDIUM'),
  };
}

export function runQualityRegression({
  dataRoot,
  fileSystem = fs,
  print = console.log,
  printError = console.error,
  validateAgentDir,
  validateSkillDir,
}) {
  if (!fileSystem.existsSync(dataRoot)) {
    printError(`Data root not found: ${dataRoot}`);
    return {
      code: 2,
      failed: 0,
      totalAgents: 0,
      totalSkills: 0,
    };
  }

  let totalSkills = 0;
  let totalAgents = 0;
  let failed = 0;

  const scan = ({ id, dir, source }, validate, kind) => {
    if (kind === 'skill') totalSkills += 1;
    else totalAgents += 1;
    try {
      const report = validate(dir, {
        enforceSkillRunner: !source.startsWith('marketplace-'),
      });
      const { extreme, medium } = reportCounts(report);
      if (extreme.length) {
        failed += 1;
        print(`✗ [${source}] ${id} — EXTREME × ${extreme.length}, MEDIUM × ${medium.length}`);
        for (const violation of extreme) {
          const rule = String(violation.rule || 'unknown_rule');
          const field = String(violation.field || 'unknown_field');
          const snippet = String(violation.snippet || '').slice(0, 80);
          print(`    ${rule} @ ${field}: ${snippet}`);
        }
      } else if (medium.length) {
        print(`⚠ [${source}] ${id} — MEDIUM × ${medium.length}`);
      } else {
        print(`✓ [${source}] ${id}`);
      }
    } catch {
      // One unreadable or internally broken spec must fail the run without
      // suppressing validation of every later Agent/Skill.
      failed += 1;
      print(`✗ [${source}] ${id} — validator_error`);
    }
  };

  let userDirectories;
  try {
    userDirectories = discoverUserDirectories(dataRoot, { fileSystem });
  } catch {
    printError(`Data root is unreadable: ${dataRoot}`);
    return {
      code: 2,
      failed: 0,
      totalAgents: 0,
      totalSkills: 0,
    };
  }

  for (const userDir of userDirectories) {
    const skillSources = [
      [path.join(userDir, 'cloud', 'skills'), 'custom-skill'],
      [path.join(userDir, 'local', 'marketplace', 'skills'), 'marketplace-skill'],
    ];
    const agentSources = [
      [path.join(userDir, 'cloud', 'agents'), 'custom-agent'],
      [path.join(userDir, 'local', 'marketplace', 'agents'), 'marketplace-agent'],
    ];

    for (const [parent, source] of skillSources) {
      let specs;
      try {
        specs = discoverSpecDirectories(parent, source, { fileSystem });
      } catch {
        failed += 1;
        print(`✗ [${source}] <inventory> — directory_error`);
        continue;
      }
      for (const spec of specs) scan(spec, validateSkillDir, 'skill');
    }
    for (const [parent, source] of agentSources) {
      let specs;
      try {
        specs = discoverSpecDirectories(parent, source, { fileSystem });
      } catch {
        failed += 1;
        print(`✗ [${source}] <inventory> — directory_error`);
        continue;
      }
      for (const spec of specs) scan(spec, validateAgentDir, 'agent');
    }
  }

  print('');
  print(`Scanned ${totalSkills} skills + ${totalAgents} agents from ${dataRoot}`);
  print(`Failed (EXTREME or validator error): ${failed}`);
  return {
    code: failed > 0 ? 1 : 0,
    failed,
    totalAgents,
    totalSkills,
  };
}

async function main() {
  let options;
  try {
    options = parseQualityRegressionArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`quality-regression: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  process.env.ORKAS_WORKSPACE_ROOT = options.dataRoot;
  const tsxRegister = await import('tsx/esm/api');
  tsxRegister.register();
  const { validateSkillDir, validateAgentDir } = await import(qualityModuleUrl());
  const result = runQualityRegression({
    ...options,
    validateAgentDir,
    validateSkillDir,
  });
  process.exitCode = result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`quality-regression: ${err.message}`);
    process.exitCode = 2;
  });
}
