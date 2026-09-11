#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const PROMPT_PATH_PATTERNS = [
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)SKILL\.md$/,
  /(^|\/)skills\/[^/]+\/references\/.*\.md$/,
  /(^|\/)agents\/[^/]+\/agent\.json$/,
  /(^|\/)prompts\/.*\.(?:md|ts|js)$/,
  /(^|\/)docs\/architecture\/(?:system-prompt-engineering-contract|core-agent-runtime-engineering-contract|core-agent-tool-contract-policy)\.md$/,
  /(^|\/)(?:Common\/)?docs\/reviews\/REVIEW_PROCESS\.md$/,
];

const SYSTEM_PROMPT_PATH_PATTERN = /^PC\/(?:src\/main\/prompts\/.*\.(?:md|ts|js)|resources\/builtin\/system\/skills\/.*\.md)$/;

const SYSTEM_PROMPT_PRODUCER_PATHS = new Set([
  'PC/src/main/features/group_chat/bus.ts',
  'PC/src/main/features/agents.ts',
  'PC/src/main/features/skills.ts',
  'PC/src/main/features/local_agents/context.ts',
  'PC/src/main/model/core-agent/runner.ts',
  'PC/src/core-agent/src/agent/runner.ts',
  'PC/src/core-agent/src/agent/repository-instructions.ts',
]);

const SYSTEM_PROMPT_DIFF_SIGNAL = /system.?prompt|prompts?\.load|composeChatPrompt|languageDirective|runtime.?injection|turnEphemeral|durableInstructions|repositoryInstructions|buildSkillsGuidance/i;
const CHECKER_PATH = 'PC/scripts/check-prompt-commit-metadata.cjs';

function isPromptFacingPath(file) {
  return PROMPT_PATH_PATTERNS.some((pattern) => pattern.test(file));
}

function isSystemPromptSourcePath(file) {
  return SYSTEM_PROMPT_PATH_PATTERN.test(file);
}

function isSystemPromptProducerChange(file, diff) {
  if (!SYSTEM_PROMPT_PRODUCER_PATHS.has(file)) return false;
  const changedLines = diff.split('\n').filter(
    (line) => (/^[+-]/.test(line) && !/^\+\+\+|^---/.test(line)),
  );
  return SYSTEM_PROMPT_DIFF_SIGNAL.test(changedLines.join('\n'));
}

function findSystemPromptProducerFiles(files, readDiff) {
  return files
    .filter((file) => SYSTEM_PROMPT_PRODUCER_PATHS.has(file))
    .filter((file) => isSystemPromptProducerChange(file, readDiff(file)));
}

function validateCommitMetadata(message, files, producerFiles = []) {
  const promptFiles = [...new Set([
    ...files.filter(isPromptFacingPath),
    ...producerFiles,
  ])];
  if (!promptFiles.length) return [];

  const problems = [];
  if (!/^Prompt audit:/m.test(message)
    || !/(^|\s)(Keep|Drop):/.test(message)
    || !/(^|\s)Type:/.test(message)
    || !/(^|\s)Why:/.test(message)) {
    problems.push('missing complete Prompt audit metadata');
  }

  if ((promptFiles.some(isSystemPromptSourcePath) || producerFiles.length > 0)
    && (!/^Prompt confirmation:/m.test(message)
      || !/^[ \t]*-?[ \t]*Confirmed-by:[ \t]*\S/m.test(message)
      || !/^[ \t]*Scope:[ \t]*\S/m.test(message))) {
    problems.push('missing scoped Prompt confirmation metadata');
  }
  return problems;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout.trim();
}

function resolveBase(repoRoot) {
  const argIndex = process.argv.indexOf('--base');
  let candidate = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.PROMPT_GOVERNANCE_BASE;
  if (!candidate || /^0+$/.test(candidate)) candidate = 'HEAD^';
  const probe = spawnSync('git', ['cat-file', '-e', `${candidate}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    throw new Error(`prompt governance base is not available: ${candidate}`);
  }
  return candidate;
}

function selectGovernanceBase(requestedBase, introductions, isAncestor) {
  return introductions.find((commit) => isAncestor(requestedBase, commit)) || requestedBase;
}

/** Do not apply a newly introduced commit policy retroactively to commits that
 * predate the checker itself. Once the event/PR base is newer than adoption,
 * that narrower base remains authoritative. */
function resolveEffectiveBase(repoRoot, requestedBase) {
  const output = runGit([
    'log', '--format=%H', '--diff-filter=A', 'HEAD', '--', CHECKER_PATH,
  ], repoRoot);
  const introductions = output ? output.split('\n').filter(Boolean) : [];
  return selectGovernanceBase(requestedBase, introductions, (ancestor, descendant) => {
    const probe = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (probe.status === 0) return true;
    if (probe.status === 1) return false;
    throw new Error(
      `git merge-base --is-ancestor failed: ${(probe.stderr || '').trim()}`,
    );
  });
}

function changedFilesForCommit(repoRoot, commit, parents) {
  const args = parents.length
    ? ['diff', '--no-renames', '--name-only', '--diff-filter=ACMRD', parents[0], commit, '--']
    : ['diff-tree', '--root', '--no-commit-id', '--no-renames', '--name-only', '-r', '--diff-filter=ACMRD', commit, '--'];
  const output = runGit(args, repoRoot);
  return output ? output.split('\n').filter(Boolean) : [];
}

function diffForCommitFile(repoRoot, commit, parents, file) {
  return parents.length
    ? runGit(['diff', '--no-ext-diff', '--unified=0', parents[0], commit, '--', file], repoRoot)
    : runGit(['show', '--format=', '--no-ext-diff', '--unified=0', commit, '--', file], repoRoot);
}

function stagedSystemPromptProducerFiles(repoRoot) {
  const output = runGit([
    'diff', '--cached', '--no-renames', '--name-only', '--diff-filter=ACMRD', '--',
  ], repoRoot);
  const files = output ? output.split('\n').filter(Boolean) : [];
  return findSystemPromptProducerFiles(files, (file) => (
    runGit(['diff', '--cached', '--no-ext-diff', '--unified=0', '--', file], repoRoot)
  ));
}

function main() {
  const repoRoot = runGit(['rev-parse', '--show-toplevel'], process.cwd());
  if (process.argv.includes('--staged-system-prompt-files')) {
    const files = stagedSystemPromptProducerFiles(repoRoot);
    if (files.length) process.stdout.write(`${files.join('\n')}\n`);
    return;
  }
  const requestedBase = resolveBase(repoRoot);
  const base = resolveEffectiveBase(repoRoot, requestedBase);
  const range = runGit(['rev-list', '--reverse', `${base}..HEAD`], repoRoot);
  const commits = range ? range.split('\n').filter(Boolean) : [];
  const failures = [];

  for (const commit of commits) {
    const parentLine = runGit(['rev-list', '--parents', '-n', '1', commit], repoRoot).split(/\s+/);
    const parents = parentLine.slice(1);
    // Prompt changes from a normal merge parent are checked on their owning
    // commits; the local commit-msg hook separately checks manual resolutions.
    if (parents.length > 1) continue;
    const files = changedFilesForCommit(repoRoot, commit, parents);
    const producerFiles = findSystemPromptProducerFiles(files, (file) => (
      diffForCommitFile(repoRoot, commit, parents, file)
    ));
    const message = runGit(['show', '-s', '--format=%B', commit], repoRoot);
    const problems = validateCommitMetadata(message, files, producerFiles);
    if (problems.length) {
      const governedFiles = [...new Set([...files.filter(isPromptFacingPath), ...producerFiles])];
      failures.push(`${commit.slice(0, 12)}: ${problems.join('; ')}\n  ${governedFiles.join('\n  ')}`);
    }
  }

  if (failures.length) {
    process.stderr.write(`Prompt governance failed:\n${failures.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Prompt governance passed for ${commits.length} commit(s).\n`);
}

module.exports = {
  findSystemPromptProducerFiles,
  isPromptFacingPath,
  isSystemPromptProducerChange,
  isSystemPromptSourcePath,
  selectGovernanceBase,
  validateCommitMetadata,
};

if (require.main === module) main();
