#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const GRACEFUL_TIMEOUT_MS = 4_000;
const POLL_INTERVAL_MS = 100;

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalizePath(value, platform) {
  const pathApi = pathApiFor(platform);
  const normalized = pathApi.normalize(String(value || '').trim());
  const withoutTrailingSeparators = normalized.replace(/[\\/]+$/, '');
  return platform === 'win32'
    ? withoutTrailingSeparators.toLowerCase()
    : withoutTrailingSeparators;
}

function tokenizeCommandLine(commandLine) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(String(commandLine || ''))) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function isBundledElectronExecutable(executablePath, appRoot, platform) {
  const pathApi = pathApiFor(platform);
  const normalizedExecutable = normalizePath(executablePath, platform);
  const electronDist = normalizePath(
    pathApi.join(appRoot, 'node_modules', 'electron', 'dist'),
    platform,
  );
  const relative = pathApi.relative(electronDist, normalizedExecutable);
  if (!relative || relative.startsWith('..') || pathApi.isAbsolute(relative)) return false;

  if (platform === 'win32') return relative.toLowerCase() === 'electron.exe';
  if (platform === 'linux') return relative === 'electron';
  if (platform === 'darwin') {
    return /^[^/]+\.app\/Contents\/MacOS\/Electron$/.test(relative);
  }
  return false;
}

function isAppRootArgument(argument, appRoot, platform) {
  const value = String(argument || '').replace(/^--app(?:-path)?=/, '');
  if (value === '.') return true;
  if (!value || value.startsWith('-')) return false;
  return normalizePath(value, platform) === normalizePath(appRoot, platform);
}

function isSourceMainProcess(processInfo, appRoot, platform = process.platform) {
  const pid = Number(processInfo?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  const commandLine = String(processInfo?.commandLine || '');
  if (!commandLine || /(?:^|\s)--type=/.test(commandLine)) return false;

  const tokens = tokenizeCommandLine(commandLine);
  const executablePath = processInfo?.executablePath || tokens[0];
  if (!isBundledElectronExecutable(executablePath, appRoot, platform)) return false;

  return tokens.slice(1).some((argument) => (
    isAppRootArgument(argument, appRoot, platform)
  ));
}

function parsePosixProcessList(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      commandLine: match[3],
    }));
}

function listProcesses(platform = process.platform) {
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop';",
      'Get-CimInstance Win32_Process',
      '| Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine',
      '| ConvertTo-Json -Compress',
    ].join(' ');
    const output = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const decoded = JSON.parse(output || '[]');
    return (Array.isArray(decoded) ? decoded : [decoded]).map((entry) => ({
      pid: Number(entry.ProcessId),
      parentPid: Number(entry.ParentProcessId),
      executablePath: entry.ExecutablePath || '',
      commandLine: entry.CommandLine || '',
    }));
  }

  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePosixProcessList(output);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function stillMatches(pid, appRoot, platform) {
  return listProcesses(platform).some((entry) => (
    entry.pid === pid && isSourceMainProcess(entry, appRoot, platform)
  ));
}

function stopWindowsProcessTree(pid, appRoot) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (error) {
    // The app can finish naturally between the final identity check and
    // taskkill. Treat that race as success; surface every other failure.
    if (!stillMatches(pid, appRoot, 'win32')) return;
    throw error;
  }
}

function stopPosixProcess(pid, appRoot, platform) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }

  const deadline = Date.now() + GRACEFUL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!stillMatches(pid, appRoot, platform)) return;
    sleep(POLL_INTERVAL_MS);
  }

  // Revalidate the PID immediately before escalation so a recycled PID can
  // never cause an unrelated process to be terminated.
  if (stillMatches(pid, appRoot, platform)) process.kill(pid, 'SIGKILL');
}

function stopSourceInstances(appRoot, platform = process.platform) {
  const matches = listProcesses(platform).filter((entry) => (
    entry.pid !== process.pid
    && entry.pid !== process.ppid
    && isSourceMainProcess(entry, appRoot, platform)
  ));
  if (matches.length === 0) return [];

  const pids = matches.map((entry) => entry.pid);
  console.log(`[Orkas] Closing previous source instance${pids.length > 1 ? 's' : ''} (PID ${pids.join(', ')})...`);
  for (const { pid } of matches) {
    if (platform === 'win32') {
      if (stillMatches(pid, appRoot, platform)) stopWindowsProcessTree(pid, appRoot);
    } else {
      stopPosixProcess(pid, appRoot, platform);
    }
  }
  return pids;
}

function readAppRoot(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex < 0 || !argv[rootIndex + 1]) {
    throw new Error('Usage: stop-source-instance.cjs --root <Orkas source directory>');
  }
  return path.resolve(argv[rootIndex + 1]);
}

if (require.main === module) {
  try {
    stopSourceInstances(readAppRoot(process.argv.slice(2)));
  } catch (error) {
    console.error(`[Orkas] Failed to close the previous source instance: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  isSourceMainProcess,
  parsePosixProcessList,
  stopSourceInstances,
  tokenizeCommandLine,
};
