/**
 * Pure helpers for the opt-in local-agent live test.
 *
 * Keep this module free of Orkas imports so its install orchestration can be
 * unit-tested without loading paths.ts or touching a real user data root.
 */

import * as path from 'node:path';

export const LOCAL_AGENT_TYPES = Object.freeze([
  'claude',
  'codex',
  'openclaw',
  'opencode',
  'hermes',
]);

export const LOCAL_AGENT_ENV_KEYS = Object.freeze({
  claude: 'ORKAS_CLAUDE_PATH',
  codex: 'ORKAS_CODEX_PATH',
  openclaw: 'ORKAS_OPENCLAW_PATH',
  opencode: 'ORKAS_OPENCODE_PATH',
  hermes: 'ORKAS_HERMES_PATH',
});

const BIN_NAMES = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  openclaw: 'openclaw',
  opencode: 'opencode',
  hermes: 'hermes',
});

const NPM_PACKAGES = Object.freeze({
  claude: '@anthropic-ai/claude-code@latest',
  codex: '@openai/codex@latest',
  openclaw: 'openclaw@latest',
  opencode: 'opencode-ai@latest',
});

function assertAgentType(type) {
  if (!LOCAL_AGENT_TYPES.includes(type)) {
    throw new Error(`unknown local agent type: ${type}`);
  }
  return type;
}

function parseAgentCsv(raw) {
  const values = String(raw || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0 || values.includes('all')) return [...LOCAL_AGENT_TYPES];
  return [...new Set(values.map(assertAgentType))];
}

export function parseLiveArgs(argv) {
  const result = {
    agents: [...LOCAL_AGENT_TYPES],
    installMissing: true,
    installOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-install') {
      result.installMissing = false;
      continue;
    }
    if (arg === '--install-only') {
      result.installOnly = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--agents') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--agents requires a comma-separated value');
      result.agents = parseAgentCsv(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--agents=')) {
      result.agents = parseAgentCsv(arg.slice('--agents='.length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

/**
 * Return an explicit, shell-free install plan. npm-backed CLIs are installed
 * under a test-only prefix. Hermes' official installer is downloaded first,
 * then executed as a second step so a failed download is never piped to bash.
 */
export function installerPlan(type, options) {
  assertAgentType(type);
  const {
    platform,
    installRoot,
    downloadDir,
  } = options;
  if (type !== 'hermes') {
    // One prefix per CLI: repeated `npm install --no-save` calls against a
    // shared prefix can prune a package installed by an earlier step.
    const npmRoot = path.join(installRoot, 'npm', type);
    return [{
      command: platform === 'win32' ? 'npm.cmd' : 'npm',
      args: [
        'install',
        '--prefix', npmRoot,
        '--no-save',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        NPM_PACKAGES[type],
      ],
    }];
  }

  const hermesHome = path.join(installRoot, 'hermes-home');
  if (platform === 'win32') {
    const installer = path.join(downloadDir, 'hermes-install.ps1');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Invoke-WebRequest -UseBasicParsing 'https://hermes-agent.nousresearch.com/install.ps1' -OutFile '${installer.replaceAll("'", "''")}'`,
      `& '${installer.replaceAll("'", "''")}' -SkipSetup`,
    ].join('; ');
    return [{
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      env: {
        HERMES_HOME: hermesHome,
        LOCALAPPDATA: path.join(installRoot, 'windows-localappdata'),
      },
    }];
  }

  const installer = path.join(downloadDir, 'hermes-install.sh');
  return [
    {
      command: 'curl',
      args: ['-fsSL', 'https://hermes-agent.nousresearch.com/install.sh', '-o', installer],
    },
    {
      command: 'bash',
      args: [
        installer,
        '--skip-setup',
        '--skip-browser',
        '--dir', path.join(installRoot, 'hermes'),
        '--hermes-home', hermesHome,
      ],
      env: { HERMES_HOME: hermesHome },
    },
  ];
}

export function managedBinaryCandidates(type, { platform, installRoot }) {
  assertAgentType(type);
  const bin = BIN_NAMES[type];
  if (type !== 'hermes') {
    const name = platform === 'win32' ? `${bin}.cmd` : bin;
    return [
      path.join(installRoot, 'npm', type, 'node_modules', '.bin', name),
      // Compatibility with the first test-managed layout used before the
      // per-agent prefixes were split.
      path.join(installRoot, 'npm', 'node_modules', '.bin', name),
    ];
  }
  if (platform === 'win32') {
    return [
      path.join(installRoot, 'windows-localappdata', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
      path.join(installRoot, 'windows-localappdata', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.cmd'),
      path.join(installRoot, 'hermes', 'venv', 'Scripts', 'hermes.exe'),
    ];
  }
  return [
    path.join(installRoot, 'hermes', 'venv', 'bin', 'hermes'),
    path.join(installRoot, 'hermes', '.venv', 'bin', 'hermes'),
    path.join(installRoot, 'hermes', 'hermes'),
  ];
}

/**
 * Detect -> bind cached managed install -> install -> detect. The callbacks
 * make the state machine deterministic and cheap to unit test.
 */
export async function ensureRequestedAgents(options) {
  const {
    agents,
    installMissing,
    detect,
    bindCached,
    install,
  } = options;
  const resolved = [];
  for (const rawType of agents) {
    const type = assertAgentType(rawType);
    let entry = await detect(type);
    if (!entry?.available && await bindCached(type)) {
      entry = await detect(type);
    }
    if (!entry?.available && installMissing) {
      await install(type, entry || null);
      entry = await detect(type);
    }
    if (!entry?.available) {
      const detail = entry?.errorDetail || entry?.error || 'not found';
      throw new Error(`${type} is unavailable after preparation: ${detail}`);
    }
    resolved.push(entry);
  }
  return resolved;
}

export function classifyLiveFailure(result) {
  const text = `${result?.error || ''}\n${result?.output || ''}\n${result?.stderrTail || ''}`.toLowerCase();
  if (/401|oauth|authenticat|sign[ -]?in|log[ -]?in|api[ _-]?key|credential|no provider available|provider.+(missing|not configured)/.test(text)) {
    return 'authentication';
  }
  if (result?.status === 'missing_cli') return 'installation';
  return 'runtime';
}

export function summarizeLiveFailure(result) {
  const combined = `${result?.output || ''}\n${result?.stderrTail || ''}\n${result?.error || ''}`;
  const usefulPatterns = [
    /Failed to authenticate[^\n]*/i,
    /401[^\n]*/i,
    /no Nous authentication[^\n]*/i,
    /no provider available[^\n]*/i,
    /(?:missing|set|configure)[^\n]{0,80}API[ _-]?key[^\n]*/i,
  ];
  for (const pattern of usefulPatterns) {
    const match = pattern.exec(combined);
    if (match) return match[0].replace(/\s+/g, ' ').trim();
  }
  return String(result?.output || result?.error || result?.status || 'unknown failure')
    .replace(/\s+/g, ' ')
    .trim();
}
