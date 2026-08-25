/**
 * Structural detection for commands that can change state outside the local
 * conversation workspace: databases, remote hosts/files, deployed services,
 * external APIs, registries, and infrastructure control planes.
 *
 * Keep this deliberately narrower than a keyword scan. A word such as
 * "DELETE" in `echo`, documentation, or a search pattern is not an action.
 */

export type ExternalMutationKind =
  | 'database_write'
  | 'remote_command'
  | 'remote_file_write'
  | 'service_change'
  | 'deployment_change'
  | 'external_api_write'
  | 'remote_publish'
  | 'external_launch';

export interface ExternalMutationFinding {
  kind: ExternalMutationKind;
  action: string;
  target?: string;
}

const HELP_FLAGS = new Set(['--help', '-h', '-?', '/?', '--version']);
const CURL_WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const CURL_WRITE_FLAGS = new Set([
  '-d', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode',
  '-F', '--form', '--form-string', '-T', '--upload-file', '--json',
  '-body', '-infile', '-form',
]);
const SSH_OPTIONS_WITH_VALUE = new Set([
  '-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-R', '-S', '-W', '-w',
]);
const DATABASE_CLIENTS = new Set(['mysql', 'mysql.exe', 'mariadb', 'psql', 'sqlcmd', 'sqlcmd.exe', 'mongosh', 'mongo']);
const SQL_ARG_FLAGS = new Set(['-e', '--execute', '-c', '--command', '-q', '--query']);
const SERVICE_ACTIONS = new Set(['restart', 'reload', 'start', 'stop', 'enable', 'disable', 'delete']);

const SQL_WRITE_RE = /\b(insert\s+into|update\s+[a-z0-9_$"`.\[\]-]+\s+set|delete\s+from|replace\s+into|merge\s+into|upsert\b|create\s+(?:table|index|view|schema|database|user|role)\b|alter\s+(?:table|view|schema|database|user|role)\b|drop\s+(?:table|index|view|schema|database|user|role)\b|truncate\s+(?:table\s+)?|grant\s+|revoke\s+|rename\s+table\b)\b/i;

function commandName(raw: string): string {
  return (raw.split(/[\\/]/).pop() || raw).toLowerCase();
}

function cleanTarget(raw: string | undefined): string | undefined {
  const value = String(raw || '').trim().replace(/^[`'"\[]|[`'"\],;)]$/g, '');
  if (!value || value.includes('$(') || value.includes('${')) return undefined;
  return value.slice(0, 120);
}

function sqlFinding(text: string): ExternalMutationFinding | null {
  const match = SQL_WRITE_RE.exec(text);
  if (!match) return null;
  const phrase = match[1].toLowerCase().replace(/\s+/g, ' ');
  const action = phrase.split(' ')[0];
  const statement = text.slice(match.index);
  const target = cleanTarget(
    /(?:insert\s+into|update|delete\s+from|replace\s+into|merge\s+into)\s+([a-z0-9_$"`.\[\]-]+)/i.exec(statement)?.[1]
      || /(?:create|alter|drop|truncate|rename)\s+(?:(?:table|index|view|schema|database|user|role)\s+)?(?:if\s+(?:not\s+)?exists\s+)?([a-z0-9_$"`.\[\]-]+)/i.exec(statement)?.[1],
  );
  return { kind: 'database_write', action, ...(target ? { target } : {}) };
}

function firstAction(args: readonly string[], optionsWithValues: ReadonlySet<string> = new Set()): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    if (optionsWithValues.has(arg)) { index++; continue; }
    if (arg.startsWith('-')) continue;
    return arg.toLowerCase();
  }
  return undefined;
}

function hasHelp(args: readonly string[]): boolean {
  return args.some((arg) => HELP_FLAGS.has(arg.toLowerCase()));
}

function databaseMutation(args: readonly string[]): ExternalMutationFinding | null {
  for (let i = 0; i < args.length; i++) {
    const lower = args[i].toLowerCase();
    if (SQL_ARG_FLAGS.has(lower) && args[i + 1]) {
      const finding = sqlFinding(args[i + 1]);
      if (finding) return finding;
      i++;
      continue;
    }
    const equal = /^(?:--execute|--command|--query)=(.*)$/is.exec(args[i]);
    if (equal) {
      const finding = sqlFinding(equal[1]);
      if (finding) return finding;
    }
  }
  return null;
}

function curlMutation(args: readonly string[]): ExternalMutationFinding | null {
  if (hasHelp(args)) return null;
  for (let i = 0; i < args.length; i++) {
    const lower = args[i].toLowerCase();
    if ((lower === '-x' || lower === '--request' || lower === '-method') && CURL_WRITE_METHODS.has((args[i + 1] || '').toLowerCase())) {
      return { kind: 'external_api_write', action: (args[i + 1] || '').toUpperCase() };
    }
    const method = /^(?:--request=|--method=)(post|put|patch|delete)$/i.exec(args[i]);
    if (method) return { kind: 'external_api_write', action: method[1].toUpperCase() };
    if (CURL_WRITE_FLAGS.has(args[i]) || CURL_WRITE_FLAGS.has(lower) || lower.startsWith('--data=') || lower.startsWith('--form=') || lower.startsWith('--upload-file=')) {
      return { kind: 'external_api_write', action: lower.includes('upload') || args[i] === '-T' ? 'UPLOAD' : 'POST' };
    }
  }
  return null;
}

function remoteDestination(args: readonly string[]): string | undefined {
  if (args.some((arg) => arg === '--dry-run' || arg === '-n')) return undefined;
  let endOfFlags = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (!endOfFlags && arg === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && arg.startsWith('-')) continue;
    operands.push(arg);
  }
  const destination = operands.at(-1);
  if (!destination || /^[a-z][a-z0-9+.-]*:\/\//i.test(destination) || /^[a-z]:[\\/]/i.test(destination)) return undefined;
  return /^[^\s/:]+@[^\s:]+:.+|^[a-z0-9_.-]+:.+/i.test(destination) ? cleanTarget(destination) : undefined;
}

function sshPayload(args: readonly string[]): { host?: string; command?: string } {
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { index++; break; }
    if (!arg.startsWith('-')) break;
    if (SSH_OPTIONS_WITH_VALUE.has(arg)) index++;
  }
  const host = cleanTarget(args[index]);
  const command = args.slice(index + 1).join(' ').trim();
  return { host, ...(command ? { command } : {}) };
}

interface ShellStage {
  words: string[];
  redirectTargets: string[];
}

function shellStages(command: string): ShellStage[] {
  const raw = command.match(/"(?:\\.|[^"])*"|'[^']*'|&&|\|\||>>|[;&|>]|[^\s;&|>]+/g) || [];
  const stages: ShellStage[] = [];
  let words: string[] = [];
  let redirectTargets: string[] = [];
  let expectRedirect = false;
  const flush = () => {
    if (words.length || redirectTargets.length) stages.push({ words, redirectTargets });
    words = [];
    redirectTargets = [];
    expectRedirect = false;
  };
  for (const token of raw) {
    if (new Set([';', '&&', '||', '&', '|']).has(token)) { flush(); continue; }
    if (token === '>' || token === '>>') { expectRedirect = true; continue; }
    const value = token.replace(/^['"]|['"]$/g, '');
    if (expectRedirect) { redirectTargets.push(value); expectRedirect = false; continue; }
    words.push(value);
  }
  flush();
  return stages;
}

function effectiveRemoteCommand(words: readonly string[]): { cmd: string; args: string[] } | null {
  let remaining = [...words];
  const optionsWithValues = new Set([
    '-C', '-D', '-g', '-h', '-p', '-R', '-T', '-u', '--chdir', '--close-from',
    '--group', '--host', '--prompt', '--role', '--type', '--unset', '--user',
  ]);
  while (remaining.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(remaining[0])) remaining.shift();
  while (remaining.length) {
    const wrapper = commandName(remaining[0]);
    if (!new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup']).has(wrapper)) break;
    remaining.shift();
    while (remaining.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(remaining[0])) { remaining.shift(); continue; }
      if (remaining[0] === '--') { remaining.shift(); break; }
      if (!remaining[0].startsWith('-')) break;
      const option = remaining.shift()!;
      if (optionsWithValues.has(option) && remaining.length) remaining.shift();
    }
  }
  if (!remaining.length) return null;
  return { cmd: commandName(remaining[0]), args: remaining.slice(1) };
}

function shellLikeMutation(command: string): ExternalMutationFinding | null {
  const text = command.trim();
  if (!text || /(?:^|\s)--dry-run(?:\s|=|$)/i.test(text)) return null;
  for (const stage of shellStages(text)) {
    const effective = effectiveRemoteCommand(stage.words);
    if (!effective) continue;
    const direct = classifyExternalMutationCommand(effective.cmd, effective.args);
    if (direct) return direct;
    if (stage.redirectTargets.length) {
      const target = cleanTarget(stage.redirectTargets.at(-1));
      return { kind: 'remote_command', action: 'redirect', ...(target ? { target } : {}) };
    }
    const { cmd, args } = effective;
    if (new Set(['rm', 'mv', 'cp', 'install', 'chmod', 'chown', 'truncate']).has(cmd) && !hasHelp(args)) {
      const target = cleanTarget(args.filter((arg) => !arg.startsWith('-')).at(-1));
      return { kind: 'remote_command', action: cmd, ...(target ? { target } : {}) };
    }
    if (cmd === 'sed' && args.some((arg) => /^-[a-z]*i[a-z]*$/i.test(arg) || arg === '--in-place')) {
      const target = cleanTarget(args.filter((arg) => !arg.startsWith('-')).at(-1));
      return { kind: 'remote_command', action: 'sed', ...(target ? { target } : {}) };
    }
    if (cmd === 'tee' && !hasHelp(args)) {
      const target = cleanTarget(args.filter((arg) => !arg.startsWith('-')).at(-1));
      return { kind: 'remote_command', action: 'tee', ...(target ? { target } : {}) };
    }
  }
  return null;
}

/** Classify one already-tokenized executable and its quote-stripped args. */
export function classifyExternalMutationCommand(cmdRaw: string, args: readonly string[]): ExternalMutationFinding | null {
  const cmd = commandName(cmdRaw);
  const dryRun = args.some((arg) => arg === '--dry-run' || arg.startsWith('--dry-run='));

  if ((cmd === 'open' || cmd === 'xdg-open') && !hasHelp(args)) {
    const target = cleanTarget(args.find((arg) => arg && !arg.startsWith('-')));
    return target ? { kind: 'external_launch', action: 'open', target } : null;
  }
  if (cmd === 'gio' && args[0]?.toLowerCase() === 'open' && !hasHelp(args)) {
    const target = cleanTarget(args.slice(1).find((arg) => arg && !arg.startsWith('-')));
    return target ? { kind: 'external_launch', action: 'open', target } : null;
  }
  if (cmd === 'start-process' && !hasHelp(args)) {
    const optionsWithValues = new Set(['-argumentlist', '-credential', '-filepath', '-redirectstandarderror', '-redirectstandardinput', '-redirectstandardoutput', '-verb', '-windowstyle', '-workingdirectory']);
    let target: string | undefined;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const lower = arg.toLowerCase();
      if (optionsWithValues.has(lower)) {
        if (lower === '-filepath') target = cleanTarget(args[index + 1]);
        index++;
        continue;
      }
      if (!arg.startsWith('-') && !target) target = cleanTarget(arg);
    }
    return target ? { kind: 'external_launch', action: 'start', target } : null;
  }

  if (DATABASE_CLIENTS.has(cmd)) {
    if (args.some((arg) => arg === '--help' || arg === '--version' || arg === '-?')) return null;
    return databaseMutation(args);
  }
  if (cmd === 'curl' || cmd === 'curl.exe' || cmd === 'invoke-restmethod' || cmd === 'irm' || cmd === 'invoke-webrequest' || cmd === 'iwr') {
    return curlMutation(args);
  }
  if (cmd === 'ssh' || cmd === 'ssh.exe') {
    const remote = sshPayload(args);
    if (!remote.command) return null;
    const nested = shellLikeMutation(remote.command);
    return nested ? { ...nested, target: nested.target || remote.host } : null;
  }
  if (cmd === 'scp' || cmd === 'scp.exe' || cmd === 'rsync') {
    const target = remoteDestination(args);
    return target ? { kind: 'remote_file_write', action: 'upload', target } : null;
  }
  if (cmd === 'service') {
    const target = cleanTarget(args.find((arg) => arg && !arg.startsWith('-')));
    const action = args.find((arg) => SERVICE_ACTIONS.has(arg.toLowerCase()))?.toLowerCase();
    if (action) return { kind: 'service_change', action, ...(target ? { target } : {}) };
  }
  if (cmd === 'systemctl' || cmd === 'supervisorctl' || cmd === 'pm2') {
    const actionIndex = args.findIndex((arg) => SERVICE_ACTIONS.has(arg.toLowerCase()));
    if (actionIndex >= 0) {
      const action = args[actionIndex].toLowerCase();
      const target = cleanTarget(args.slice(actionIndex + 1).find((arg) => arg && !arg.startsWith('-')));
      return { kind: 'service_change', action, ...(target ? { target } : {}) };
    }
  }
  if (cmd === 'kubectl') {
    if (dryRun) return null;
    const action = firstAction(args, new Set([
      '--context', '--cluster', '--user', '--namespace', '-n', '--kubeconfig', '--server', '-s',
      '--token', '--as', '--as-group', '--request-timeout', '--cache-dir',
    ]));
    const rolloutIndex = args.findIndex((arg) => arg.toLowerCase() === 'rollout');
    const mutatingRollout = rolloutIndex >= 0
      && new Set(['restart', 'undo', 'pause', 'resume']).has((args[rolloutIndex + 1] || '').toLowerCase());
    if (action && (new Set(['apply', 'create', 'delete', 'edit', 'patch', 'replace', 'scale', 'set', 'taint', 'label', 'annotate', 'cordon', 'uncordon', 'drain']).has(action) || mutatingRollout)) {
      return { kind: 'deployment_change', action: mutatingRollout ? `rollout ${args[rolloutIndex + 1].toLowerCase()}` : action };
    }
  }
  if (cmd === 'helm') {
    if (dryRun) return null;
    const action = firstAction(args, new Set([
      '--namespace', '-n', '--kube-context', '--kubeconfig', '--registry-config',
      '--repository-cache', '--repository-config',
    ]));
    if (action && new Set(['install', 'upgrade', 'uninstall', 'rollback']).has(action)) return { kind: 'deployment_change', action };
  }
  if (cmd === 'terraform' || cmd === 'tofu') {
    const action = firstAction(args);
    if (action && new Set(['apply', 'destroy', 'import', 'taint', 'untaint']).has(action)) return { kind: 'deployment_change', action };
  }
  if (cmd === 'ansible-playbook') {
    if (dryRun || args.some((arg) => new Set(['--check', '--syntax-check', '--list-hosts', '--list-tasks', '--list-tags']).has(arg.toLowerCase()))) return null;
    return { kind: 'deployment_change', action: 'run playbook' };
  }
  if (cmd === 'git' && args.some((arg) => arg.toLowerCase() === 'push') && !args.some((arg) => arg.toLowerCase() === '--dry-run' || arg.toLowerCase() === '-n')) {
    return { kind: 'remote_publish', action: 'push' };
  }
  if ((cmd === 'docker' || cmd === 'podman') && args[0]?.toLowerCase() === 'push') return { kind: 'remote_publish', action: 'push image' };
  if ((cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') && !dryRun && new Set(['publish', 'unpublish']).has((args[0] || '').toLowerCase())) {
    return { kind: 'remote_publish', action: args[0].toLowerCase() };
  }
  if (cmd === 'gh' && args[0]?.toLowerCase() === 'release' && new Set(['create', 'delete', 'edit', 'upload']).has((args[1] || '').toLowerCase())) {
    return { kind: 'remote_publish', action: `release ${args[1].toLowerCase()}` };
  }
  if (cmd === 'vercel' && !dryRun && !hasHelp(args)) {
    const action = firstAction(args);
    if (!action || new Set(['deploy', 'promote', 'rollback', 'remove']).has(action)) {
      return { kind: 'deployment_change', action: action || 'deploy' };
    }
    if ((action === 'env' || action === 'alias' || action === 'domains')
      && args.some((arg) => new Set(['add', 'rm', 'remove', 'set']).has(arg.toLowerCase()))) {
      return { kind: 'deployment_change', action: `${action} change` };
    }
  }
  return null;
}

function literalCallArguments(source: string, callPattern: RegExp): string[] {
  const results: string[] = [];
  for (const match of source.matchAll(callPattern)) {
    const value = match[1] || match[2] || match[3];
    if (value) results.push(value.replace(/\\(['"`\\])/g, '$1'));
  }
  return results;
}

function isOutputOnlyLine(line: string): boolean {
  const start = /^\s*(?:print|console\.(?:log|info|warn|error))\s*\(/.exec(line);
  if (!start) return false;
  let depth = 1;
  let quote = '';
  let escaped = false;
  for (let index = start[0].length; index < line.length; index++) {
    const char = line[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '(') depth++;
    if (char !== ')') continue;
    depth--;
    if (depth === 0) return /^\s*;?\s*$/.test(line.slice(index + 1));
  }
  return false;
}

function sourceWithoutNonExecutableExamples(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  return withoutBlocks.split(/\r?\n/).filter((line) => (
    !/^\s*(?:#|\/\/|\*)/.test(line) && !isOutputOnlyLine(line)
  )).join('\n');
}

function assignedLiteral(source: string, variable: string): string | undefined {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = '\\b' + escaped + '\\s*=\\s*(?:[rubf]{0,2})?'
    + '(?:"""([\\s\\S]{1,4000}?)"""|\'\'\'([\\s\\S]{1,4000}?)\'\'\''
    + '|\'([^\'\\n]{1,4000})\'|"([^"\\n]{1,4000})"|`([^`]{1,4000})`)';
  const match = new RegExp(pattern, 'i').exec(source);
  return match?.[1] || match?.[2] || match?.[3] || match?.[4] || match?.[5];
}

/**
 * Inspect script source for concrete write APIs. This intentionally requires
 * an executable call shape (execute/exec_command/upload/HTTP verb), so a SQL
 * migration mentioned only in a comment or README string does not prompt.
 */
export function classifyExternalMutationScript(sourceRaw: string): ExternalMutationFinding[] {
  const source = sourceWithoutNonExecutableExamples(String(sourceRaw || ''));
  const findings: ExternalMutationFinding[] = [];
  const add = (finding: ExternalMutationFinding | null) => {
    if (!finding) return;
    if (!findings.some((item) => item.kind === finding.kind && item.action === finding.action && item.target === finding.target)) findings.push(finding);
  };

  const executeCalls = /(?:\.\s*(?:execute|executemany|query)|\bmysqli_query)\s*\(\s*(?:[rubf]{0,2})?(?:'([^'\n]{1,4000})'|"([^"\n]{1,4000})"|`([^`]{1,4000})`)/gim;
  for (const literal of literalCallArguments(source, executeCalls)) add(sqlFinding(literal));

  const remoteExecCalls = /\.\s*(?:exec_command|execCommand)\s*\(\s*(?:[rubf]{0,2})?(?:'([^'\n]{1,4000})'|"([^"\n]{1,4000})"|`([^`]{1,4000})`)/gim;
  for (const literal of literalCallArguments(source, remoteExecCalls)) {
    add(shellLikeMutation(literal));
    for (const interpolation of literal.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g)) {
      const value = assignedLiteral(source, interpolation[1]);
      if (value) add(sqlFinding(value) || shellLikeMutation(value));
    }
  }

  const variableSink = /(?:\.\s*(?:execute|executemany|query|exec_command|execCommand)|\bmysqli_query)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\b/gim;
  for (const match of source.matchAll(variableSink)) {
    const value = assignedLiteral(source, match[1]);
    if (value) add(sqlFinding(value) || shellLikeMutation(value));
  }

  if (/(?:\bsftp\s*\.\s*put|\.\s*(?:upload_file|uploadFile|put_object|upload_fileobj))\s*\(/i.test(source)
    && /\b(?:sftp|paramiko|boto3|ssh2|scp)\b/i.test(source)) {
    add({ kind: 'remote_file_write', action: 'upload' });
  }
  const httpCall = /\b(?:requests|httpx|axios)\s*\.\s*(post|put|patch|delete)\s*\(|\bfetch\s*\([^)]{0,1000}\bmethod\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.exec(source);
  if (httpCall) add({ kind: 'external_api_write', action: (httpCall[1] || httpCall[2]).toUpperCase() });

  return findings;
}

/** Find literal script entrypoints that the shell command will execute. */
function referencedExecutableScriptsInternal(command: string, depth: number): string[] {
  const results: string[] = [];
  const add = (raw: string | undefined) => {
    const value = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
    if (value && !results.includes(value)) results.push(value);
  };
  const rawWords = command.match(/"(?:\\.|[^"])*"|'[^']*'|&&|\|\||[;&|]|[^\s;&|]+/g) || [];
  const words = rawWords.map((raw) => raw.replace(/^['"]|['"]$/g, ''));
  const separators = new Set([';', '&&', '||', '&', '|']);
  const interpreters = /^(?:python(?:3(?:\.\d+)?)?|py|node|ruby|perl|php|bash|dash|ksh|sh|zsh|pwsh|powershell)(?:\.exe)?$/i;
  const posixShells = /^(?:bash|dash|ksh|sh|zsh)(?:\.exe)?$/i;
  const powerShells = /^(?:pwsh|powershell)(?:\.exe)?$/i;
  const scriptExtension = /\.(?:py|js|cjs|mjs|ts|rb|pl|php|sh|bash|zsh|ps1)$/i;
  const optionsWithValues = new Set([
    '-w', '-x', '-q', '--require', '--import', '--loader', '--conditions',
    '-executionpolicy', '-windowstyle', '-workingdirectory',
  ]);
  for (let i = 0; i < words.length; i++) {
    const current = words[i];
    const executable = commandName(current);
    if (scriptExtension.test(current) && (/^(?:\.\.?[\\/]|[A-Za-z]:[\\/])/.test(current) || i === 0 || separators.has(words[i - 1]))) {
      add(current);
      continue;
    }
    if (!interpreters.test(executable)) continue;
    if (depth < 4 && (posixShells.test(executable) || powerShells.test(executable))) {
      const commandIndex = words.findIndex((word, index) => (
        index > i && (posixShells.test(executable)
          ? /^-[a-z]*c[a-z]*$/i.test(word)
          : /^(?:-command|-c)$/i.test(word))
      ));
      if (commandIndex >= 0 && words[commandIndex + 1]) {
        for (const nested of referencedExecutableScriptsInternal(words[commandIndex + 1], depth + 1)) add(nested);
        continue;
      }
    }
    for (let j = i + 1; j < words.length && !separators.has(words[j]); j++) {
      const candidate = words[j];
      const lower = candidate.toLowerCase();
      if (lower === '-c' || lower === '--command' || lower === '-e' || lower === '--eval' || lower === '-m' || lower === '--module') break;
      if ((lower === '-file' || lower === '-f') && words[j + 1]) {
        if (scriptExtension.test(words[j + 1])) add(words[j + 1]);
        break;
      }
      if (optionsWithValues.has(lower)) { j++; continue; }
      if (candidate.startsWith('-')) continue;
      if (scriptExtension.test(candidate)) add(candidate);
      break;
    }
  }
  return results;
}

export function referencedExecutableScripts(command: string): string[] {
  return referencedExecutableScriptsInternal(command, 0);
}
