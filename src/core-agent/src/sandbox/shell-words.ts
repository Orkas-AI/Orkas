/** Pure best-effort shell lexing shared by command admission and host risk analysis. */
export type Tok = { type: 'word'; value: string } | { type: 'op'; value: string };

const TWO_CHAR_OPS = new Set(['&&', '||', '>>', '|&', '2>']);
const ONE_CHAR_OPS = new Set(['|', '&', ';', '>', '<', '(', ')', '\n']);

/** Best-effort shell tokenizer. Quote-strips single/double quotes, honors
 *  backslash escapes, and emits control/redirection operators as separate
 *  tokens. Command substitution `$(...)` / backticks are NOT expanded — they
 *  remain literal inside word tokens, which is what the matchers want. */
export function tokenize(input: string): Tok[] {
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
          // Windows paths such as "C:\Users\Alice\.ssh\id_rsa".
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

