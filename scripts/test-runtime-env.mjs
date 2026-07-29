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
  if (containsGitExecutable(currentPath)) return result;

  const gitBin = windowsGitBinCandidates(result)
    .find((candidate) => fs.existsSync(path.join(candidate, 'git.exe')));
  if (gitBin) result[pathKey] = currentPath ? `${gitBin}${path.delimiter}${currentPath}` : gitBin;
  return result;
}
