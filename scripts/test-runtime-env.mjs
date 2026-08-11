import fs from 'node:fs';
import path from 'node:path';

function environmentPathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function containsGitExecutable(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .some((entry) => entry && fs.existsSync(path.join(entry, 'git.exe')));
}

function pathEntries(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function containsPathEntry(entries, candidate) {
  const normalized = path.resolve(candidate).toLowerCase();
  return entries.some((entry) => path.resolve(entry).toLowerCase() === normalized);
}

function gitBashBinCandidates(gitBins) {
  return [...new Set(gitBins.flatMap((gitBin) => [
    gitBin,
    path.resolve(gitBin, '..', 'bin'),
  ]))];
}

export function windowsGitBinCandidates(env) {
  const candidates = [];
  const explicitGit = String(env.ORKAS_TEST_GIT || '').trim();
  if (explicitGit) candidates.push(path.dirname(explicitGit));

  const localAppData = String(env.LOCALAPPDATA || '').trim();
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Programs', 'Git', 'cmd'));
    const desktopRoot = path.join(localAppData, 'GitHubDesktop');
    if (fs.existsSync(desktopRoot)) {
      const appDirs = fs.readdirSync(desktopRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('app-'))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      for (const appDir of appDirs) {
        candidates.push(path.join(desktopRoot, appDir, 'resources', 'app', 'git', 'cmd'));
      }
    }
  }

  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (root) candidates.push(path.join(String(root), 'Git', 'cmd'));
  }
  return [...new Set(candidates)];
}

/**
 * Desktop test and benchmark processes invoke Git through production sync
 * scripts and isolated repository fixtures. Codex Desktop and GitHub Desktop
 * can provide Git without placing it on the inherited Windows PATH, so make
 * that existing runtime discoverable instead of failing with ENOENT.
 */
export function withWindowsGitOnPath(env, platform = process.platform) {
  const result = { ...env };
  if (platform !== 'win32') return result;

  const pathKey = environmentPathKey(result);
  const currentPath = String(result[pathKey] || '');
  const currentEntries = pathEntries(currentPath);
  const configuredGitBins = windowsGitBinCandidates(result)
    .filter((candidate) => fs.existsSync(path.join(candidate, 'git.exe')));
  const currentGitBins = currentEntries
    .filter((entry) => fs.existsSync(path.join(entry, 'git.exe')));
  const prepend = [];

  if (!containsGitExecutable(currentPath) && configuredGitBins[0]) {
    prepend.push(configuredGitBins[0]);
  }

  // Windows ships a System32/bash.exe placeholder that only opens the WSL
  // installation prompt. Shell-contract tests need the bash.exe that belongs
  // to Git for Windows, even when another git.exe is already visible on PATH.
  const gitBashBin = gitBashBinCandidates([...currentGitBins, ...configuredGitBins])
    .find((candidate) => (
      fs.existsSync(path.join(candidate, 'git.exe'))
      && fs.existsSync(path.join(candidate, 'bash.exe'))
    ));
  const configuredBash = String(result.ORKAS_TEST_BASH || '').trim();
  const gitBashPath = configuredBash && fs.existsSync(configuredBash)
    ? configuredBash
    : (gitBashBin ? path.join(gitBashBin, 'bash.exe') : '');
  if (gitBashBin && !containsPathEntry(currentEntries, gitBashBin)) {
    prepend.unshift(gitBashBin);
  }
  if (gitBashPath) result.ORKAS_TEST_BASH = gitBashPath;

  if (prepend.length) {
    result[pathKey] = [...new Set(prepend), ...(currentPath ? [currentPath] : [])]
      .join(path.delimiter);
  }
  return result;
}
