/**
 * Risk classifier for the `bash` tool, used by access modes that require
 * sensitive-operation approval (features/permissions.ts). It answers ONE question: "does this command
 * warrant a user confirmation before running?"
 *
 * Design principle — match command structure, not broad keywords. This runs on
 * a default-on surface, so we avoid text-only matches that would flag routine
 * commands like `npm ls`; however, dependency changes and actual shell delete
 * commands are sensitive because they can execute untrusted code or mutate
 * durable state directly.
 *
 * Six categories:
 *   - network_egress  — explicit shell network access, including downloads.
 *   - destructive     — shell/Git deletion and rollback, process termination,
 *                       plus dd / mkfs / disk tools / fork bombs.
 *   - priv_esc        — elevation or a persistent security-boundary weakening.
 *   - sensitive_path  — credential & key files (any access), persistence /
 *                       autostart locations (writes), /etc writes. Excludes
 *                       `.env`, broad `~/.config`, /etc reads, and the macOS
 *                       user dirs (Documents/Desktop/Downloads).
 *   - system_package_change — native system package and project dependency
 *                       changes. Read-only discovery operations pass.
 *   - external_mutation — writes to databases, remote hosts/files, deployed
 *                       services, external APIs, registries, or control planes.
 *
 * Known gap (accepted for v1): a command name fully hidden behind command
 * substitution (`$(echo cu)rl ...`) is not decomposed. The common exfil
 * shape (`curl .../$(cat secret)`) is still caught because the visible
 * leading command is `curl` and the sensitive path token is matched too.
 *
 * Pure / synchronous / no fs — this is path math + string matching only, so
 * it stays unit-testable without Electron and cheap to call per command.
 */

import {
  classifyExternalMutationCommand,
  classifyExternalMutationScript,
  type ExternalMutationFinding,
} from './external-mutation-risk';

export type RiskCategory =
  | 'network_egress'
  | 'destructive'
  | 'priv_esc'
  | 'sensitive_path'
  | 'system_package_change'
  | 'external_mutation';

export interface RiskResult {
  risky: boolean;
  reasons: RiskCategory[];
  externalMutations: ExternalMutationFinding[];
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

type Tok = { type: 'word'; value: string } | { type: 'op'; value: string };

const TWO_CHAR_OPS = new Set(['&&', '||', '>>', '|&', '2>']);
const ONE_CHAR_OPS = new Set(['|', '&', ';', '>', '<', '(', ')', '\n']);

/** Best-effort shell tokenizer. Quote-strips single/double quotes, honors
 *  backslash escapes, and emits control/redirection operators as separate
 *  tokens. Command substitution `$(...)` / backticks are NOT expanded — they
 *  remain literal inside word tokens, which is what the matchers want. */
function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let cur = '';
  let hasCur = false;
  const flush = () => { if (hasCur) { toks.push({ type: 'word', value: cur }); cur = ''; hasCur = false; } };

  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];

    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) { cur += input.slice(i + 1); hasCur = true; i = n; break; }
      cur += input.slice(i + 1, end); hasCur = true; i = end + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let buf = '';
      while (j < n && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < n) {
          const next = input[j + 1];
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            buf += next;
            j += 2;
            continue;
          }
          // In double-quoted POSIX shell text, backslash before an ordinary
          // letter stays literal. Preserving it is also essential for
          // Windows paths such as "C:\Users\test\.ssh\id_rsa".
          buf += '\\';
          j++;
          continue;
        }
        buf += input[j]; j++;
      }
      cur += buf; hasCur = true; i = (j < n ? j + 1 : n); continue;
    }
    if (c === '\\') {
      if (i + 1 < n) {
        const next = input[i + 1];
        if (next === ' ' || next === '\t' || next === '\r' || next === '\n'
          || next === '"' || next === "'" || next === '\\' || ONE_CHAR_OPS.has(next)) {
          cur += next;
          hasCur = true;
          i += 2;
        } else {
          cur += '\\';
          hasCur = true;
          i++;
        }
      } else {
        cur += '\\';
        hasCur = true;
        i++;
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }

    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { flush(); toks.push({ type: 'op', value: two }); i += 2; continue; }
    if (ONE_CHAR_OPS.has(c)) { flush(); toks.push({ type: 'op', value: c === '\n' ? ';' : c }); i++; continue; }

    cur += c; hasCur = true; i++;
  }
  flush();
  return toks;
}

const SEGMENT_SEPS = new Set([';', '&&', '||', '&']);
const PIPE_OPS = new Set(['|', '|&']);
const REDIR_OUT_OPS = new Set(['>', '>>']);

interface Stage {
  /** Word tokens of this pipeline stage (quote-stripped). */
  words: string[];
}
interface Segment {
  stages: Stage[];
  /** Targets of `>` / `>>` redirections anywhere in the segment. */
  redirectTargets: string[];
  /** Raw substring flags: did the original segment contain `$(` or a backtick. */
  hasSubstitution: boolean;
}

/** Split the token stream into segments (on `;` `&&` `||` `&`), each segment
 *  into pipeline stages (on `|`), and collect redirection targets. */
function parse(input: string): Segment[] {
  const toks = tokenize(input);
  const segments: Segment[] = [];
  let curStages: Stage[] = [];
  let curWords: string[] = [];
  let redirects: string[] = [];
  let expectRedirectTarget = false;

  const endStage = () => { if (curWords.length) { curStages.push({ words: curWords }); curWords = []; } };
  const endSegment = () => {
    endStage();
    if (curStages.length || redirects.length) {
      segments.push({ stages: curStages, redirectTargets: redirects, hasSubstitution: false });
    }
    curStages = []; redirects = [];
  };

  for (const t of toks) {
    if (t.type === 'op') {
      if (SEGMENT_SEPS.has(t.value)) { endSegment(); expectRedirectTarget = false; continue; }
      if (PIPE_OPS.has(t.value)) { endStage(); expectRedirectTarget = false; continue; }
      if (REDIR_OUT_OPS.has(t.value)) { expectRedirectTarget = true; continue; }
      // other ops ('<','(',')','2>') ignored for risk purposes
      expectRedirectTarget = false;
      continue;
    }
    if (expectRedirectTarget) { redirects.push(t.value); expectRedirectTarget = false; continue; }
    curWords.push(t.value);
  }
  endSegment();

  // Substitution presence is cheap to detect on the raw string per segment is
  // overkill; flag at the whole-command level by re-scanning the input once.
  const hasSub = input.includes('$(') || input.includes('`');
  for (const s of segments) s.hasSubstitution = hasSub;
  return segments;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function basename(cmd: string): string {
  const noSlash = cmd.split('/').pop() || cmd;
  return noSlash.toLowerCase();
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'setsid']);
const XARGS_FLAGS_WITH_ARG = new Set(['-n', '-i', '-i{}', '-l', '-p', '-s', '-d', '-e', '-c']);

/** Peel leading env-assignments and benign wrappers to find the command that
 *  actually runs, plus its args. Handles `env A=1 B=2 curl ...`, `nohup rm`,
 *  and `xargs rm -rf` (the command xargs invokes). Returns null if nothing
 *  resolvable remains. */
function effectiveCommand(words: string[]): { cmd: string; args: string[] } | null {
  let w = words.slice();
  // strip leading env assignments
  while (w.length && ENV_ASSIGN.test(w[0])) w = w.slice(1);
  if (!w.length) return null;
  let cmd = basename(w[0]);

  if (cmd === 'env') {
    w = w.slice(1);
    while (w.length && (ENV_ASSIGN.test(w[0]) || w[0].startsWith('-'))) w = w.slice(1);
    if (!w.length) return null;
    cmd = basename(w[0]);
  }
  if (WRAPPERS.has(cmd)) {
    w = w.slice(1);
    while (w.length && ENV_ASSIGN.test(w[0])) w = w.slice(1);
    if (!w.length) return null;
    cmd = basename(w[0]);
  }
  if (cmd === 'xargs') {
    // Skip xargs and its flags to reach the command it invokes.
    let k = 1;
    while (k < w.length) {
      const tok = w[k];
      if (!tok.startsWith('-')) break;
      // flags that consume a following value
      if (XARGS_FLAGS_WITH_ARG.has(tok)) { k += 2; continue; }
      k++;
    }
    w = w.slice(k);
    if (!w.length) return null;
    cmd = basename(w[0]);
  }
  return { cmd, args: w.slice(1) };
}

const POWERSHELL_CMDS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const CMD_SHELL_CMDS = new Set(['cmd', 'cmd.exe']);
const POSIX_SHELL_CMDS = new Set(['bash', 'bash.exe', 'dash', 'dash.exe', 'ksh', 'ksh.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe']);

function unwrapCommandShell(
  cmd: string,
  args: string[],
): { command: string; opaque: boolean } | null {
  const lower = args.map((arg) => arg.toLowerCase());
  if (POSIX_SHELL_CMDS.has(cmd)) {
    const marker = lower.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
    if (marker >= 0 && marker + 1 < args.length) {
      return { command: args[marker + 1], opaque: false };
    }
    return null;
  }
  if (POWERSHELL_CMDS.has(cmd)) {
    if (lower.some((arg) => arg === '-encodedcommand' || arg === '-enc' || arg === '-e')) {
      return { command: '', opaque: true };
    }
    const marker = lower.findIndex((arg) => arg === '-command' || arg === '-c');
    if (marker >= 0 && marker + 1 < args.length) {
      return { command: args.slice(marker + 1).join(' '), opaque: false };
    }
    return null;
  }
  if (CMD_SHELL_CMDS.has(cmd)) {
    const marker = lower.findIndex((arg) => arg === '/c' || arg === '/k');
    if (marker >= 0 && marker + 1 < args.length) {
      return { command: args.slice(marker + 1).join(' '), opaque: false };
    }
  }
  return null;
}

function inlineProgramSource(cmd: string, args: string[]): string | undefined {
  const flags = cmd === 'node' || cmd === 'node.exe'
    ? new Set(['-e', '--eval'])
    : cmd === 'php' || cmd === 'php.exe'
      ? new Set(['-r'])
      : /^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/i.test(cmd)
        ? new Set(['-c'])
        : /^(?:ruby|perl)(?:\.exe)?$/i.test(cmd)
          ? new Set(['-e'])
          : null;
  if (!flags) return undefined;
  const index = args.findIndex((arg) => flags.has(arg.toLowerCase()));
  if (index >= 0) return args[index + 1];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if ((cmd === 'node' || cmd === 'node.exe') && lower.startsWith('--eval=')) return arg.slice('--eval='.length);
    if (flags.has('-e') && /^-e[^-]/i.test(arg)) return arg.slice(2);
    if (flags.has('-c') && /^-c[^-]/i.test(arg)) return arg.slice(2);
    if (flags.has('-r') && /^-r[^-]/i.test(arg)) return arg.slice(2);
  }
  return undefined;
}

function effectivePrivilegeCommand(args: string[]): { cmd: string; args: string[] } | null {
  const optionsWithValues = new Set([
    '-C', '-D', '-g', '-h', '-p', '-R', '-T', '-u', '--chdir', '--close-from',
    '--group', '--host', '--prompt', '--role', '--type', '--user',
  ]);
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') { index++; break; }
    if (!arg.startsWith('-')) break;
    index += optionsWithValues.has(arg) ? 2 : 1;
  }
  return effectiveCommand(args.slice(index));
}

function isFlag(w: string): boolean { return w.startsWith('-'); }

function commandOperands(args: string[]): string[] {
  const out: string[] = [];
  let endOfFlags = false;
  for (const a of args) {
    if (!endOfFlags && a === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && isFlag(a)) continue;
    out.push(a);
  }
  return out;
}

// ── Category matchers ────────────────────────────────────────────────────────

const PRIV_ESC_CMDS = new Set(['sudo', 'su', 'doas', 'pkexec']);
const WINDOWS_PRIV_ESC_CMDS = new Set(['runas', 'runas.exe', 'gsudo', 'gsudo.exe']);

const NET_DOWNLOADERS = new Set(['curl', 'wget', 'fetch']);
const RAW_SOCKET_CMDS = new Set(['nc', 'ncat', 'netcat', 'telnet', 'socat']);
const REMOTE_COPY_CMDS = new Set(['scp', 'sftp', 'rsync']);
const SHELL_INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe',
  'python', 'python3', 'perl', 'ruby', 'node',
]);
const CURL_UPLOAD_FLAGS = new Set([
  '-d', '--data', '--data-binary', '--data-raw', '--data-urlencode',
  '-F', '--form', '-T', '--upload-file', '--post-file', '--post-data',
]);
const POWERSHELL_WEB_CMDS = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const POWERSHELL_EXEC_CMDS = new Set(['invoke-expression', 'iex']);

function looksRemote(arg: string): boolean {
  // user@host:path or host:path, but not a url scheme (http://) or windows
  // drive (C:\). Require a ':' that isn't part of '://'.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return false;
  return /^[^/\s:]+@[^/\s:]+:|^[A-Za-z0-9_.-]+:[^\\]/.test(arg) && arg.includes(':');
}

function hasHelpOrVersion(args: readonly string[]): boolean {
  return args.some((arg) => new Set(['--help', '-h', '-?', '/?', '--version']).has(arg.toLowerCase()));
}

function gitAction(args: readonly string[]): { action?: string; index: number } {
  const optionsWithValues = new Set(['-c', '-C', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') { index++; break; }
    if (!arg.startsWith('-')) break;
    if (optionsWithValues.has(arg)) { index += 2; continue; }
    if (/^--(?:config-env|exec-path|git-dir|namespace|super-prefix|work-tree)=/.test(arg)) { index++; continue; }
    index++;
  }
  return { action: args[index]?.toLowerCase(), index };
}

function matchGitNetwork(args: readonly string[]): boolean {
  const { action, index } = gitAction(args);
  if (action === 'clone') {
    const optionsWithValues = new Set(['-b', '--branch', '--depth', '--filter', '-j', '--jobs', '-o', '--origin', '--reference', '--reference-if-able', '--separate-git-dir', '--server-option', '-u', '--upload-pack']);
    let source: string | undefined;
    const rest = args.slice(index + 1);
    for (let offset = 0; offset < rest.length; offset++) {
      const arg = rest[offset];
      if (optionsWithValues.has(arg)) { offset++; continue; }
      if (arg.startsWith('-')) continue;
      source = arg;
      break;
    }
    return Boolean(source && (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || looksRemote(source)));
  }
  if (action === 'archive') return args.slice(index + 1).some((arg) => arg === '--remote' || arg.startsWith('--remote='));
  return Boolean(action && new Set(['fetch', 'pull', 'push', 'ls-remote', 'send-email']).has(action));
}

function matchToolNetwork(cmd: string, args: readonly string[]): boolean {
  if (hasHelpOrVersion(args)) return false;
  const lower = args.map((arg) => arg.toLowerCase());
  if (cmd === 'git') return matchGitNetwork(args);
  if (cmd === 'gh' || cmd === 'glab') return lower.some((arg) => !arg.startsWith('-'));
  if (cmd === 'docker' || cmd === 'podman') {
    return ['pull', 'login', 'search'].includes(lower[0] || '');
  }
  if (cmd === 'npm' || cmd === 'pnpm') {
    return new Set(['view', 'info', 'show', 'search', 'audit', 'outdated', 'ping']).has(lower[0] || '');
  }
  if (cmd === 'pip' || cmd === 'pip3') return new Set(['download', 'index']).has(lower[0] || '');
  return false;
}

function matchNetwork(cmd: string, args: string[], seg: Segment): boolean {
  if (RAW_SOCKET_CMDS.has(cmd)) return true;
  if (cmd === 'ssh') return args.length > 0; // ssh host [cmd] — remote exec
  if (REMOTE_COPY_CMDS.has(cmd)) return args.some(looksRemote);
  if (matchToolNetwork(cmd, args)) return true;
  if (NET_DOWNLOADERS.has(cmd)) {
    if (hasHelpOrVersion(args)) return false;
    if (args.some((arg) => !arg.startsWith('-'))) return true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (CURL_UPLOAD_FLAGS.has(a)) return true;
      if (a.startsWith('--data') || a.startsWith('--form') || a.startsWith('--upload-file') || a.startsWith('--post')) return true;
      if (a.includes('@') && !a.startsWith('-')) return true; // -d @file collapsed, or form file=@path
      if ((a === '-X' || a === '--request') && /^(post|put|patch|delete)$/i.test(args[i + 1] || '')) return true;
      if (/^--method=(post|put|patch|delete)$/i.test(a)) return true;
    }
    // command substitution in a downloader segment ⇒ likely URL exfil
    if (seg.hasSubstitution) return true;
  }
  if (POWERSHELL_WEB_CMDS.has(cmd)) {
    if (hasHelpOrVersion(args)) return false;
    const lower = args.map((arg) => arg.toLowerCase());
    for (let i = 0; i < lower.length; i++) {
      const arg = lower[i];
      if (arg === '-body' || arg === '-infile' || arg === '-form') return true;
      if (arg === '-method' && /^(post|put|patch|delete)$/.test(lower[i + 1] || '')) return true;
      if (/^-method:(post|put|patch|delete)$/.test(arg)) return true;
    }
    return args.some((arg, index) => (
      (!arg.startsWith('-') && lower[index - 1] !== '-outfile')
      || /^(?:-uri|-url):/i.test(arg)
      || ((lower[index - 1] === '-uri' || lower[index - 1] === '-url') && Boolean(arg))
    ));
  }
  return false;
}

/** Pipe-to-shell: a downloader stage feeding an interpreter stage. */
function matchPipeToShell(seg: Segment): boolean {
  let sawDownloader = false;
  for (const stage of seg.stages) {
    const eff = effectiveCommand(stage.words);
    if (!eff) continue;
    if (sawDownloader && (SHELL_INTERPRETERS.has(eff.cmd) || POWERSHELL_EXEC_CMDS.has(eff.cmd))) return true;
    if (NET_DOWNLOADERS.has(eff.cmd) || POWERSHELL_WEB_CMDS.has(eff.cmd) || eff.cmd === 'fetch') {
      sawDownloader = true;
    }
  }
  return false;
}

const RAW_DEVICE_RE = /^\/dev\/(sd|hd|nvme|disk|rdisk|mapper)/i;
const POSIX_PROCESS_TERMINATORS = new Set(['kill', 'pkill', 'killall']);
const SIGNAL_NAME_RE = /^-(?:sig)?(?:abrt|alrm|bus|chld|cld|cont|emt|fpe|hup|ill|info|int|io|iot|kill|lost|pipe|poll|prof|pwr|quit|segv|stkflt|stop|sys|term|trap|tstp|ttin|ttou|urg|usr1|usr2|vtalrm|winch|xcpu|xfsz)$/i;

function hasRecursiveFlag(args: string[]): boolean {
  return args.some((a) => a === '--recursive' || (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)));
}

/** Return the last explicit POSIX signal selector, if any. Later selectors
 *  win in the common implementations, so `kill -0 -TERM 1234` must not be
 *  mistaken for a read-only signal-zero probe. */
function explicitProcessSignal(args: string[]): string | null {
  let signal: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();
    if (lower === '-s' || lower === '--signal') {
      if (i + 1 < args.length) signal = args[++i].toLowerCase().replace(/^sig/, '');
      continue;
    }
    if (lower.startsWith('--signal=')) {
      signal = lower.slice('--signal='.length).replace(/^sig/, '');
      continue;
    }
    if (/^-\d+$/.test(lower) || SIGNAL_NAME_RE.test(lower)) {
      signal = lower.slice(1).replace(/^sig/, '');
    }
  }
  return signal;
}

/** Find actual POSIX process selectors while excluding signal syntax. Other
 *  option values deliberately count: e.g. `pkill -u alice` really does select
 *  and terminate processes even without a trailing pattern. */
function processTerminationTargets(args: string[]): string[] {
  const targets: string[] = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();
    if (!endOfFlags && arg === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && (lower === '-s' || lower === '--signal')) { i++; continue; }
    if (!endOfFlags && (lower.startsWith('--signal=') || /^-\d+$/.test(lower) || SIGNAL_NAME_RE.test(lower))) {
      continue;
    }
    if (!endOfFlags && isFlag(arg)) continue;
    targets.push(arg);
  }
  return targets;
}

function matchProcessTermination(cmd: string, args: string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  const hasHelp = lower.some((arg) => arg === '--help' || arg === '--version' || arg === '-?' || arg === '/?');
  if (hasHelp) return false;

  if (cmd === 'taskkill' || cmd === 'taskkill.exe') {
    return lower.some((arg, index) => (
      ((arg === '/pid' || arg === '/im') && Boolean(args[index + 1]) && !args[index + 1].startsWith('/'))
      || /^\/(?:pid|im):.+/i.test(arg)
    ));
  }

  if (cmd === 'stop-process') {
    if (lower.some((arg) => arg === '-whatif' || arg === '-whatif:$true')) return false;
    // Like Remove-Item, Stop-Process accepts pipeline input and may therefore
    // terminate a process even without an explicit operand in this stage.
    return true;
  }

  if (!POSIX_PROCESS_TERMINATORS.has(cmd)) return false;
  if (lower.some((arg) => arg === '-l' || arg === '--list')) return false;
  const targets = processTerminationTargets(args);
  if (!targets.length) return false;
  const signal = explicitProcessSignal(args);
  return signal === null || !/^0+$/.test(signal);
}

function matchDestructiveGit(args: readonly string[]): boolean {
  if (hasHelpOrVersion(args)) return false;
  const { action, index } = gitAction(args);
  if (!action) return false;
  const rest = args.slice(index + 1).map((arg) => arg.toLowerCase());
  if (action === 'reset') return rest.some((arg) => arg === '--hard' || arg === '--merge' || arg === '--keep');
  if (action === 'clean') return !rest.some((arg) => arg === '-n' || arg === '--dry-run' || /^-[^-]*n/.test(arg));
  if (action === 'checkout') return rest.includes('--') || rest.some((arg) => arg === '-f' || arg === '--force');
  if (action === 'switch') return rest.some((arg) => arg === '-f' || arg === '--force' || arg === '--discard-changes');
  if (action === 'restore') {
    if (rest.some((arg) => arg === '--worktree')) return true;
    return !rest.some((arg) => arg === '--staged');
  }
  if (action === 'branch' || action === 'tag') {
    return rest.some((arg) => arg === '-d' || arg === '--delete' || /^-[^-]*d/.test(arg));
  }
  if (action === 'stash') return rest.some((arg) => arg === 'drop' || arg === 'clear');
  if (action === 'reflog') return rest.some((arg) => arg === 'expire' || arg === 'delete');
  if (action === 'prune') return true;
  if (action === 'gc') return rest.some((arg) => arg === '--aggressive' || /^--prune(?:=now)?$/.test(arg));
  return false;
}

function matchDestructive(cmd: string, args: string[], seg: Segment): boolean {
  if (matchProcessTermination(cmd, args)) return true;
  if (cmd === 'git' && matchDestructiveGit(args)) return true;
  if (cmd === 'rm') {
    if (args.some((a) => a === '--help' || a === '--version')) return false;
    const targets = commandOperands(args);
    if (targets.length) return true;
    if (hasRecursiveFlag(args)) return true; // `rm -rf` with no clear target / glob removed by shell
  }
  if (cmd === 'rmdir' || cmd === 'unlink') {
    if (args.some((a) => a === '--help' || a === '--version')) return false;
    if (commandOperands(args).length) return true;
  }
  if (cmd === 'dd') return true;
  if (/^mkfs/.test(cmd)) return true;
  if (cmd === 'shred' || cmd === 'fdisk' || cmd === 'parted' || cmd === 'sgdisk') return true;
  if (cmd === 'remove-item' || cmd === 'del' || cmd === 'erase' || cmd === 'rd' || cmd === 'clear-content') {
    if (args.some((arg) => arg === '-?' || arg === '/?' || arg === '--help')) return false;
    // PowerShell accepts pipeline input, so `Get-ChildItem | Remove-Item`
    // remains destructive even when this stage has no explicit operand.
    return true;
  }
  if (cmd === 'clear-disk' || cmd === 'format-volume' || cmd === 'initialize-disk'
    || cmd === 'remove-partition' || cmd === 'diskpart' || cmd === 'format') return true;
  // redirect / dd into a raw device
  if (seg.redirectTargets.some((t) => RAW_DEVICE_RE.test(t))) return true;
  if (cmd === 'tee' && args.some((t) => RAW_DEVICE_RE.test(t))) return true;
  return false;
}

// Credential / key material — sensitive on ANY access (read is exfil prep).
const CRED_PATH_RES: RegExp[] = [
  /(^|\/)\.ssh\//i,
  /(^|\/)\.ssh$/i,
  /(^|\/)\.aws\/credentials/i,
  /(^|\/)\.config\/gcloud/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.docker\/config\.json/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.kube\/config/i,
  /\bid_(rsa|dsa|ecdsa|ed25519)\b/i,
  /\.pem$/i,
  /\/Keychains\//i,
  /login\.keychain/i,
];

// Persistence / autostart — sensitive on WRITE.
const PERSIST_PATH_RES: RegExp[] = [
  /(^|\/)\.(bashrc|bash_profile|zshrc|zprofile|profile)$/i,
  /(^|\/)\.ssh\/authorized_keys/i,
  /\/LaunchAgents\//i,
  /\/LaunchDaemons\//i,
  /\/etc\/cron/i,
  /(^|\/)\.config\/systemd/i,
  /\/etc\/systemd/i,
  /(^|\/)\.config\/autostart/i,
  /\/Start Menu\/Programs\/Startup/i,
];

const WRITE_CMDS = new Set([
  'tee', 'cp', 'mv', 'ln', 'install', 'rsync', 'dd',
  'set-content', 'add-content', 'out-file', 'new-item', 'copy-item', 'move-item',
]);

function matchSensitive(cmd: string, args: string[], seg: Segment, allWords: string[]): boolean {
  // macOS keychain dumping tool
  if (cmd === 'security' && args.some((a) => /^(dump-keychain|find-generic-password|find-internet-password|export)$/.test(a))) {
    return true;
  }
  // crontab install (-, or a file arg) ⇒ persistence
  if (cmd === 'crontab' && (args.includes('-') || args.some((a) => !isFlag(a)))) return true;
  if ((cmd === 'cmdkey' || cmd === 'cmdkey.exe') && args.some((arg) => /^\/list/i.test(arg))) return true;
  if ((cmd === 'vaultcmd' || cmd === 'vaultcmd.exe') && args.some((arg) => /^\/listcreds/i.test(arg))) return true;

  // credential/key material: any token referencing it
  for (const w of allWords) {
    const normalized = w.replace(/\\/g, '/');
    if (CRED_PATH_RES.some((re) => re.test(normalized))) return true;
  }

  // persistence/autostart + /etc: only when this segment WRITES.
  const writes = seg.redirectTargets.length > 0 || WRITE_CMDS.has(cmd);
  if (writes) {
    const writeTargets = [...seg.redirectTargets, ...args.filter((a) => !isFlag(a))]
      .map((target) => target.replace(/\\/g, '/'));
    for (const t of writeTargets) {
      if (PERSIST_PATH_RES.some((re) => re.test(t))) return true;
      if (/^\/etc\//.test(t)) return true; // write under /etc (reads are not flagged)
    }
  }
  const normalizedArgs = args.join(' ').replace(/\\/g, '/');
  if (cmd === 'reg' || cmd === 'reg.exe') {
    if (args[0]?.toLowerCase() === 'add'
      && /\/CurrentVersion\/Run(?:Once)?(?:[\/\s]|$)/i.test(normalizedArgs)) return true;
  }
  if ((cmd === 'schtasks' || cmd === 'schtasks.exe') && args.some((arg) => arg.toLowerCase() === '/create')) {
    return true;
  }
  if (cmd === 'register-scheduledtask' || cmd === 'new-scheduledtask'
    || cmd === 'set-scheduledtask') return true;
  if ((cmd === 'set-itemproperty' || cmd === 'new-itemproperty')
    && /\/CurrentVersion\/Run(?:Once)?(?:[\/\s]|$)/i.test(normalizedArgs)) return true;
  return false;
}

function chmodWidensAccess(args: readonly string[]): boolean {
  if (hasHelpOrVersion(args)) return false;
  const mode = args.find((arg) => !arg.startsWith('-'));
  if (!mode) return false;
  if (/^[0-7]{3,4}$/.test(mode)) {
    const digits = mode.slice(-3).split('').map(Number);
    const special = mode.length === 4 && mode[0] !== '0';
    return special || (digits[1] & 2) !== 0 || (digits[2] & 2) !== 0;
  }
  return /(?:^|,)[augo]*\+[^,]*w/i.test(mode)
    || /(?:^|,)[ago]*=[^,]*w/i.test(mode)
    || /(?:^|,)[augo]*\+[^,]*[st]/i.test(mode);
}

function hasSecurityWeakeningAssignment(words: readonly string[]): boolean {
  return words.some((word) => (
    /^NODE_TLS_REJECT_UNAUTHORIZED=0$/i.test(word)
    || /^GIT_SSL_NO_VERIFY=(?:1|true|yes)$/i.test(word)
    || /^PYTHONHTTPSVERIFY=0$/i.test(word)
  ));
}

function matchSecurityWeakening(cmd: string, args: string[], originalWords: readonly string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  if (hasSecurityWeakeningAssignment(originalWords)) return true;
  if (cmd === 'chmod' && lower.some((arg) => arg === '--reference' || arg.startsWith('--reference='))) return true;
  if (cmd === 'chmod') return chmodWidensAccess(args);
  if (cmd === 'chown' || cmd === 'chgrp' || cmd === 'setfacl') return !hasHelpOrVersion(args);
  if ((cmd === 'curl' || cmd === 'curl.exe') && lower.some((arg) => arg === '-k' || arg === '--insecure')) return true;
  if (cmd === 'wget' && lower.includes('--no-check-certificate')) return true;
  if ((cmd === 'ssh' || cmd === 'scp' || cmd === 'sftp') && lower.some((arg, index) => (
    /^stricthostkeychecking=(?:no|off)$/i.test(arg)
    || /^userknownhostsfile=(?:\/dev\/null|nul)$/i.test(arg)
    || (arg === '-o' && /^(?:stricthostkeychecking=(?:no|off)|userknownhostsfile=(?:\/dev\/null|nul))$/i.test(lower[index + 1] || ''))
  ))) return true;
  if (cmd === 'git') {
    const joined = lower.join(' ');
    if (/https?\.sslverify(?:=|\s+)false\b/.test(joined)) return true;
    const { action, index } = gitAction(args);
    if (action === 'config') {
      const rest = lower.slice(index + 1).filter((arg) => !arg.startsWith('-'));
      if (rest.some((arg, i) => /^https?\.sslverify$/.test(arg) && rest[i + 1] === 'false')) return true;
    }
  }
  if ((cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn')
    && lower.includes('config') && lower.includes('strict-ssl') && lower.includes('false')) return true;
  if (cmd === 'spctl') return lower.some((arg) => arg === '--master-disable' || arg === '--global-disable');
  if (cmd === 'csrutil') return lower[0] === 'disable';
  if (cmd === 'pfctl') return lower.includes('-d');
  if (cmd === 'ufw') {
    return Boolean(lower[0] && !new Set(['status', 'show', 'version', 'help', '--help']).has(lower[0]));
  }
  if (cmd === 'iptables' || cmd === 'ip6tables') {
    const mutating = new Set([
      '-A', '--append', '-D', '--delete', '-I', '--insert', '-R', '--replace',
      '-F', '--flush', '-X', '--delete-chain', '-N', '--new-chain', '-P', '--policy',
      '-E', '--rename-chain', '-Z', '--zero',
    ]);
    return args.some((arg) => mutating.has(arg) || /^-[^-]*[ADIRFXNPEZ]/.test(arg));
  }
  if (cmd === 'netsh' || cmd === 'netsh.exe') {
    return lower.includes('advfirewall') && lower.some((arg) => new Set(['set', 'add', 'delete', 'reset', 'import']).has(arg));
  }
  if (new Set(['new-netfirewallrule', 'remove-netfirewallrule', 'set-netfirewallrule', 'set-netfirewallprofile']).has(cmd)) {
    return !lower.some((arg) => arg === '-whatif' || arg === '-whatif:$true');
  }
  if ((cmd === 'xattr' || cmd === 'xattr.exe') && lower.includes('-d') && lower.includes('com.apple.quarantine')) return true;
  return false;
}

function matchPrivilegeEscalation(cmd: string, args: string[], originalWords: readonly string[]): boolean {
  if (matchSecurityWeakening(cmd, args, originalWords)) return true;
  if (PRIV_ESC_CMDS.has(cmd) || WINDOWS_PRIV_ESC_CMDS.has(cmd)) return true;
  const lower = args.map((arg) => arg.toLowerCase());
  if (cmd === 'start-process') {
    return lower.some((arg, index) => (
      (arg === '-verb' && lower[index + 1] === 'runas') || arg === '-verb:runas'
    ));
  }
  if (cmd === 'set-executionpolicy') {
    return lower.some((arg) => arg === 'bypass' || arg === 'unrestricted');
  }
  if (cmd === 'add-mppreference') {
    return lower.some((arg) => arg.startsWith('-exclusion'));
  }
  if (cmd === 'set-mppreference') {
    return lower.some((arg, index) => (
      arg.startsWith('-exclusion')
      || (arg.startsWith('-disable') && /^(?:true|\$true|1)$/.test(lower[index + 1] || ''))
    ));
  }
  if (cmd === 'net' || cmd === 'net.exe') {
    if (lower[0] === 'user') return lower.some((arg) => arg === '/add' || arg === '/delete' || arg.startsWith('/active:'));
    if (lower[0] === 'localgroup' && lower[1] === 'administrators') {
      return lower.some((arg) => arg === '/add' || arg === '/delete');
    }
  }
  return false;
}

const SYSTEM_PACKAGE_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  winget: new Set(['install', 'upgrade', 'uninstall', 'remove', 'import', 'configure']),
  choco: new Set(['install', 'upgrade', 'uninstall']),
  chocolatey: new Set(['install', 'upgrade', 'uninstall']),
  scoop: new Set(['install', 'uninstall', 'update', 'reset', 'hold', 'unhold']),
  brew: new Set(['install', 'uninstall', 'remove', 'reinstall', 'upgrade', 'tap', 'untap', 'pin', 'unpin', 'bundle']),
  apt: new Set(['install', 'remove', 'purge', 'upgrade', 'full-upgrade', 'dist-upgrade', 'autoremove']),
  'apt-get': new Set(['install', 'remove', 'purge', 'upgrade', 'full-upgrade', 'dist-upgrade', 'autoremove']),
  dnf: new Set(['install', 'remove', 'erase', 'upgrade', 'update', 'downgrade', 'reinstall', 'distro-sync', 'autoremove']),
  yum: new Set(['install', 'remove', 'erase', 'upgrade', 'update', 'downgrade', 'reinstall', 'distro-sync', 'autoremove']),
  apk: new Set(['add', 'del', 'upgrade', 'fix']),
  zypper: new Set(['install', 'in', 'remove', 'rm', 'update', 'up', 'patch', 'dist-upgrade', 'dup', 'addrepo', 'ar', 'removerepo', 'rr', 'modifyrepo', 'mr']),
  pkg: new Set(['install', 'delete', 'remove', 'upgrade', 'autoremove', 'lock', 'unlock']),
  snap: new Set(['install', 'remove', 'refresh', 'revert', 'enable', 'disable']),
  flatpak: new Set(['install', 'uninstall', 'update', 'remote-add', 'remote-delete', 'remote-modify']),
  pipx: new Set(['install', 'uninstall', 'upgrade', 'upgrade-all', 'inject', 'uninject', 'reinstall', 'reinstall-all']),
  cargo: new Set(['install', 'uninstall']),
};

const SYSTEM_PACKAGE_READ_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  winget: new Set(['search', 'show', 'list', 'export', 'validate', 'hash', 'help']),
  choco: new Set(['search', 'find', 'list', 'info', 'help']),
  chocolatey: new Set(['search', 'find', 'list', 'info', 'help']),
  scoop: new Set(['search', 'list', 'info', 'status', 'which', 'help']),
  brew: new Set(['search', 'info', 'list', 'leaves', 'outdated', 'doctor', 'config', 'help']),
  apt: new Set(['list', 'search', 'show', 'satisfy', 'help']),
  'apt-get': new Set(['update', 'download', 'source', 'changelog', 'check', 'help']),
  dnf: new Set(['search', 'info', 'list', 'repoquery', 'check-update', 'history', 'help']),
  yum: new Set(['search', 'info', 'list', 'provides', 'check-update', 'history', 'help']),
  apk: new Set(['search', 'info', 'list', 'policy', 'stats', 'version', 'update', 'help']),
  zypper: new Set(['search', 'se', 'info', 'if', 'list-updates', 'lu', 'repos', 'lr', 'refresh', 'ref', 'help']),
  pkg: new Set(['search', 'info', 'which', 'version', 'audit', 'help']),
  snap: new Set(['find', 'info', 'list', 'changes', 'tasks', 'help']),
  flatpak: new Set(['search', 'list', 'info', 'remotes', 'history', 'help']),
  pipx: new Set(['list', 'environment', 'ensurepath', 'completions', 'help']),
  cargo: new Set(['search', 'info', 'help']),
};

function packageCommandName(cmd: string): string {
  return cmd.replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

function firstRecognizedAction(
  args: string[],
  mutating: ReadonlySet<string>,
  readonly: ReadonlySet<string> = new Set<string>(),
): string | null {
  for (const raw of args) {
    const arg = raw.toLowerCase();
    if (mutating.has(arg) || readonly.has(arg)) return arg;
  }
  return null;
}

function matchPacmanPackageChange(args: string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  if (lower.some((arg) => arg === '--remove' || arg === '--upgrade' || arg === '--sysupgrade')) return true;
  const syncQuery = lower.some((arg) => (
    arg === '--search' || arg === '--info' || arg === '--list' || arg === '--groups'
    || arg === '--print' || arg === '--downloadonly'
  ));
  if (lower.includes('--sync')) {
    return !syncQuery && lower.some((arg) => !arg.startsWith('-') && arg !== '--');
  }
  for (const arg of args) {
    if (!/^-[^-]/.test(arg)) continue;
    const flags = arg.slice(1);
    if (flags.includes('R') || flags.includes('U')) return true;
    if (!flags.includes('S')) continue;
    if (flags.includes('u')) return true;
    const queryOnly = /[silgpw]/.test(flags);
    if (!queryOnly && lower.some((item) => !item.startsWith('-'))) return true;
  }
  return false;
}

function matchSystemPackageChange(cmd: string, args: string[]): boolean {
  const command = packageCommandName(cmd);
  const lower = args.map((arg) => arg.toLowerCase());
  if (hasHelpOrVersion(args) || lower[0] === 'help') return false;

  // Project-local installers are included: install hooks and build backends
  // can execute code even when the resulting dependency stays in a workspace.
  // `python -m pip` is the common cross-platform spelling for pip.
  if (/^(?:python(?:3(?:\.\d+)?)?|py)$/.test(command)
    && lower[0] === '-m' && (lower[1] === 'pip' || lower[1] === 'pip3')) {
    return matchSystemPackageChange(lower[1], args.slice(2));
  }
  if (command === 'pip' || command === 'pip3') {
    const actions = new Set(['install', 'uninstall']);
    const action = firstRecognizedAction(
      args,
      actions,
      new Set(['list', 'show', 'check', 'freeze', 'download', 'index', 'inspect', 'help']),
    );
    return action !== null && actions.has(action);
  }

  if (command === 'npm' || command === 'pnpm') {
    const actions = command === 'npm'
      ? new Set(['install', 'i', 'add', 'ci', 'update', 'upgrade', 'uninstall', 'remove', 'rm', 'prune', 'dedupe', 'link'])
      : new Set(['install', 'i', 'add', 'update', 'up', 'uninstall', 'remove', 'rm', 'prune', 'dedupe', 'link', 'import', 'deploy']);
    const readonly = new Set(['list', 'ls', 'why', 'view', 'info', 'show', 'search', 'audit', 'outdated', 'ping', 'config', 'help', 'run']);
    const action = firstRecognizedAction(args, actions, readonly);
    if (action !== null && actions.has(action)) return true;
    if (command === 'npm') return lower[0] === 'exec';
    return lower[0] === 'dlx';
  }
  if (command === 'yarn') {
    return new Set(['install', 'add', 'remove', 'upgrade', 'up', 'dedupe', 'import', 'dlx']).has(lower[0] || '')
      || (lower[0] === 'global' && ['add', 'remove', 'upgrade'].includes(lower[1] || ''));
  }
  if (command === 'bun') {
    return new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'link']).has(lower[0] || '');
  }
  if (command === 'uv') {
    const toolIndex = lower.indexOf('tool');
    const pythonIndex = lower.indexOf('python');
    const actions = new Set(['install', 'uninstall', 'upgrade']);
    if (toolIndex >= 0) return actions.has(lower[toolIndex + 1] || '');
    if (pythonIndex >= 0) return actions.has(lower[pythonIndex + 1] || '');
    if (lower[0] === 'pip') return new Set(['install', 'uninstall', 'sync']).has(lower[1] || '');
    return new Set(['add', 'remove', 'sync', 'lock']).has(lower[0] || '');
  }
  if (command === 'npx' || command === 'bunx' || command === 'uvx') {
    if (!args.length || lower.some((arg) => arg === '-v' || arg === '--version')) return false;
    return lower.some((arg) => !arg.startsWith('-') || arg.startsWith('--package='));
  }
  if (command === 'poetry') return new Set(['add', 'remove', 'install', 'update', 'sync', 'lock']).has(lower[0] || '');
  if (command === 'pipenv') return new Set(['install', 'uninstall', 'update', 'sync', 'lock']).has(lower[0] || '');
  if (command === 'conda' || command === 'mamba' || command === 'micromamba') {
    return new Set(['create', 'install', 'remove', 'uninstall', 'update', 'upgrade']).has(lower[0] || '');
  }
  if (command === 'cargo') {
    if (lower[0] === 'install' && lower.includes('--list')) return false;
    return new Set(['install', 'uninstall', 'add', 'remove', 'update', 'fetch']).has(lower[0] || '');
  }
  if (command === 'go') return lower[0] === 'get'
    || (lower[0] === 'mod' && new Set(['tidy', 'download', 'vendor', 'edit']).has(lower[1] || ''));
  if (command === 'bundle' || command === 'bundler') {
    return new Set(['install', 'update', 'add', 'remove', 'lock', 'clean']).has(lower[0] || '');
  }
  if (command === 'gem') return new Set(['install', 'uninstall', 'update', 'cleanup']).has(lower[0] || '');
  if (command === 'composer') return new Set(['install', 'update', 'require', 'remove']).has(lower[0] || '');
  if (command === 'dotnet') {
    return lower[0] === 'restore'
      || (new Set(['add', 'remove']).has(lower[0] || '') && lower[1] === 'package')
      || (lower[0] === 'tool' && new Set(['install', 'update', 'uninstall', 'restore']).has(lower[1] || ''));
  }
  if (command === 'swift') return lower[0] === 'package' && new Set(['resolve', 'update']).has(lower[1] || '');
  if (command === 'corepack') return new Set(['enable', 'disable', 'install', 'prepare', 'use', 'up']).has(lower[0] || '');
  if (command === 'pacman') return matchPacmanPackageChange(args);
  if (command === 'winget' || command === 'choco' || command === 'chocolatey') {
    const upgradeIndex = lower.indexOf('upgrade');
    const primaryAction = command === 'winget'
      ? firstRecognizedAction(args, SYSTEM_PACKAGE_ACTIONS.winget, SYSTEM_PACKAGE_READ_ACTIONS.winget)
      : null;
    // Bare `winget upgrade` only lists available upgrades. A target or option
    // after the verb selects an actual upgrade operation.
    if (primaryAction === 'upgrade' && upgradeIndex >= 0) return lower.length > upgradeIndex + 1;
    const sourceIndex = lower.indexOf('source');
    if (sourceIndex >= 0) {
      return ['add', 'remove', 'update', 'reset', 'enable', 'disable'].includes(lower[sourceIndex + 1] || '');
    }
    const pinIndex = lower.indexOf('pin');
    if (pinIndex >= 0) return ['add', 'remove'].includes(lower[pinIndex + 1] || '');
  }
  if (command === 'scoop') {
    const bucketIndex = lower.indexOf('bucket');
    if (bucketIndex >= 0) return ['add', 'rm', 'remove'].includes(lower[bucketIndex + 1] || '');
  }
  if (command === 'add-apt-repository') {
    return !lower.some((arg) => arg === '--help' || arg === '-h' || arg === '--list');
  }
  const mutating = SYSTEM_PACKAGE_ACTIONS[command];
  if (!mutating) return false;
  const action = firstRecognizedAction(args, mutating, SYSTEM_PACKAGE_READ_ACTIONS[command]);
  return action !== null && mutating.has(action);
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Classify a bash command. Returns the set of risk categories it trips
 *  (deduped); `risky` is true when any category fires. */
function classifyBashCommandInternal(command: string, depth: number): RiskResult {
  const reasons = new Set<RiskCategory>();
  const externalMutations: ExternalMutationFinding[] = [];
  const cmd = String(command ?? '');
  if (!cmd.trim()) return { risky: false, reasons: [], externalMutations: [] };

  // Fork bomb — operator soup the tokenizer can't meaningfully decompose;
  // matched on the raw despaced string.
  const despaced = cmd.replace(/\s+/g, '');
  if (despaced.includes(':(){') || despaced.includes(':|:&')) reasons.add('destructive');

  const segments = parse(cmd);
  for (const seg of segments) {
    if (matchPipeToShell(seg)) reasons.add('network_egress');

    const allWords = seg.stages.flatMap((s) => s.words);

    for (const stage of seg.stages) {
      const eff = effectiveCommand(stage.words);
      if (!eff) continue;
      let { cmd: c, args } = eff;

      if (matchPrivilegeEscalation(c, args, stage.words)) {
        reasons.add('priv_esc');
        // inspect the inner command too: `sudo rm -rf /`
        if (PRIV_ESC_CMDS.has(c)) {
          const inner = effectivePrivilegeCommand(args);
          if (inner) { c = inner.cmd; args = inner.args; }
        }
      }

      // Privilege wrappers are peeled above so the inner operation can add
      // its own security-boundary reason as well (for example `sudo chmod`).
      if (matchSecurityWeakening(c, args, stage.words)) reasons.add('priv_esc');

      if (matchNetwork(c, args, seg)) reasons.add('network_egress');
      if (matchDestructive(c, args, seg)) reasons.add('destructive');
      if (matchSensitive(c, args, seg, allWords)) reasons.add('sensitive_path');
      if (matchSystemPackageChange(c, args)) reasons.add('system_package_change');
      const externalMutation = classifyExternalMutationCommand(c, args);
      if (externalMutation) {
        reasons.add('external_mutation');
        externalMutations.push(externalMutation);
      }
      const inlineSource = inlineProgramSource(c, args);
      if (inlineSource) {
        const inlineMutations = classifyExternalMutationScript(inlineSource);
        if (inlineMutations.length) reasons.add('external_mutation');
        externalMutations.push(...inlineMutations);
      }

      const wrapped = unwrapCommandShell(c, args);
      if (wrapped?.opaque) reasons.add('destructive');
      if (wrapped?.command && depth < 4) {
        const nested = classifyBashCommandInternal(wrapped.command, depth + 1);
        for (const reason of nested.reasons) reasons.add(reason);
        externalMutations.push(...nested.externalMutations);
      }
    }
  }

  return { risky: reasons.size > 0, reasons: [...reasons], externalMutations };
}

export function classifyBashCommand(command: string): RiskResult {
  return classifyBashCommandInternal(command, 0);
}
