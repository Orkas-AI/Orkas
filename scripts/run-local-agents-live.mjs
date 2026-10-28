import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalAgentLauncher } from './local-agent-live-launcher.mjs';
import { localAgentChildEnv } from './local-agent-live-proxy-env.mjs';
import { localAgentLiveUsage, parseLiveArgs } from './local-agent-live-support.mjs';

const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));

export async function runLocalAgentLive(argv, { launch = runLocalAgentLauncher, env = process.env } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${localAgentLiveUsage()}\n`);
    return 0;
  }
  if (argv.includes('--claude-codex')) {
    const { runClaudeCodexLive } = await import('./run-claude-codex-live.mjs');
    return runClaudeCodexLive(argv.filter(arg => arg !== '--claude-codex'), { env });
  }
  parseLiveArgs(argv);
  return launch({ argv, childEnv: localAgentChildEnv(env), electronBin: require('electron'),
    electronEntry: path.join(directory, 'local-agent-live-electron-entry.mjs'),
    runner: path.join(directory, 'local-agent-live-electron-main.mts'), cwd: path.dirname(directory),
    disableGpu: true,
    reportsDir: path.join(directory, '..', 'test-results', 'local-agents') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLocalAgentLive(process.argv.slice(2));
}
