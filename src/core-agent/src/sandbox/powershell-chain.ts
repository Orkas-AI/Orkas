import { randomUUID } from "node:crypto";

export type PowerShellChain =
  | { kind: "none" }
  | { kind: "unsupported" }
  | { kind: "chain"; commands: string[]; operators: Array<"&&" | "||"> };

const MAX_CHAIN_CHARS = 64 * 1024;
const MAX_CHAIN_COMMANDS = 32;
// Grammar keywords cannot be treated as ordinary command invocations.
const STATEMENT_KEYWORDS = new Set([
  "if", "elseif", "else", "switch", "foreach", "for", "while", "do",
  "until", "try", "catch", "finally", "trap", "function", "filter",
  "class", "enum", "param", "return", "break", "continue", "exit",
  "throw", "data", "using", "begin", "process", "end", "clean",
]);

/** Recognize only complete, single-line chains of simple PowerShell commands.
 * This is not a general shell translator. Preserve operand bytes and reject
 * expressions, pipelines, redirections and statements rather than guessing.
 */
export function parsePowerShellChain(command: string): PowerShellChain {
  if (!command.includes("&&") && !command.includes("||")) return { kind: "none" };
  if (command.length > MAX_CHAIN_CHARS) return { kind: "unsupported" };
  const commands: string[] = [];
  const operators: Array<"&&" | "||"> = [];
  let quote = "";
  let start = 0;
  let unsupported = false;
  let commandHasContent = false;
  const environmentVariable = /\$env:[a-z_][a-z0-9_]*/iy;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const atCommandStart = !commandHasContent;
    if (/\S/.test(ch)) commandHasContent = true;
    if (/[\r\n\0\u0085\u2028\u2029\u2018\u2019\u201c\u201d]/.test(ch)) unsupported = true;
    if (quote === "'") {
      if (ch === "'" && command[i + 1] === "'") i++;
      else if (ch === "'") quote = "";
      continue;
    }
    if (ch === "`") {
      // PowerShell escapes with backticks, not backslashes. Escapes outside
      // strings remain outside the supported grammar, but cannot split a chain.
      if (!quote || i + 1 >= command.length || /[\r\n]/.test(command[i + 1])) unsupported = true;
      i++;
      continue;
    }
    if (ch === "$") {
      environmentVariable.lastIndex = i;
      if (!environmentVariable.test(command)) unsupported = true;
    }
    if (quote === '"') {
      if (ch === '"' && command[i + 1] === '"') i++;
      else if (ch === '"') quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#") { unsupported = true; break; }
    // Stop-parsing changes the meaning of all following operators. Smart
    // quotes above are also PowerShell delimiters outside this small grammar.
    if (command.startsWith("--%", i)) unsupported = true;
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      commands.push(command.slice(start, i).trim());
      operators.push(ch === "&" ? "&&" : "||");
      start = ++i + 1;
      commandHasContent = false;
      if (operators.length >= MAX_CHAIN_COMMANDS) return { kind: "unsupported" };
      continue;
    }
    if (";|<>(){}[]@".includes(ch)) unsupported = true;
    // A leading call operator supports quoted executable paths. A trailing
    // single ampersand would instead change the execution lifecycle.
    if (ch === "&" && !atCommandStart) unsupported = true;
  }
  if (!operators.length) return { kind: "none" };
  commands.push(command.slice(start).trim());
  if (quote || unsupported || commands.some(part => {
    const first = part.split(/\s/, 1)[0].toLowerCase();
    return !part || STATEMENT_KEYWORDS.has(first)
      || /^["'$@]/.test(part) || first === "." || part === "&";
  })) return { kind: "unsupported" };
  return { kind: "chain", commands, operators };
}

/** Lower a recognized chain inside the existing single PowerShell process.
 * Capture success immediately, retaining it when a branch is skipped. Clear
 * stale native status before each command so a successful cmdlet can recover
 * from a failed executable. Only the final selected command determines exit.
 */
export function compilePowerShellChain(chain: Extract<PowerShellChain, { kind: "chain" }>): string {
  const id = randomUUID().replace(/-/g, "");
  const succeeded = `$orkasChainSucceeded_${id}`;
  const exitCode = `$orkasChainExitCode_${id}`;
  const stage = (command: string) => [
    // NativeCommandProcessor writes the global automatic variable. A local
    // assignment here would shadow it inside the shell's existing & { } scope.
    "$global:LASTEXITCODE = 0",
    command,
    `${succeeded} = $?`,
    `${exitCode} = if (${succeeded}) { 0 } elseif ($global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } else { 1 }`,
  ].join("\n");
  const script = [stage(chain.commands[0])];
  for (let i = 1; i < chain.commands.length; i++) {
    const condition = chain.operators[i - 1] === "&&" ? succeeded : `-not ${succeeded}`;
    script.push(`if (${condition}) {\n${stage(chain.commands[i])}\n}`);
  }
  script.push(`exit ${exitCode}`);
  return script.join("\n");
}
