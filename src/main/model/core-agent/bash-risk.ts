/**
 * Risk classifier for the `bash` tool, used by access modes that require
 * sensitive-operation approval (features/permissions.ts). It answers ONE question: "does this command
 * warrant a user confirmation before running?"
 *
 * Design principle — match command structure, not broad keywords. This runs on
 * a default-on surface, so we avoid text-only matches that would flag routine
 * commands like `npm rm`; however, actual shell delete commands are sensitive
 * because they mutate disk state directly.
 *
 * Four categories (see Common/docs/plans/agent-bash-risk-prompt.md §1):
 *   - network_egress  — UPLOAD / exfil shapes only; plain downloads pass.
 *   - destructive     — shell delete commands (`rm`, `Remove-Item`, `del`),
 *                       plus dd / mkfs / disk tools / fork bombs.
 *   - priv_esc        — sudo / su / doas / pkexec / Windows elevation.
 *   - sensitive_path  — credential & key files (any access), persistence /
 *                       autostart locations (writes), /etc writes. Excludes
 *                       `.env`, broad `~/.config`, /etc reads, and the macOS
 *                       user dirs (Documents/Desktop/Downloads).
 *
 * Known gap (accepted for v1): a command name fully hidden behind command
 * substitution (`$(echo cu)rl ...`) is not decomposed. The common exfil
 * shape (`curl .../$(cat secret)`) is still caught because the visible
 * leading command is `curl` and the sensitive path token is matched too.
 *
 * Pure / synchronous / no fs — this is path math + string matching only, so
 * it stays unit-testable without Electron and cheap to call per command.
 */

export type RiskCategory = 'network_egress' | 'destructive' | 'priv_esc' | 'sensitive_path';

export interface RiskResult {
  risky: boolean;
  reasons: RiskCategory[];
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

function unwrapWindowsShell(
  cmd: string,
  args: string[],
): { command: string; opaque: boolean } | null {
  const lower = args.map((arg) => arg.toLowerCase());
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

const NET_DOWNLOADERS = new Set(['curl', 'wget']);
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

function matchNetwork(cmd: string, args: string[], seg: Segment): boolean {
  if (RAW_SOCKET_CMDS.has(cmd)) return true;
  if (cmd === 'ssh') return args.length > 0; // ssh host [cmd] — remote exec
  if (REMOTE_COPY_CMDS.has(cmd)) return args.some(looksRemote);
  if (NET_DOWNLOADERS.has(cmd)) {
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
    const lower = args.map((arg) => arg.toLowerCase());
    for (let i = 0; i < lower.length; i++) {
      const arg = lower[i];
      if (arg === '-body' || arg === '-infile' || arg === '-form') return true;
      if (arg === '-method' && /^(post|put|patch|delete)$/.test(lower[i + 1] || '')) return true;
      if (/^-method:(post|put|patch|delete)$/.test(arg)) return true;
    }
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

function hasRecursiveFlag(args: string[]): boolean {
  return args.some((a) => a === '--recursive' || (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)));
}

function matchDestructive(cmd: string, args: string[], seg: Segment): boolean {
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

function matchPrivilegeEscalation(cmd: string, args: string[]): boolean {
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
  if (cmd === 'net' || cmd === 'net.exe') {
    if (lower[0] === 'user') return lower.some((arg) => arg === '/add' || arg === '/delete' || arg.startsWith('/active:'));
    if (lower[0] === 'localgroup' && lower[1] === 'administrators') {
      return lower.some((arg) => arg === '/add' || arg === '/delete');
    }
  }
  return false;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Classify a bash command. Returns the set of risk categories it trips
 *  (deduped); `risky` is true when any category fires. */
function classifyBashCommandInternal(command: string, depth: number): RiskResult {
  const reasons = new Set<RiskCategory>();
  const cmd = String(command ?? '');
  if (!cmd.trim()) return { risky: false, reasons: [] };

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

      if (matchPrivilegeEscalation(c, args)) {
        reasons.add('priv_esc');
        // inspect the inner command too: `sudo rm -rf /`
        if (PRIV_ESC_CMDS.has(c)) {
          const inner = effectiveCommand(args);
          if (inner) { c = inner.cmd; args = inner.args; }
        }
      }

      if (matchNetwork(c, args, seg)) reasons.add('network_egress');
      if (matchDestructive(c, args, seg)) reasons.add('destructive');
      if (matchSensitive(c, args, seg, allWords)) reasons.add('sensitive_path');

      const wrapped = unwrapWindowsShell(c, args);
      if (wrapped?.opaque) reasons.add('destructive');
      if (wrapped?.command && depth < 4) {
        const nested = classifyBashCommandInternal(wrapped.command, depth + 1);
        for (const reason of nested.reasons) reasons.add(reason);
      }
    }
  }

  return { risky: reasons.size > 0, reasons: [...reasons] };
}

export function classifyBashCommand(command: string): RiskResult {
  return classifyBashCommandInternal(command, 0);
}
