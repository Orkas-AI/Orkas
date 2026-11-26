/** Pure best-effort shell lexing shared by command admission and host risk analysis. */
export type Tok = { type: 'word'; value: string; literal?: boolean } | { type: 'op'; value: string };

const TWO_CHAR_OPS = new Set(['&&', '||', '>>', '|&', '2>']);
const ONE_CHAR_OPS = new Set(['|', '&', ';', '>', '<', '(', ')', '\n']);

/** Best-effort shell tokenizer. Quote-strips single/double quotes, honors
 *  backslash escapes, and emits control/redirection operators as separate
 *  tokens. Command substitution `$(...)` / backticks are NOT expanded — they
 *  remain literal inside word tokens, which is what the matchers want. */
export function tokenize(input: string): Tok[] {
  return scanWords(input, false)!;
}

/** Opt-in structure for PowerShell admission. Default shell lexing and literal
 * POSIX admission retain their existing byte interpretation. Quoted blocks are
 * words; only executable, unquoted braces become grouping operators. */
export function tokenizePowerShellStructure(input: string): Tok[] {
  return scanWords(input, false, true)!;
}

/** Recognize only literal POSIX command lists. Unknown syntax falls back to
 * the existing conservative policy; this never evaluates or rewrites input.
 * Expansion-like bytes inside operands remain conservative too: shell builtins
 * can reinterpret them (e.g. an array subscript passed to printf -v). Only a
 * proven file heredoc body is skipped without examining its contents. */
export function literalPosixTokens(input: string): Tok[] | null {
  if (input.length > 65_536 || input.includes('\r')) return null;
  return scanWords(input, true);
}

type WordToken = Tok & { quoted?: boolean };

/** Admit only a single cat-to-file receiver, with one quoted heredoc. A pipe,
 * interpreter, extra argument or redirection cannot establish literal data. */
function literalFileHeredoc(tokens: WordToken[]): { delimiter: string; stripTabs: boolean; opener: number } | null {
  const openers = tokens.flatMap((token, i) => token.type === 'op' && token.value.startsWith('<<') ? [i] : []);
  if (openers.length !== 1) return null;
  const isSeparator = (token: WordToken) => token.type === 'op' && [';', '&&', '||', '&', '|', '|&'].includes(token.value);
  let start = openers[0];
  while (start > 0 && !isSeparator(tokens[start - 1])) start--;
  let end = openers[0];
  while (end < tokens.length && !isSeparator(tokens[end])) end++;
  if ([tokens[start - 1], tokens[end]].some(token => token?.type === 'op' && ['|', '|&'].includes(token.value))) return null;
  if (tokens[start]?.type !== 'word' || tokens[start].value !== 'cat') return null;
  let file = false;
  let heredoc: { delimiter: string; stripTabs: boolean; opener: number } | null = null;
  for (let i = start + 1; i < end; i += 2) {
    const op = tokens[i];
    const operand = tokens[i + 1];
    if (op?.type !== 'op' || operand?.type !== 'word') return null;
    if ((op.value === '>' || op.value === '>>') && !file) file = true;
    else if ((op.value === '<<' || op.value === '<<-') && operand.quoted && !heredoc) {
      heredoc = { delimiter: operand.value, stripTabs: op.value === '<<-', opener: i };
    } else return null;
  }
  return file ? heredoc : null;
}

function scanWords(input: string, literal: boolean, powershellStructure = false): Tok[] | null {
  const toks: WordToken[] = [];
  let cur = '';
  let hasCur = false;
  let quoted = false;
  let singleQuoted = false;
  let lineStart = 0;
  const flush = () => {
    if (hasCur) {
      toks.push({ type: 'word', value: cur, ...(literal ? { quoted } : {}),
        ...(powershellStructure && singleQuoted ? { literal: true } : {}) });
      cur = ''; hasCur = false; quoted = false; singleQuoted = false;
    }
  };

  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];

    if (powershellStructure && input.slice(i, i + 2) === '<#') {
      const end = input.indexOf('#>', i + 2);
      flush(); i = end < 0 ? n : end + 2; continue;
    }
    if (powershellStructure && c === '#' && !hasCur) {
      const end = input.indexOf('\n', i);
      i = end < 0 ? n : end; continue;
    }
    if (powershellStructure && c === '`' && i + 1 < n) {
      if (input[i + 1] !== '\n') { cur += input[i + 1]; hasCur = true; }
      i += 2; continue;
    }

    if (literal && c === '#' && !hasCur) {
      const end = input.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (literal && /[$`{}()]/.test(c)) return null;

    if (c === "'") {
      quoted = true;
      singleQuoted = true;
      const end = input.indexOf("'", i + 1);
      if (literal && (end === -1 || /[$`{}]/.test(input.slice(i + 1, end)))) return null;
      if (end === -1) { cur += input.slice(i + 1); hasCur = true; i = n; break; }
      cur += input.slice(i + 1, end); hasCur = true; i = end + 1; continue;
    }
    if (c === '"') {
      quoted = true;
      let j = i + 1; let buf = '';
      while (j < n && input[j] !== '"') {
        if (powershellStructure && input[j] === '`' && j + 1 < n) {
          buf += input[j + 1]; j += 2; continue;
        }
        if (literal && /[$`{}]/.test(input[j])) return null;
        if (input[j] === '\\' && j + 1 < n) {
          const next = input[j + 1];
          if (literal && /[$`{}]/.test(next)) return null;
          if (literal && next === '\n') { j += 2; continue; }
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            buf += next;
            j += 2;
            continue;
          }
          // In double-quoted POSIX shell text, backslash before an ordinary
          // letter stays literal. Preserving it is also essential for
          // Windows paths such as "C:\Users\Alice\.ssh\id_rsa".
          buf += '\\';
          j++;
          continue;
        }
        buf += input[j]; j++;
      }
      if (literal && j === n) return null;
      cur += buf; hasCur = true; i = (j < n ? j + 1 : n); continue;
    }
    if (c === '\\') {
      if (literal) {
        if (i + 1 === n || /[$`{}]/.test(input[i + 1])) return null;
        if (input[i + 1] !== '\n') { cur += input[i + 1]; hasCur = true; quoted = true; }
        i += 2;
        continue;
      }
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

    if (powershellStructure && (c === '{' || c === '}')) {
      flush(); toks.push({ type: 'op', value: c }); i++; continue;
    }

    if (literal && c === '\n') {
      flush();
      const line = toks.slice(lineStart);
      if (line.some(token => token.type === 'op' && token.value.startsWith('<<'))) {
        const spec = literalFileHeredoc(line);
        if (!spec) return null;
        let end = i + 1;
        let found = false;
        while (end <= n) {
          const newline = input.indexOf('\n', end);
          const stop = newline < 0 ? n : newline;
          const bodyLine = input.slice(end, stop);
          if ((spec.stripTabs ? bodyLine.replace(/^\t+/, '') : bodyLine) === spec.delimiter) {
            i = stop;
            found = true;
            break;
          }
          if (newline < 0) break;
          end = newline + 1;
        }
        if (!found) return null;
        toks.splice(lineStart + spec.opener, 2);
      }
      toks.push({ type: 'op', value: ';' });
      lineStart = toks.length;
      i++;
      continue;
    }
    if (literal && input.slice(i, i + 2) === '<<') {
      flush();
      const op = input[i + 2] === '-' ? '<<-' : '<<';
      toks.push({ type: 'op', value: op });
      i += op.length;
      continue;
    }
    // An unquoted IO_NUMBER belongs to the following redirection, not argv.
    if (literal && (c === '>' || c === '<') && !quoted && /^\d+$/.test(cur)) {
      cur = ''; hasCur = false;
    }
    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two) && (!literal || two !== '2>' || !hasCur)) { flush(); toks.push({ type: 'op', value: two }); i += 2; continue; }
    if (ONE_CHAR_OPS.has(c)) { flush(); toks.push({ type: 'op', value: c === '\n' ? ';' : c }); i++; continue; }

    cur += c; hasCur = true; i++;
  }
  flush();
  if (literal && toks.some((token, i) => token.type === 'op' && (
    token.value.startsWith('<<')
    || (['>', '>>', '2>', '<'].includes(token.value) && toks[i + 1]?.type !== 'word')
  ))) return null;
  return toks;
}
