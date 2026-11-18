import { spawn } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { buildSandboxEnv, buildShellInvocation } from '../src/core-agent/src/sandbox/executor.ts';
import { withWindowsPowerShellModules } from './test-runtime-env.mjs';

if (process.platform !== 'win32') throw new Error('This diagnostic requires native Windows');
const sandbox = buildSandboxEnv(undefined);
const parent = withWindowsPowerShellModules(process.env);
const pick = (names: string[]) => Object.fromEntries(names.flatMap(name => {
  const value = parent[name] ?? Object.entries(parent).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return value ? [[name, value]] : [];
}));
const drive = pick(['SystemDrive', 'HOMEDRIVE', 'HOMEPATH']);
const hostPaths = pick(['ALLUSERSPROFILE', 'PUBLIC', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'DriverData']);
const runtime = pick(['OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'SESSIONNAME', 'LOGONSERVER', 'COMPUTERNAME']);
const modules = pick(['PSModulePath', 'PSModuleAnalysisCachePath']);
const profiles = [
  ['sandbox-cold', sandbox],
  ['drive-and-home', { ...sandbox, ...drive }],
  ['standard-host-paths', { ...sandbox, ...hostPaths }],
  ['runtime-identity', { ...sandbox, ...runtime }],
  ['normalized-module-path', { ...sandbox, ...modules }],
  ['combined-system-variables', { ...sandbox, ...drive, ...hostPaths, ...runtime, ...modules }],
  ['sandbox-repeat', sandbox],
  ['full-parent-control', { ...parent, ...sandbox }],
] as const;
const observations: unknown[] = [];
for (const [profile, env] of profiles) {
  const shell = 'powershell.exe';
  const invocation = buildShellInvocation(shell, 'echo fast');
  const result = await new Promise((resolve, reject) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const child = spawn(invocation.command, invocation.args, {
      cwd: os.tmpdir(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const sample = {profile, shell, spawnMs: null as number | null, firstStdoutMs: null as number | null,
      exitMs: null as number | null, closeMs: 0, code: null as number | null,
      timedOut: false, expectedOutput: false, stderrBytes: 0};
    let stdout = '';
    const timeout = setTimeout(() => { sample.timedOut = true; child.kill(); }, 25_000);
    child.once('spawn', () => { sample.spawnMs = elapsed(); });
    child.stdout.on('data', bytes => { sample.firstStdoutMs ??= elapsed(); stdout += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { sample.stderrBytes += bytes.length; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { sample.exitMs = elapsed(); });
    child.once('close', code => {
      clearTimeout(timeout);
      sample.code = code;
      sample.closeMs = elapsed();
      sample.expectedOutput = stdout.trim() === 'fast';
      resolve(sample);
    });
  });
  observations.push(result);
  console.log(JSON.stringify({ sample: result }));
}
console.log(JSON.stringify({ runtime: process.versions.electron ? "Electron" : "Node", observations }));
