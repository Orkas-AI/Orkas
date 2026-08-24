#!/usr/bin/env node
/* Protocol probe for the Claude CLI background-run contract.
 *
 *   node test/manual/probe-cli-background-runs.cjs
 *
 * Manual, network- and cost-bearing (~90s; four real Claude turns across two
 * CLI processes, billed at the selected provider/model's current price). Not
 * collected by vitest (`include: test/**\/*.test.ts`). Run it after a CLI
 * upgrade to confirm the protocol has not drifted;
 * `docs/plans/cli-background-runs.md` §2.1 records the measured baseline on
 * claude 2.1.227.
 *
 * The design in that document only holds if the CLI behaves as measured, so
 * this script asserts the six facts it rests on:
 *
 *   1 process lingers past the terminal `result` while stdin stays open
 *   2 a background task completing auto-triggers a follow-up turn (no input)
 *   3 that follow-up turn carries its own `result` + usage
 *   4 a user record injected during lingering starts a fresh turn (§5)
 *   5 a host->CLI `interrupt` control_request is accepted (§3.2)
 *   6 `stdin.end()` alone closes the process — and kills live background tasks
 *
 * The argv and the control_request auto-allow mirror
 * `src/main/features/local_agents/backends/claude.ts` exactly. The one
 * deliberate difference: the terminal `result` does NOT trigger a reap.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateStdinCleanupFact } = require('./probe-cli-background-runs-contract.cjs');

const SLEEP_SEC = Number(process.env.PROBE_SLEEP || 45);
const PROOF_SLEEP_SEC = Number(process.env.PROBE_PROOF_SLEEP || 15);
const MODEL = process.env.PROBE_MODEL || 'claude-sonnet-5';
const OVERALL_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 300_000);
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-probe-'));

const PROMPT = [
  'Run exactly this shell command as a BACKGROUND task (run_in_background: true):',
  '',
  `    sleep ${SLEEP_SEC}; echo ORKAS_PROBE_TASK_DONE`,
  '',
  'Then immediately end your turn by replying with the single word STARTED.',
  'Do NOT wait for it. Do NOT poll it. Do NOT call any other tool.',
  'Later, when that background command finishes, reply with the single word FOLLOWUP.',
].join('\n');

const INJECTED = 'Reply with exactly the word INJECTED_OK. Do not call any tool.';

// Mirrors buildClaudeArgs() minus the per-run bridge/system-prompt wiring.
const ARGS = [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--include-hook-events',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
  '--dangerously-skip-permissions',
  '--model', MODEL,
];

const t0 = Date.now();
const at = () => Date.now() - t0;
const transcript = [];
const log = (...parts) => {
  const line = `[${String(at()).padStart(6, ' ')}ms] ${parts.join(' ')}`;
  transcript.push(line);
  console.log(line);
};

const child = spawn('claude', ARGS, { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });

// Same serialized stdin writer as claude.ts — stream-json stdin is multiplexed
// and concurrent writes must never interleave records.
let stdinWrites = Promise.resolve();
function writeInputRecord(record) {
  const line = `${JSON.stringify(record)}\n`;
  const write = stdinWrites.then(() => new Promise((resolve, reject) => {
    if (child.stdin.destroyed || !child.stdin.writable) {
      reject(new Error('stdin is no longer writable'));
      return;
    }
    child.stdin.write(line, (err) => (err ? reject(err) : resolve()));
  }));
  stdinWrites = write.catch(() => {});
  return write;
}

const obs = {
  results: [],
  taskEvents: [],
  aliveAfterResult1: {},
  injectWrite: null,
  sawInjectedAck: false,
  sawFollowupAssistant: false,
  interruptResponse: null,
  stdinEndedAt: null,
  closedAt: null,
  closeCode: null,
  cleanupProof: null,
  systemSubtypes: new Set(),
};
let phase = 'main';
let mainCloseTimer = null;

const textOf = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text').map(b => b.text).join('');
};

function afterFirstResult() {
  log('>>> terminal result seen. Orkas would reap here. Probe keeps stdin OPEN.');
  for (const delay of [500, 2_000, 10_000]) {
    setTimeout(() => {
      obs.aliveAfterResult1[delay] = child.exitCode === null && child.signalCode === null;
      log(`fact 1 — alive at result+${delay}ms:`, obs.aliveAfterResult1[delay]);
    }, delay).unref?.();
  }
  setTimeout(() => {
    phase = 'injected';
    writeInputRecord({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: INJECTED }] } })
      .then(() => { obs.injectWrite = 'ok'; log('fact 4 — injected user record written'); })
      .catch((err) => { obs.injectWrite = `failed: ${err.message}`; log('fact 4 — inject FAILED', err.message); });
  }, 3_000).unref?.();
}

function afterInjectedResult() {
  // The background task is still running; wait for its auto follow-up turn.
  phase = 'awaiting-followup';
  log('>>> injected turn done. Waiting for the background task to finish on its own...');
}

function afterFollowupResult() {
  phase = 'stopping';
  setTimeout(() => {
    writeInputRecord({ type: 'control_request', request_id: 'orkas-probe-interrupt-1', request: { subtype: 'interrupt' } })
      .then(() => log('fact 5 — interrupt control_request written'))
      .catch((err) => log('fact 5 — interrupt write FAILED', err.message));
    setTimeout(() => {
      obs.stdinEndedAt = at();
      log('fact 6 — stdin.end(); measuring close latency');
      try { child.stdin.end(); } catch { /* already closed */ }
      mainCloseTimer = setTimeout(() => finish('30s after stdin.end()'), 30_000);
      mainCloseTimer.unref?.();
    }, 4_000).unref?.();
  }, 2_000).unref?.();
}

function handle(obj) {
  const type = String(obj?.type || '');
  const subtype = String(obj?.subtype || '');

  if (type === 'control_request') {
    void writeInputRecord({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: obj.request_id,
        response: { behavior: 'allow', updatedInput: obj?.request?.input || {} },
      },
    }).catch(() => {});
    return;
  }

  if (type === 'control_response') {
    obs.interruptResponse = JSON.stringify(obj);
    log('control_response (ours):', obs.interruptResponse.slice(0, 300));
    return;
  }

  if (type === 'system') {
    obs.systemSubtypes.add(subtype);
    if (/^task|background/i.test(subtype)) {
      const fields = {
        task_id: obj.task_id,
        task_type: obj.task_type,
        status: obj.status,
        patch_status: obj?.patch?.status,
        summary: obj.summary,
      };
      obs.taskEvents.push({ atMs: at(), subtype, ...fields });
      log('system', subtype, JSON.stringify(fields));
    }
    return;
  }

  if (type === 'assistant') {
    const text = textOf(obj.message).trim();
    if (!text) return;
    if (phase === 'injected' && text.includes('INJECTED_OK')) obs.sawInjectedAck = true;
    if (phase === 'awaiting-followup') obs.sawFollowupAssistant = true;
    log(`assistant(${phase}):`, JSON.stringify(text.slice(0, 160)));
    return;
  }

  if (type !== 'result') return;

  const usage = obj.usage || null;
  const record = {
    atMs: at(),
    phase,
    subtype,
    outputTokens: usage?.output_tokens,
    cacheRead: usage?.cache_read_input_tokens,
    costUsd: obj.total_cost_usd,
    text: String(obj.result || '').slice(0, 120),
  };
  obs.results.push(record);
  log(`RESULT #${obs.results.length} phase=${phase}`, JSON.stringify(record));

  if (obs.results.length === 1) afterFirstResult();
  else if (phase === 'injected') afterInjectedResult();
  else if (phase === 'awaiting-followup') afterFollowupResult();
}

let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type === 'stream_event') continue;   // partial token noise
    try { handle(obj); } catch (err) { log('handler error', err.message); }
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) log('stderr:', line.trim());
});

child.on('close', (code, signal) => {
  if (mainCloseTimer) clearTimeout(mainCloseTimer);
  obs.closedAt = at();
  obs.closeCode = `${code}/${signal}`;
  log('process close', obs.closeCode);
  if (phase !== 'stopping' || obs.stdinEndedAt === null) {
    finish('main process closed before the cleanup proof phase');
    return;
  }
  void runCleanupProofProbe()
    .then((result) => {
      obs.cleanupProof = result;
      finish('main process closed; cleanup proof probe completed');
    })
    .catch((err) => {
      obs.cleanupProof = { error: err instanceof Error ? err.message : String(err) };
      finish('cleanup proof probe failed');
    });
});

void writeInputRecord({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } })
  .catch((err) => log('initial write failed', err.message));
log('spawned claude', `model=${MODEL}`, `cwd=${CWD}`);

const overall = setTimeout(() => finish('overall timeout'), OVERALL_TIMEOUT_MS);

let cleanupChild = null;
let cleanupStarted = false;
function runCleanupProofProbe() {
  if (cleanupStarted) return Promise.reject(new Error('cleanup proof probe already started'));
  cleanupStarted = true;

  const proofName = 'orkas-cleanup-proof.txt';
  const proofPath = path.join(CWD, proofName);
  try { fs.unlinkSync(proofPath); } catch { /* absent is the expected initial state */ }

  const prompt = [
    'Run exactly this shell command as a BACKGROUND task (run_in_background: true):',
    '',
    `    sleep ${PROOF_SLEEP_SEC}; printf ORKAS_PROBE_CLEANUP_SURVIVED > ${proofName}`,
    '',
    'Then immediately end your turn by replying with the single word CLEANUP_STARTED.',
    'Do NOT wait for it. Do NOT poll it. Do NOT call any other tool.',
  ].join('\n');

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const result = {
      sawTaskStarted: false,
      sawResult: false,
      stdinEndedAt: null,
      closedAt: null,
      closeCode: null,
      proofExists: false,
      taskEvents: [],
      error: null,
    };
    let settled = false;
    let outputBuffer = '';
    let writes = Promise.resolve();
    let proofTimer = null;
    cleanupChild = spawn('claude', ARGS, { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });

    const cleanupWrite = (record) => {
      const line = `${JSON.stringify(record)}\n`;
      const write = writes.then(() => new Promise((accept, reject) => {
        if (!cleanupChild || cleanupChild.stdin.destroyed || !cleanupChild.stdin.writable) {
          reject(new Error('cleanup probe stdin is no longer writable'));
          return;
        }
        cleanupChild.stdin.write(line, (err) => (err ? reject(err) : accept()));
      }));
      writes = write.catch(() => {});
      return write;
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (proofTimer) clearTimeout(proofTimer);
      result.proofExists = fs.existsSync(proofPath);
      log('fact 6 — cleanup proof observation:', JSON.stringify(result));
      resolve(result);
    };

    const scheduleProofObservation = () => {
      if (proofTimer) return;
      const waitMs = (PROOF_SLEEP_SEC * 1_000) + 3_000;
      proofTimer = setTimeout(settle, waitMs);
    };

    const handleCleanup = (obj) => {
      const type = String(obj?.type || '');
      const subtype = String(obj?.subtype || '');
      if (type === 'control_request') {
        void cleanupWrite({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: obj.request_id,
            response: { behavior: 'allow', updatedInput: obj?.request?.input || {} },
          },
        }).catch(() => {});
        return;
      }
      if (type === 'system' && /^task|background/i.test(subtype)) {
        result.taskEvents.push({ subtype, task_id: obj.task_id, status: obj.status });
        if (/started/i.test(subtype) || /started|running/i.test(String(obj.status || ''))) {
          result.sawTaskStarted = true;
        }
        log('cleanup system', subtype, JSON.stringify(result.taskEvents.at(-1)));
        return;
      }
      if (type !== 'result' || result.sawResult) return;
      result.sawResult = true;
      result.stdinEndedAt = Date.now() - startedAt;
      log('fact 6 — cleanup probe terminal result; calling stdin.end() with task live');
      try { cleanupChild?.stdin.end(); } catch { /* already closed */ }
      scheduleProofObservation();
    };

    cleanupChild.stdout.setEncoding('utf8');
    cleanupChild.stdout.on('data', (chunk) => {
      outputBuffer += chunk;
      let newline;
      while ((newline = outputBuffer.indexOf('\n')) >= 0) {
        const line = outputBuffer.slice(0, newline).trim();
        outputBuffer = outputBuffer.slice(newline + 1);
        if (!line) continue;
        try { handleCleanup(JSON.parse(line)); } catch { /* ignore non-protocol output */ }
      }
    });
    cleanupChild.stderr.setEncoding('utf8');
    cleanupChild.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) log('cleanup stderr:', line.trim());
      }
    });
    cleanupChild.on('error', (err) => {
      result.error = err.message;
      settle();
    });
    cleanupChild.on('close', (code, signal) => {
      result.closedAt = Date.now() - startedAt;
      result.closeCode = `${code}/${signal}`;
      log('cleanup process close', result.closeCode);
      if (!result.sawResult) settle();
    });

    const timeout = setTimeout(() => {
      result.error = `cleanup proof timeout after ${Math.ceil(OVERALL_TIMEOUT_MS / 2_000)}s`;
      try { cleanupChild?.kill('SIGKILL'); } catch { /* already closed */ }
      settle();
    }, Math.max(60_000, Math.floor(OVERALL_TIMEOUT_MS / 2)));

    void cleanupWrite({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }).catch((err) => {
      result.error = err.message;
      settle();
    });
    log('spawned cleanup proof claude', `sleep=${PROOF_SLEEP_SEC}s`, `proof=${proofName}`);
  });
}

let finished = false;
function finish(why) {
  if (finished) return;
  finished = true;
  clearTimeout(overall);
  if (mainCloseTimer) clearTimeout(mainCloseTimer);

  const injected = obs.results.find(r => r.phase === 'injected');
  const followup = obs.results.find(r => r.phase === 'awaiting-followup');
  const facts = {
    '1_lingers_past_result': obs.aliveAfterResult1[2_000] === true ? 'YES'
      : (obs.aliveAfterResult1[500] === true ? 'PARTIAL(<2s)' : 'NO'),
    '2_task_completion_triggers_followup_turn': obs.sawFollowupAssistant || followup ? 'YES' : 'NO',
    '3_followup_has_own_result_and_usage': followup
      ? (followup.outputTokens > 0 ? 'YES' : 'RESULT-BUT-NO-USAGE') : 'NO',
    '4_inject_during_linger_starts_turn': obs.injectWrite === 'ok'
      ? (obs.sawInjectedAck ? 'YES' : 'WRITE-OK-BUT-NO-ACK') : `WRITE-${obs.injectWrite}`,
    '5_interrupt_control_request_accepted': obs.interruptResponse ? 'YES' : 'NO-RESPONSE',
    '6_stdin_end_closes_and_kills_live_task': evaluateStdinCleanupFact(obs, obs.cleanupProof),
  };

  console.log('\n===== PROBE VERDICT =====');
  console.log(JSON.stringify({
    why,
    facts,
    results: obs.results,
    taskEvents: obs.taskEvents,
    systemSubtypes: [...obs.systemSubtypes].sort(),
    interruptResponse: obs.interruptResponse,
    cleanupProof: obs.cleanupProof,
  }, null, 2));
  const failed = Object.entries(facts).filter(([, v]) => !String(v).startsWith('YES'));
  console.log(failed.length
    ? `\nFAILED: ${failed.map(([k]) => k).join(', ')} — see docs/plans/cli-background-runs.md §9 (capability downgrade).`
    : '\nAll six protocol facts hold. Baseline in docs/plans/cli-background-runs.md §2.1.');

  try { child.stdin.end(); } catch { /* already closed */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  try { cleanupChild?.stdin.end(); } catch { /* already closed */ }
  try { cleanupChild?.kill('SIGKILL'); } catch { /* already gone */ }
  setTimeout(() => process.exit(failed.length ? 1 : 0), 400);
}
