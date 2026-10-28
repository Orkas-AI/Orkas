import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModelEvalLogCollector } from './model-eval-log-policy.mjs';
import { ingestLocalAgentLogEvent, liveRuntimeOverrides } from './local-agent-live-support.mjs';

const FLAGS = [
  'started', 'fixtureUnchanged', 'cancelled', 'terminalLast', 'persistedCancelled',
  'childExited', 'observedPastDeadline', 'lateEffectAbsent', 'sessionPresent',
  'resumed', 'sessionStrategyHonored', 'recoveredKey', 'recoveryPersisted',
  'recoveryTerminalLast', 'recoveryToolsAppropriate', 'recoveryStreamed',
  'recoveryOutputPersisted', 'logsHealthy', 'warmupReady',
];

export function lifecycleRecoveryPlan(capabilities) {
  if (capabilities.resume === 'native') return { mode: 'native', warmup: true };
  if (capabilities.resume === 'session-id') return { mode: 'session-id', warmup: true };
  if (capabilities.resume === 'none') return { mode: 'fresh', warmup: false };
  throw new Error('Unknown CLI continuation contract');
}

/** A clean terminal status cannot substitute for an observed live tool,
 * absent delayed side effects, or a successful native continuation. */
export function scoreCancellationCanary(observation, fault = 'cancel') {
  if (!['cancel', 'wall'].includes(fault)) throw new Error('unsupported lifecycle fault');
  const flags = fault === 'wall'
    ? FLAGS.filter(name => !['cancelled', 'persistedCancelled'].includes(name))
      .concat(['timedOut', 'persistedTimeout', 'timeoutKindCorrect']) : FLAGS;
  return [
    ...flags.map(name => ({ name, pass: observation[name] === true })),
    ...['terminalCount', 'recoveryTerminalCount'].map(name => ({ name, pass: observation[name] === 1 })),
  ];
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
};
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

export async function runLiveLifecycleCanary(entries, run, uid, testDataRoot, { fault = 'cancel' } = {}) {
  if (!['cancel', 'wall'].includes(fault)) throw new Error('unsupported lifecycle fault');
  const startedAt = new Date().toISOString();
  const { localAgentRunDir } = await import('../src/main/paths.js');
  const { LOCAL_CLI_TYPES, localCliCapabilities } = await import('../src/main/features/local_agents/registry.js');
  const results = [];
  for (const entry of entries) {
    if (!LOCAL_CLI_TYPES.includes(entry.type)) {
      results.push({ agent: entry.type, passed: false, status: 'unsupported', checks: [] });
      continue;
    }
    const capabilities = localCliCapabilities(entry.type);
    const plan = lifecycleRecoveryPlan(capabilities);
    try {
      const cwd = path.join(testDataRoot, 'lifecycle', entry.type);
      fs.mkdirSync(cwd, { recursive: true });
      const key = randomUUID();
      const nonce = randomUUID();
      const delayMs = fault === 'wall' ? 60_000 : 20_000;
      const source = [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        `fs.writeFileSync(path.join(__dirname, 'started.json'), JSON.stringify({ nonce: ${JSON.stringify(nonce)}, pid: process.pid, deadline: Date.now() + ${delayMs} }));`,
        `setTimeout(() => fs.writeFileSync(path.join(__dirname, 'late-effect.txt'), 'TOOL_SURVIVED'), ${delayMs});`,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(cwd, 'delayed-write.cjs'), source);
      fs.writeFileSync(path.join(cwd, 'resume-key.txt'), key);
      const controller = new AbortController();
      const logs = createModelEvalLogCollector(`${entry.type}/${fault}-resume`);
      const events = { doneCount: 0, lastType: '', toolCount: 0, timeoutKind: null };
      const recoveryEvents = { doneCount: 0, lastType: '', toolCount: 0 };
      let recoveryText = '';
      let observedToolPhase = events;
      const track = (trace, event) => {
        ingestLocalAgentLogEvent(logs, event);
        trace.lastType = event.type;
        if (event.type === 'done') { trace.doneCount++; trace.timeoutKind = event.timeoutKind; }
        if (event.type === 'tool-event') trace.toolCount++;
      };
      let receipt = null;
      let cancellationRequestedAt = 0;
      const common = {
        uid, cid: `c-lifecycle-${entry.type}`, agentId: `a-lifecycle-${entry.type}`,
        agentName: `Lifecycle ${entry.type}`, cli: entry.type, cwd,
        permissionPolicy: capabilities.permissionPolicies.includes('full_access') ? 'full_access' : 'inherit',
        ...liveRuntimeOverrides(entry.type),
        ...(entry.type === 'openclaw' ? { onBridgeCallObserved: call => {
          observedToolPhase.toolCount++;
          if (!call.ok) ingestLocalAgentLogEvent(logs, { type: 'tool-event', isError: true });
        } } : {}),
      };
      let initial, recovery, meta, recoveredMeta, persistedTerminal;
      let seedSessionId = '';
      let warmupReady = !plan.warmup;
      if (plan.warmup) {
        const warmup = await run({ ...common, currentMessageId: 'lifecycle-warmup',
          signal: new AbortController().signal,
          prompt: `Read ${JSON.stringify(path.join(cwd, 'resume-key.txt'))} and reply with its exact value only. Do not edit files.`,
          onEvent: event => ingestLocalAgentLogEvent(logs, event) });
        const warmupMeta = readJson(path.join(localAgentRunDir(uid, warmup.runId), 'meta.json'));
        seedSessionId = warmupMeta?.sessionId || '';
        warmupReady = warmup.status === 'completed' && warmup.output?.trim() === key && !!seedSessionId;
        if (warmupReady) fs.rmSync(path.join(cwd, 'resume-key.txt'), { force: true });
        if (!warmupReady) {
          results.push({ agent: entry.type, version: entry.version, recoveryMode: plan.mode,
            passed: false, status: 'warmup-failed', warmupStatus: warmup.status, checks: [{ name: 'warmupReady', pass: false }], cliLogAnalysis: logs.finish() });
          continue;
        }
      }
      // No tool-start receipt within two minutes is a failed precondition, not a
      // successful cancellation. The production runner still owns process cleanup.
      const guard = setTimeout(() => controller.abort(), 120_000);
      const poll = setInterval(() => {
        const candidate = readJson(path.join(cwd, 'started.json'));
        if (receipt || candidate?.nonce !== nonce || !Number.isSafeInteger(candidate.pid)
            || !Number.isFinite(candidate.deadline)) return;
        receipt = candidate;
        cancellationRequestedAt = Date.now();
        if (fault === 'cancel') controller.abort();
      }, 50);
      try {
        process.stdout.write(`[local-agent-lifecycle] ${entry.type}: starting a real foreground tool\n`);
        initial = await run({
          ...common, currentMessageId: 'lifecycle-start', signal: controller.signal,
          ...(fault === 'wall' ? { deadlineAt: Date.now() + 45_000 } : {}),
          ...(seedSessionId ? { resumeSessionId: seedSessionId } : {}),
          prompt: `Run node ${JSON.stringify(path.join(cwd, 'delayed-write.cjs'))} as a foreground command and wait for it. `
            + 'Do not edit files, start background work, or retry the command.',
          onEvent: event => track(events, event),
        });
        meta = readJson(path.join(localAgentRunDir(uid, initial.runId), 'meta.json'));
        const eventRows = fs.readFileSync(path.join(localAgentRunDir(uid, initial.runId), 'events.jsonl'), 'utf8');
        persistedTerminal = eventRows.trim().split('\n').filter(Boolean).map(row => JSON.parse(row)).filter(event => event.type === 'done').at(-1);
      } finally {
        clearTimeout(guard);
        clearInterval(poll);
        if (!controller.signal.aborted) controller.abort();
      }
      // Observe beyond the tool's own timer, so killing only its parent cannot
      // pass while an orphan writes later. Cap malformed receipts independently.
      const observeUntil = receipt
        ? Math.min(receipt.deadline + 1_000, cancellationRequestedAt + delayMs + 2_000)
        : Date.now();
      while (Date.now() < observeUntil) await pause(Math.min(250, observeUntil - Date.now()));
      const sessionId = typeof meta?.sessionId === 'string' ? meta.sessionId : seedSessionId;
      const childExited = receipt ? !alive(receipt.pid) : false;
      const lateEffectAbsent = !fs.existsSync(path.join(cwd, 'late-effect.txt'));
      // Remove the only host fixture containing the secret. Recovery has to get
      // it from the real native session rather than a new workspace read.
      fs.rmSync(path.join(cwd, 'resume-key.txt'), { force: true });
      const recoveryKey = plan.mode === 'fresh' ? randomUUID() : key;
      if (plan.mode === 'fresh') fs.writeFileSync(path.join(cwd, 'recovery-key.txt'), recoveryKey);
      if (sessionId || plan.mode === 'fresh') {
        process.stdout.write(`[local-agent-lifecycle] ${entry.type}: checking ${plan.mode} recovery after cancellation\n`);
        observedToolPhase = recoveryEvents;
        recovery = await run({
          ...common, currentMessageId: 'lifecycle-recover',
          ...(plan.mode === 'fresh' ? {} : { resumeSessionId: sessionId }), signal: new AbortController().signal,
          prompt: plan.mode === 'fresh'
            ? `The long command has been stopped. Read ${JSON.stringify(path.join(cwd, 'recovery-key.txt'))} and return its exact value only. Do not restart the command or edit files.`
            : 'The long command has been stopped. Return only the exact key you read before starting it. '
              + 'Do not call tools, access files, or restart the command.',
          onEvent: event => {
            track(recoveryEvents, event);
            if (event.type === 'text-delta' && typeof event.text === 'string') {
              recoveryText = (recoveryText + event.text).slice(0, 4_096);
            }
          },
        });
        recoveredMeta = readJson(path.join(localAgentRunDir(uid, recovery.runId), 'meta.json'));
      }
      const cliLogAnalysis = logs.finish();
      const observation = {
        started: !!receipt && cancellationRequestedAt < receipt.deadline,
        fixtureUnchanged: fs.readFileSync(path.join(cwd, 'delayed-write.cjs'), 'utf8') === source,
        cancelled: initial?.status === 'cancelled', terminalCount: events.doneCount,
        terminalLast: events.lastType === 'done', persistedCancelled: meta?.status === 'cancelled',
        timedOut: initial?.status === 'timeout', persistedTimeout: meta?.status === 'timeout',
        timeoutKindCorrect: initial?.timeoutKind === 'wall' && events.timeoutKind === 'wall'
          && persistedTerminal?.status === 'timeout' && persistedTerminal?.timeoutKind === 'wall',
        childExited, observedPastDeadline: !!receipt && Date.now() > receipt.deadline,
        lateEffectAbsent: lateEffectAbsent && !fs.existsSync(path.join(cwd, 'late-effect.txt')),
        sessionPresent: !!sessionId, resumed: recovery?.status === 'completed',
        sessionStrategyHonored: !!sessionId && !!recoveredMeta?.sessionId
          && (plan.mode === 'fresh' ? recoveredMeta.sessionId !== sessionId : recoveredMeta.sessionId === sessionId),
        recoveredKey: String(recovery?.output || '').trim() === recoveryKey,
        recoveryPersisted: recoveredMeta?.status === 'completed' && recoveredMeta?.output?.trim() === recoveryKey,
        recoveryTerminalCount: recoveryEvents.doneCount,
        recoveryTerminalLast: recoveryEvents.lastType === 'done',
        recoveryToolsAppropriate: plan.mode === 'fresh' ? recoveryEvents.toolCount > 0 : recoveryEvents.toolCount === 0,
        recoveryStreamed: recoveryText.trim() === recoveryKey,
        recoveryOutputPersisted: !!recovery && fs.readFileSync(path.join(localAgentRunDir(uid, recovery.runId), 'output.txt'), 'utf8').trim() === recoveryKey,
        logsHealthy: cliLogAnalysis.passed,
        warmupReady,
      };
      const checks = scoreCancellationCanary(observation, fault);
      results.push({ agent: entry.type, version: entry.version, recoveryMode: plan.mode,
        outputDelivery: capabilities.progressEvents ? 'streaming' : 'buffered',
        recoveryToolObservation: entry.type === 'openclaw' ? 'orkas-rpc-only' : 'native-events', passed: checks.every(check => check.pass),
        status: initial?.status || 'unknown', recoveryStatus: recovery?.status || 'not-run', checks, cliLogAnalysis });
    } catch {
      // One broken CLI must not hide the remaining selected installations.
      // Do not put raw errors, fixture paths or native session data in reports.
      results.push({ agent: entry.type, version: entry.version, passed: false,
        status: 'infrastructure-failure', checks: [{ name: 'canary-execution', pass: false }] });
    }
  }
  return { kind: 'local-agent-lifecycle', fault, startedAt, finishedAt: new Date().toISOString(),
    platform: process.platform, passed: results.length > 0 && results.every(result => result.passed), results };
}
