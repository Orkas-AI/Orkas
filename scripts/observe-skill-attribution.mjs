#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SKILL_ID = 'e2e-test-skill';
const DEFAULT_TIMEOUT_SECONDS = 180;
const DEFAULT_POLL_INTERVAL_MS = 500;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TURN_ID = /^[^\u0000-\u001f\u007f]{1,512}$/;

export function parseObserverArgs(argv) {
  if (argv.length > 2) throw new Error('usage: observe-skill-attribution.sh [skill-id] [timeout-seconds]');
  const skillId = argv[0] || DEFAULT_SKILL_ID;
  if (!SAFE_ID.test(skillId)) throw new Error('skill id must use letters, digits, dot, underscore, or hyphen');
  const rawTimeout = argv[1] || String(DEFAULT_TIMEOUT_SECONDS);
  if (!/^\d+$/.test(rawTimeout)) throw new Error('timeout must be an integer number of seconds');
  const timeoutSeconds = Number(rawTimeout);
  if (timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error('timeout must be between 1 and 3600 seconds');
  }
  return { skillId, timeoutSeconds };
}

export function readActiveUserId(dataRoot, { fileSystem = fs } = {}) {
  const usersFile = path.join(dataRoot, 'users.json');
  let parsed;
  try {
    parsed = JSON.parse(fileSystem.readFileSync(usersFile, 'utf8'));
  } catch {
    throw new Error('users.json is missing or invalid');
  }
  const uid = String(parsed?.current_user_id || '');
  if (!SAFE_ID.test(uid)) throw new Error('current_user_id is missing or invalid');
  return uid;
}

export function localDay(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class SkillAttributionMatcher {
  constructor(expectedSkillId) {
    this.expectedSkillId = expectedSkillId;
    this.advertisedTurns = new Set();
    this.invokedTurns = new Set();
  }

  ingest(line) {
    let signal;
    try {
      signal = JSON.parse(line);
    } catch {
      return null;
    }
    if (!['skill_advertised', 'skill_invoked', 'agent_dispatched'].includes(signal?.type)) {
      return null;
    }
    const turnId = typeof signal.turn_id === 'string' && SAFE_TURN_ID.test(signal.turn_id)
      ? signal.turn_id
      : '';
    if (!turnId) return null;

    let matched = false;
    if (
      signal.type === 'skill_advertised'
      && Array.isArray(signal.delta?.skill_ids)
      && signal.delta.skill_ids.includes(this.expectedSkillId)
    ) {
      this.advertisedTurns.add(turnId);
      matched = true;
    } else if (
      signal.type === 'skill_invoked'
      && signal.delta?.skill_id === this.expectedSkillId
    ) {
      this.invokedTurns.add(turnId);
      matched = true;
    }

    let matchingTurn = null;
    if (matched) {
      const candidates = this.advertisedTurns.size <= this.invokedTurns.size
        ? this.advertisedTurns
        : this.invokedTurns;
      const other = candidates === this.advertisedTurns
        ? this.invokedTurns
        : this.advertisedTurns;
      matchingTurn = [...candidates].find((candidate) => other.has(candidate)) || null;
    }
    return {
      matched,
      matchingTurn,
      signal: {
        aid: typeof signal.aid === 'string' ? signal.aid.slice(0, 128) : null,
        turn_id: turnId,
        type: signal.type,
      },
    };
  }
}

export async function observeSkillAttribution({
  dataRoot,
  expectedSkillId,
  fileSystem = fs,
  log = console.log,
  logError = console.error,
  now = () => Date.now(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutSeconds,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  let uid;
  try {
    uid = readActiveUserId(dataRoot, { fileSystem });
  } catch (err) {
    logError(`[skill-attribution] ${err.message}`);
    return { code: 2, matchedTurn: null };
  }
  const signalFile = path.join(
    dataRoot,
    uid,
    'local',
    'signals',
    `${localDay(new Date(now()))}.jsonl`,
  );
  let offset = 0;
  try {
    offset = fileSystem.statSync(signalFile).size;
  } catch {
    // The observer is read-only. The app creates the directory/file when the
    // first signal is emitted.
  }
  const matcher = new SkillAttributionMatcher(expectedSkillId);
  let pending = Buffer.alloc(0);
  const deadline = now() + timeoutSeconds * 1000;

  log(`[skill-attribution] watching uid=${uid} skill=${expectedSkillId} baseline_bytes=${offset}`);
  while (now() < deadline) {
    await wait(pollIntervalMs);
    let bytes;
    try {
      bytes = fileSystem.readFileSync(signalFile);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      logError('[skill-attribution] signal file became unreadable');
      return { code: 2, matchedTurn: null };
    }
    if (bytes.length < offset) {
      offset = 0;
      pending = Buffer.alloc(0);
    }
    if (bytes.length === offset) continue;
    pending = Buffer.concat([pending, bytes.subarray(offset)]);
    offset = bytes.length;

    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      const rawLine = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      const line = rawLine.toString('utf8').replace(/\r$/, '');
      if (!line) continue;
      const observation = matcher.ingest(line);
      if (!observation) continue;
      log(JSON.stringify(observation.signal));
      if (observation.matched) {
        log(
          `[skill-attribution] ${observation.signal.type} matched `
          + `turn_id=${observation.signal.turn_id}`,
        );
      }
      if (observation.matchingTurn) {
        log(`[skill-attribution] PASS turn_id=${observation.matchingTurn}`);
        return { code: 0, matchedTurn: observation.matchingTurn };
      }
    }
  }

  logError(
    `[skill-attribution] TIMEOUT advertised_turns=${matcher.advertisedTurns.size} `
    + `invoked_turns=${matcher.invokedTurns.size}`,
  );
  return { code: 1, matchedTurn: null };
}

async function main() {
  let args;
  try {
    args = parseObserverArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[skill-attribution] ${err.message}`);
    process.exitCode = 2;
    return;
  }
  const dataRoot = process.env.ORKAS_DATA_ROOT
    ? path.resolve(process.env.ORKAS_DATA_ROOT)
    : path.join(os.homedir(), '.orkas', 'data');
  const result = await observeSkillAttribution({
    dataRoot,
    expectedSkillId: args.skillId,
    timeoutSeconds: args.timeoutSeconds,
  });
  process.exitCode = result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[skill-attribution] observer failed: ${err.message}`);
    process.exitCode = 2;
  });
}
