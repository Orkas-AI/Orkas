import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildSandboxEnv, buildShellInvocation } from '../src/core-agent/src/sandbox/executor.ts';
import { withWindowsPowerShellModules } from './test-runtime-env.mjs';

if (process.platform !== 'win32') throw new Error('This diagnostic requires native Windows');
const sandbox = buildSandboxEnv(undefined);
const legacyModules = path.win32.join(sandbox.SystemRoot ?? sandbox.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
const ancestor = { ...withWindowsPowerShellModules(process.env), ...sandbox };
const observations: unknown[] = [];
for (const [profile, env] of [
  ['sandbox', sandbox],
  ['system-module-path', { ...sandbox, PSModulePath: legacyModules }],
  ['sandbox-repeat', sandbox],
  ['full-parent-control', ancestor],
] as const) {
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
    const timeout = setTimeout(() => { sample.timedOut = true; child.kill(); }, 35_000);
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
}
console.log(JSON.stringify({ runtime: process.versions.electron ? "Electron" : "Node", observations }));
