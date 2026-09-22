/** Default deny patterns are command shapes, not words in arbitrary arguments.
 * This is a bounded admission check, not a shell interpreter or an OS sandbox.
 * Opaque execution retains conservative matching; host approval stays separate.
 */
import { tokenize } from "./shell-words.js";

const DEFAULT_BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){ :|:& };:",
  "chmod -R 777 /",
  "> /dev/sda",
  "shutdown",
  "reboot",
  "halt",
  "init 0",
  "init 6",
];

const SHAPES = DEFAULT_BLOCKED_COMMANDS.map(pattern => ({ pattern, words: pattern.toLowerCase().split(" ") }));
const REDIRECTS = new Set([">", ">>", "2>", "<"]);
const SEPARATORS = new Set([";", "&&", "||", "&", "|", "|&"]);
// These commands can reinterpret operands as commands or scripts. Do not infer
// literal-data safety from the outer command position in these forms.
const OPAQUE = /^(?:!|su|sudo|doas|ssh|busybox|env|command|builtin|exec|nohup|time|nice|ionice|stdbuf|setsid|xargs|find|eval|source|\.|sh|bash|dash|ksh|zsh|fish|csh|tcsh|cmd|powershell|pwsh|python[0-9.]*|py|node|ruby|perl|php|awk|gawk|if|then|else|elif|while|until|do|for|function)$/;

function name(word: string): string {
  return (word.split(/[\\/]/).pop() || word).toLowerCase().replace(/\.exe$/, "");
}

function matchStage(words: string[]): string | null {
  const executable = name(words[0] || "");
  for (const shape of SHAPES) {
    const [cmd, ...args] = shape.words;
    if (executable !== cmd && !(cmd === "mkfs" && executable.startsWith("mkfs."))) continue;
    if (args.every((arg, i) => {
      const actual = (words[i + 1] || "").toLowerCase();
      // Keep the existing prefix restrictions for path/assignment patterns.
      return i === args.length - 1 && (arg.startsWith("/") || arg.endsWith("="))
        ? actual.startsWith(arg) : actual === arg;
    })) return shape.pattern;
  }
  return null;
}

export function blockedCommand(command: string, custom: readonly string[] = []): string | null {
  const normalized = command.trim().toLowerCase();
  // User-configured patterns retain their existing substring semantics.
  const customMatch = custom.find(pattern => normalized.includes(pattern.toLowerCase()));
  if (customMatch !== undefined) return customMatch;

  const tokens = tokenize(command);
  let opaque = /[$`{}#]/.test(command);
  let words: string[] = [];
  let redirect: string | null = null;
  let blocked: string | null = null;
  const flush = () => {
    let start = 0;
    while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start++;
    if (start) words = words.slice(start);
    opaque ||= OPAQUE.test(name(words[0] || ""));
    blocked ||= matchStage(words);
    words = [];
  };
  for (const token of tokens) {
    if (token.type === "op") {
      if (SEPARATORS.has(token.value)) { flush(); redirect = null; }
      else if (REDIRECTS.has(token.value)) redirect = token.value;
      else opaque = true;
      continue;
    }
    if (redirect) {
      if (redirect !== "<" && token.value.startsWith("/dev/sda")) blocked ||= "> /dev/sda";
      redirect = null;
    } else words.push(token.value);
  }
  flush();
  if (blocked) return blocked;
  if (opaque) {
    return DEFAULT_BLOCKED_COMMANDS.find(pattern => normalized.includes(pattern.toLowerCase())) ?? null;
  }
  return null;
}
