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
const prefix = "[Console]::WriteLine('phase: engine-ready');";
const cachePath = pick(['PSModuleAnalysisCachePath']);
if (!cachePath.PSModuleAnalysisCachePath) throw new Error('Runner cache location unavailable');
const profiles = [
  ['ordinary-alias', sandbox, prefix + "echo fast", 35000],
  ['qualified-cmdlet', sandbox, prefix + "Microsoft.PowerShell.Utility\\Write-Output fast", 35000],
  ['autoload-off', sandbox, prefix + "$PSModuleAutoloadingPreference = 'None'; echo fast", 35000],
  ['explicit-utility-import', sandbox, prefix + "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop; [Console]::WriteLine('phase: utility-imported'); echo fast", 35000],
  ['runner-cache-direct', {...sandbox,...cachePath}, prefix + "echo fast", 35000],
  ['ordinary-alias-repeat', sandbox, prefix + "echo fast", 35000],
] as const;
const observations: unknown[] = [];
for (const [profile, env, command, limit] of profiles) {
  const shell = 'powershell.exe';
  const invocation = buildShellInvocation(shell, command);
  const result = await new Promise((resolve, reject) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const child = spawn(invocation.command, invocation.args, {
      cwd: os.tmpdir(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const sample = {profile, shell, spawnMs: null as number | null, firstStdoutMs: null as number | null,
      exitMs: null as number | null, closeMs: 0, code: null as number | null,
      timedOut: false, expectedOutput: false, stderrBytes: 0, phaseTimesMs: {} as Record<string,number>};
    let stdout = '';
    const timeout = setTimeout(() => { sample.timedOut = true; child.kill(); }, limit);
    child.once('spawn', () => { sample.spawnMs = elapsed(); });
    child.stdout.on('data', bytes => { sample.firstStdoutMs ??= elapsed(); stdout += bytes.toString('utf8'); for (const line of stdout.split(/\r?\n/)) { if (line.startsWith('phase: ')) sample.phaseTimesMs[line] ??= elapsed(); } });
    child.stderr.on('data', bytes => { sample.stderrBytes += bytes.length; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { sample.exitMs = elapsed(); });
    child.once('close', code => {
      clearTimeout(timeout);
      sample.code = code;
      sample.closeMs = elapsed();
      sample.expectedOutput = stdout.trim().split(/\r?\n/).at(-1) === 'fast';
      resolve(sample);
    });
  });
  observations.push(result);
  console.log(JSON.stringify({ sample: result }));
}
console.log(JSON.stringify({ runtime: process.versions.electron ? "Electron" : "Node", observations }));
