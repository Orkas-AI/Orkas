#!/usr/bin/env node
/**
 * Opt-in real local-agent verification.
 *
 * It detects every requested CLI using Orkas' production registry, binds a
 * cached test-managed install when present, installs missing CLIs, then sends
 * one harmless fixed-output request through the production runner.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyCurrentHistoryReadMode,
  LOCAL_AGENT_ENV_KEYS,
  localAgentBenchmarkScenariosFor,
  classifyLiveFailure,
  ensureRequestedAgents,
  installerPlan,
  managedBinaryCandidates,
  parseLiveArgs,
  scoreLocalAgentBenchmarkScenario,
  summarizeLiveFailure,
  validateLiveProtocolTrace,
  validateLocalAgentBenchmarkInventory,
} from './local-agent-live-support.mjs';
import { resolveCliCommand } from '../src/main/features/local_agents/spawn-command.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pcRoot = path.resolve(scriptDir, '..');
const installRoot = process.env.ORKAS_LOCAL_AGENT_TEST_INSTALL_ROOT
  ? path.resolve(process.env.ORKAS_LOCAL_AGENT_TEST_INSTALL_ROOT)
  : path.join(pcRoot, 'node_modules', '.orkas-local-agent-live');

function usage(): string {
  return [
    'Usage: npm run test:local-agents:live -- [options]',
    '',
    'Options:',
    '  --agents claude,codex,...  Agents to verify; default: all five',
    '  --no-install               Fail instead of installing a missing CLI',
    '  --install-only             Install and version-check, skip model calls',
    '  --benchmark                Run the objective model-quality suite',
    '  --k N                      Benchmark rollouts per scenario; default: 2',
    '  --no-save                  Print benchmark scorecard without saving it',
    '  -h, --help                 Show this help',
  ].join('\n');
}

function printableCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
}

async function runProcess(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<void> {
  process.stdout.write(`\n[local-agent-live] $ ${printableCommand(command, args)}\n`);
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    const launch = resolveCliCommand(command, args, process.platform, env);
    const child = spawn(launch.command, launch.args, {
      cwd: pcRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    const timeoutMs = options.timeoutMs ?? Number(process.env.ORKAS_LOCAL_AGENT_INSTALL_TIMEOUT_MS || 15 * 60_000);
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

function bindManagedBinary(type: string): boolean {
  for (const candidate of managedBinaryCandidates(type, { platform: process.platform, installRoot })) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      process.env[LOCAL_AGENT_ENV_KEYS[type]] = candidate;
      if (type === 'hermes') {
        process.env.HERMES_HOME = path.join(installRoot, 'hermes-home');
      }
      return true;
    } catch {
      // Try the next known install layout.
    }
  }
  return false;
}

function applyManagedRuntimeEnv(entry: { type: string; path?: string | null }): void {
  if (entry.type !== 'hermes' || !entry.path) return;
  try {
    const realBinary = fs.realpathSync(entry.path);
    const managedPrefix = `${fs.realpathSync(installRoot)}${path.sep}`;
    if (realBinary.startsWith(managedPrefix)) {
      process.env.HERMES_HOME = path.join(installRoot, 'hermes-home');
    }
  } catch {
    // Detection already validated the executable; leave its normal env alone.
  }
}

async function installAgent(type: string): Promise<void> {
  fs.mkdirSync(installRoot, { recursive: true });
  if (type === 'hermes') {
    const repository = path.join(installRoot, 'hermes-home', 'hermes-agent');
    if (fs.existsSync(repository)) {
      const validManagedClone = fs.existsSync(path.join(repository, '.git', 'HEAD'))
        && (fs.existsSync(path.join(repository, 'pyproject.toml'))
          || fs.existsSync(path.join(repository, 'setup.py')));
      if (!validManagedClone) {
        // The official updater treats any existing directory as a Git clone.
        // Removing an interrupted test-only install prevents `git -C` from
        // walking upward into the enclosing Orkas repository.
        fs.rmSync(repository, {
          recursive: true,
          force: true,
          maxRetries: process.platform === 'win32' ? 20 : 0,
          retryDelay: process.platform === 'win32' ? 100 : 0,
        });
      }
    }
  }
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), `orkas-${type}-installer-`));
  try {
    const plan = installerPlan(type, {
      platform: process.platform,
      installRoot,
      downloadDir,
    });
    for (const step of plan) {
      try {
        await runProcess(step.command, step.args, { env: step.env });
      } catch (error) {
        // OpenCode's Windows postinstall can finish copying a valid platform
        // executable and then fail while npm removes the staging directory.
        // Accept that narrow partial-success case; ensureRequestedAgents will
        // still run the production version probe before considering it ready.
        if (type === 'opencode' && process.platform === 'win32' && bindManagedBinary(type)) {
          process.stderr.write(
            `[local-agent-live] warning: OpenCode installer exited non-zero after producing a managed executable: ${(error as Error).message}\n`,
          );
          break;
        }
        throw error;
      }
    }
  } finally {
    fs.rmSync(downloadDir, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 20 : 0,
      retryDelay: process.platform === 'win32' ? 100 : 0,
    });
  }
  if (!bindManagedBinary(type)) {
    throw new Error(`${type} installer completed but no managed executable was found under ${installRoot}`);
  }
}

type QualityRun = {
  agent: string;
  scenario: string;
  rollout: number;
  passed: boolean;
  status: string;
  wallMs: number;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  outputSha256: string;
  failureKind: string | null;
};

function outputFingerprint(text: string): string {
  return text
    ? createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex')
    : '';
}

function scorecardFileTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

function listWorkspaceFiles(root: string, relativeDir = ''): string[] {
  const absoluteDir = path.join(root, relativeDir);
  const files: string[] = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...listWorkspaceFiles(root, relativePath));
    else files.push(relativePath.split(path.sep).join('/'));
  }
  return files.sort();
}

async function runQualityBenchmark(
  entries: Array<{ type: string; version?: string | null }>,
  run: (options: any) => Promise<any>,
  uid: string,
  testDataRoot: string,
  options: { k: number; noSave: boolean },
): Promise<void> {
  const inventoryErrors = validateLocalAgentBenchmarkInventory();
  if (inventoryErrors.length) {
    throw new Error(`invalid local-agent benchmark inventory:\n${inventoryErrors.map(error => `- ${error}`).join('\n')}`);
  }
  const startedAt = new Date().toISOString();
  const results: QualityRun[] = [];
  const [chats, storage, layout, paths, skillRegistry] = await Promise.all([
    import('../src/main/features/chats.js'),
    import('../src/main/storage.js'),
    import('../src/main/util/project-layout.js'),
    import('../src/main/paths.js'),
    import('../src/main/model/core-agent/skill-registry.js'),
  ]);

  for (const entry of entries) {
    for (const scenario of localAgentBenchmarkScenariosFor(entry.type)) {
      for (let rollout = 1; rollout <= options.k; rollout += 1) {
        const cwd = path.join(testDataRoot, 'benchmark', entry.type, scenario.id, `rollout-${rollout}`);
        fs.mkdirSync(cwd, { recursive: true });
        for (const [relPath, content] of Object.entries(scenario.seedFiles)) {
          const absPath = path.join(cwd, relPath);
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, String(content), 'utf8');
        }
        const bridgeSkills = Object.entries((scenario as any).bridgeSkills || {});
        for (const [skillId, skillBody] of bridgeSkills) {
          const skillDir = path.join(paths.userSkillsDir(uid), skillId);
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(path.join(skillDir, 'SKILL.md'), String(skillBody), 'utf8');
        }
        if (bridgeSkills.length) await skillRegistry.invalidateSkills();

        const cid = `c-bench-${entry.type}-${scenario.id}-${rollout}`;
        const agentId = `a-bench-${entry.type}`;
        const currentMessageId = `trigger-${scenario.id}-${rollout}`;
        await chats.createConversation(uid, {
          conversationId: cid,
          title: `Local Agent benchmark: ${scenario.id}`,
        });
        const messageFile = layout.conversationMessageFile(uid, cid);
        const historyRows = Array.isArray((scenario as any).chatHistory?.messages)
          ? (scenario as any).chatHistory.messages
          : [];
        const baseTime = Date.parse('2033-01-01T00:00:00.000Z');
        for (const [index, row] of historyRows.entries()) {
          await storage.appendJsonlAtomic(messageFile, {
            id: `history-${scenario.id}-${index + 1}`,
            ts: new Date(baseTime + index * 1_000).toISOString(),
            from: row.from,
            to: [...row.to],
            text: row.text,
          });
        }
        await storage.appendJsonlAtomic(messageFile, {
          id: currentMessageId,
          ts: new Date(baseTime + historyRows.length * 1_000).toISOString(),
          from: 'user',
          to: [agentId],
          text: scenario.prompt,
        });

        let terminalEvent: any = null;
        const toolNames: string[] = [];
        const historyReadModes: string[] = [];
        const t0 = Date.now();
        const result = await run({
          uid,
          cid,
          agentId,
          agentName: `Benchmark ${entry.type}`,
          currentMessageId,
          cli: entry.type,
          prompt: scenario.prompt,
          cwd,
          signal: new AbortController().signal,
          onEvent: (event: any) => {
            if (event?.type === 'done') terminalEvent = event;
            if (event?.type === 'tool-event' && event?.phase === 'use' && event?.tool) {
              toolNames.push(String(event.tool));
              const historyReadMode = classifyCurrentHistoryReadMode(event.tool, event.input);
              if (historyReadMode) historyReadModes.push(historyReadMode);
            }
          },
        });
        const files: Record<string, string | null> = {};
        for (const relPath of scenario.observedFiles) {
          try { files[relPath] = fs.readFileSync(path.join(cwd, relPath), 'utf8'); }
          catch { files[relPath] = null; }
        }
        const output = String(result.output || '');
        const checks = scoreLocalAgentBenchmarkScenario(scenario, {
          status: result.status,
          output,
          files,
          workspaceFiles: listWorkspaceFiles(cwd),
          toolNames,
          historyReadModes,
          commanderHandoff: result.commanderHandoff || null,
        });
        const passed = checks.every(check => check.pass);
        const failureKind = passed
          ? null
          : classifyLiveFailure({
              ...result,
              stderrTail: typeof terminalEvent?.stderrTail === 'string' ? terminalEvent.stderrTail : '',
            });
        results.push({
          agent: entry.type,
          scenario: scenario.id,
          rollout,
          passed,
          status: String(result.status || 'unknown'),
          wallMs: Date.now() - t0,
          checks,
          outputSha256: outputFingerprint(output),
          failureKind,
        });
        const failedChecks = checks.filter(check => !check.pass).map(check => check.name);
        process.stdout.write(
          `  ${passed ? '✓' : '✗'} ${entry.type}/${scenario.id} rollout ${rollout}/${options.k}`
          + `${failedChecks.length ? ` failed=${failedChecks.join(',')}` : ''}\n`,
        );
      }
    }
  }

  const robustGroups = new Map<string, boolean>();
  for (const result of results) {
    const key = `${result.agent}/${result.scenario}`;
    robustGroups.set(key, (robustGroups.get(key) ?? true) && result.passed);
  }
  const passedRollouts = results.filter(result => result.passed).length;
  const robustPassed = [...robustGroups.values()].filter(Boolean).length;
  const scorecard = {
    kind: 'local-agent-quality',
    startedAt,
    finishedAt: new Date().toISOString(),
    k: options.k,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      agents: entries.map(entry => ({ type: entry.type, version: entry.version || null })),
    },
    aggregate: {
      rollouts: results.length,
      passed: passedRollouts,
      passRate: results.length ? passedRollouts / results.length : 0,
      scenarioGroups: robustGroups.size,
      robustPassed,
    },
    results,
  };

  if (!options.noSave) {
    const resultsDir = path.join(pcRoot, 'eval', 'local-agents', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const fileName = `local-agent-quality-${scorecardFileTimestamp(startedAt)}-${process.pid}.json`;
    const outputPath = path.join(resultsDir, fileName);
    fs.writeFileSync(outputPath, `${JSON.stringify(scorecard, null, 2)}\n`, 'utf8');
    process.stdout.write(`[local-agent-benchmark] scorecard: ${path.relative(pcRoot, outputPath)}\n`);
  } else {
    process.stdout.write('[local-agent-benchmark] scorecard not saved (--no-save)\n');
  }
  process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
  if (passedRollouts !== results.length) {
    throw new Error(
      `local-agent quality benchmark failed: ${passedRollouts}/${results.length} rollouts passed,`
      + ` ${robustPassed}/${robustGroups.size} scenario groups robust`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseLiveArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const testDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-local-agent-live-data-'));
  process.env.ORKAS_WORKSPACE_ROOT = testDataRoot;
  process.env.ORKAS_LOCAL_AGENT_TIMEOUT_MS ||= '180000';
  process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS ||= '60000';

  try {
    const registry = await import('../src/main/features/local_agents/registry.js');
    const entries = await ensureRequestedAgents({
      agents: args.agents,
      installMissing: args.installMissing,
      detect: async (type: any) => registry.detectOne(type),
      bindCached: async (type: string) => bindManagedBinary(type),
      install: async (type: string) => installAgent(type),
    });

    process.stdout.write('\n[local-agent-live] prepared:\n');
    for (const entry of entries) {
      applyManagedRuntimeEnv(entry);
      process.stdout.write(`  ✓ ${entry.type} ${entry.version || '(version unknown)'}\n`);
    }
    if (args.installOnly) return;

    const [{ activateUser }, { run }] = await Promise.all([
      import('../src/main/features/users.js'),
      import('../src/main/features/local_agents/runner.js'),
    ]);
    const uid = 'u-local-agent-live';
    activateUser(uid);
    if (args.benchmark) {
      process.stdout.write(`\n[local-agent-benchmark] running pass@${args.k}...\n`);
      await runQualityBenchmark(entries, run, uid, testDataRoot, { k: args.k, noSave: args.noSave });
      return;
    }
    const failures: string[] = [];

    for (const entry of entries) {
      const cwd = path.join(testDataRoot, `work-${entry.type}`);
      fs.mkdirSync(cwd, { recursive: true });
      const eventCounts: Record<string, number> = {};
      const eventTypes: string[] = [];
      let terminalEvent: any = null;
      process.stdout.write(`\n[local-agent-live] probing ${entry.type}...\n`);
      const result = await run({
        uid,
        cid: `c-live-${entry.type}`,
        agentId: `a-live-${entry.type}`,
        agentName: `Live ${entry.type} probe`,
        currentMessageId: `trigger-live-${entry.type}`,
        cli: entry.type,
        prompt: 'Do not call tools or access or modify files. Reply with exactly ORKAS_AGENT_OK and nothing else.',
        cwd,
        signal: new AbortController().signal,
        onEvent: (event: any) => {
          const type = String(event?.type || 'unknown');
          eventCounts[type] = (eventCounts[type] || 0) + 1;
          eventTypes.push(type);
          if (type === 'done') terminalEvent = event;
        },
      });
      const output = String(result.output || '').trim();
      const protocolIssues = validateLiveProtocolTrace(entry.type, result, {
        eventTypes,
        terminalEvent,
      });

      if (result.status === 'completed' && output === 'ORKAS_AGENT_OK' && protocolIssues.length === 0) {
        process.stdout.write(`  ✓ ${entry.type}: round-trip passed ${JSON.stringify(eventCounts)}\n`);
      } else {
        const failure = {
          ...result,
          stderrTail: typeof terminalEvent?.stderrTail === 'string' ? terminalEvent.stderrTail : '',
        };
        const kind = classifyLiveFailure(failure);
        const baseDetail = summarizeLiveFailure(failure);
        const detail = protocolIssues.length
          ? `${baseDetail}; protocol=${protocolIssues.join(', ')}`
          : baseDetail;
        failures.push(`${entry.type} [${kind}]: ${detail}`);
        process.stderr.write(`  ✗ ${entry.type} [${kind}]: ${detail}\n`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`local-agent live verification failed:\n${failures.map(item => `- ${item}`).join('\n')}`);
    }
  } finally {
    // A just-exited CLI can keep its working directory briefly open on
    // Windows. Use Node's bounded rimraf retry instead of turning an otherwise
    // successful live benchmark into an EBUSY infrastructure failure.
    fs.rmSync(testDataRoot, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 20 : 0,
      retryDelay: process.platform === 'win32' ? 100 : 0,
    });
  }
}

void main().catch(error => {
  process.stderr.write(`\n[local-agent-live] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
