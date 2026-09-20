/** Bounded, fail-closed provenance for straight-line Python SQLite operations.
 * This does not execute Python or authorize a path. Unsupported expressions,
 * scopes and calls discard knowledge; the host still owns filesystem policy.
 */
export type SqliteResource = { kind: 'sqlite'; database: string };
type Token = { text: string; at: number; column: number; literal?: string };
type Value = { kind: 'module'; name: string } | { kind: 'path'; text: string }
  | { kind: 'factory'; name: string } | { kind: 'connection'; resource: SqliteResource };

function tokenize(source: string): Token[] | null {
  if (source.length > 64 * 1024) return null;
  const tokens: Token[] = [];
  let lineStart = 0;
  for (let i = 0; i < source.length;) {
    if (tokens.length > 12_000) return null;
    const at = i, column = i - lineStart, c = source[i];
    if (c === '\n') { tokens.push({ text: '\n', at, column }); lineStart = ++i; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    const raw = (c === 'r' || c === 'R') && (source[i + 1] === "'" || source[i + 1] === '"');
    if (c === "'" || c === '"' || raw) {
      if (raw) i++;
      const quote = source[i];
      const delimiter = source.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
      i += delimiter.length;
      let literal = '', valid = true, closed = false;
      while (i < source.length) {
        if (source.startsWith(delimiter, i)) { i += delimiter.length; closed = true; break; }
        if (source[i] === '\n') lineStart = i + 1;
        if (source[i] === '\\') {
          const next = source[++i];
          if (next === undefined) return null;
          if (raw) literal += '\\' + next;
          else {
            const escapes: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', n: '\n', r: '\r', t: '\t' };
            if (!(next in escapes)) valid = false;
            else literal += escapes[next];
          }
          i++;
        } else literal += source[i++];
      }
      if (!closed) return null;
      tokens.push({ text: '<string>', at, column, ...(valid ? { literal } : {}) });
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i));
    if (name) { tokens.push({ text: name[0], at, column }); i += name[0].length; }
    else { tokens.push({ text: c, at, column }); i++; }
  }
  return tokens;
}

export function pythonSqliteResources(source: string): Map<number, SqliteResource> {
  const resources = new Map<number, SqliteResource>();
  const tokens = tokenize(source);
  if (!tokens) return resources;
  // Deferred scopes and reflective code cannot be resolved by this small pass.
  if (tokens.some(t => ['def', 'class', 'lambda', 'global', 'nonlocal', 'exec', 'eval',
    'globals', 'locals', 'setattr', 'delattr', '__import__', 'chdir'].includes(t.text))) return resources;
  const values = new Map<string, Value>();
  const expr = (ts: Token[]): Value | undefined => {
    if (ts.length === 1) return ts[0].literal !== undefined
      ? { kind: 'path', text: ts[0].literal } : values.get(ts[0].text);
    let factory: Value | undefined, open = 1;
    if (ts[1]?.text === '.' && ts[2]) {
      const owner = values.get(ts[0].text);
      if (owner?.kind === 'module') factory = { kind: 'factory', name: owner.name + '.' + ts[2].text };
      if (owner?.kind === 'connection' && ts[2].text === 'cursor' && ts.length === 5
        && ts[3].text === '(' && ts[4].text === ')') return owner;
      open = 3;
    } else factory = values.get(ts[0]?.text);
    if (ts.length === 3 && factory?.kind === 'factory') return factory;
    if (factory?.kind !== 'factory' || ts[open]?.text !== '(' || ts.at(-1)?.text !== ')') return;
    // A custom connection factory/URI expression could redirect the resource.
    const argument = ts.slice(open + 1, -1);
    if (argument.length !== 1) return;
    const value = argument[0].literal !== undefined
      ? { kind: 'path' as const, text: argument[0].literal } : values.get(argument[0].text);
    if (value?.kind !== 'path') return;
    if (factory.name === 'pathlib.Path') return value;
    if (factory.name === 'sqlite3.connect') return { kind: 'connection', resource: { kind: 'sqlite', database: value.text } };
  };
  const statement = (ts: Token[]) => {
    if (!ts.length) return;
    if (ts[0].column > 0) { values.clear(); return; }
    if (ts[0].text === 'import') {
      for (let i = 1; i < ts.length;) {
        const name = ts[i++]?.text;
        let alias = name;
        if (ts[i]?.text === 'as') { i++; alias = ts[i++]?.text; }
        if (!alias || (ts[i] && ts[i].text !== ',')) { values.clear(); return; }
        values.delete(alias);
        if (name === 'sqlite3' || name === 'pathlib') values.set(alias, { kind: 'module', name });
        i++;
      }
      return;
    }
    if (ts[0].text === 'from') {
      const marker = ts.findIndex(t => t.text === 'import');
      const module = ts.slice(1, marker).map(t => t.text).join('');
      const name = module + '.' + ts[marker + 1]?.text;
      const alias = ts[marker + 2]?.text === 'as' ? ts[marker + 3]?.text : ts[marker + 1]?.text;
      if (marker < 2 || !alias || ts.length !== marker + (ts[marker + 2]?.text === 'as' ? 4 : 2)) { values.clear(); return; }
      values.delete(alias);
      if (name === 'sqlite3.connect' || name === 'pathlib.Path') values.set(alias, { kind: 'factory', name });
      return;
    }
    if (ts[1]?.text === '=' && ts[2]?.text !== '=' && /^[A-Za-z_]\w*$/.test(ts[0].text)) {
      const value = expr(ts.slice(2));
      // Aliasing a known value is safe; an unrecognized call can mutate globals.
      if (!value && ts.slice(2).some(t => t.text === '(')) values.clear();
      values.delete(ts[0].text);
      if (value) values.set(ts[0].text, value);
      return;
    }
    // Ordinary cleanup of a statically known Path does not rebind the connection.
    const pathGuard = ts.map(t => t.text).join(' ');
    if (ts[0].text === 'if' && values.get(ts[1]?.text)?.kind === 'path'
      && pathGuard === `if ${ts[1].text} . exists ( ) : ${ts[1].text} . unlink ( )`) return;
    const receiver = values.get(ts[0].text);
    if (receiver?.kind === 'connection' && ts[1]?.text === '.' && ts[3]?.text === '(' && ts.at(-1)?.text === ')') {
      const method = ts[2].text;
      if (['execute', 'executemany'].includes(method)) {
        const sql = ts[4]?.literal ?? (values.get(ts[4]?.text)?.kind === 'path'
          ? (values.get(ts[4].text) as { kind: 'path'; text: string }).text : undefined);
        // ATTACH/extension/configuration statements can change where later SQL writes.
        const literalArguments = ts.slice(5, -1).every(t => t.literal !== undefined
          || !/^[A-Za-z_]\w*$/.test(t.text) || ['None', 'True', 'False'].includes(t.text));
        if (sql && literalArguments
          && !/\b(?:attach|detach|pragma|vacuum|load_extension)\b/i.test(sql)) {
          resources.set(ts[1].at, receiver.resource);
          return;
        }
      }
      if (['commit', 'rollback', 'close'].includes(method) && ts.length === 5) return;
    }
    // Unknown calls, attribute writes, branches and rebinding invalidate proof.
    values.clear();
  };
  let chunk: Token[] = [], depth = 0, continuationColumn: number | undefined;
  for (const token of tokens) {
    if ((token.text === '\n' || token.text === ';') && depth === 0) {
      continuationColumn = token.text === ';' ? (chunk[0]?.column ?? continuationColumn) : undefined;
      statement(chunk); chunk = []; continue;
    }
    if (token.text === '\n') continue;
    if (['(', '[', '{'].includes(token.text)) depth++;
    if ([')', ']', '}'].includes(token.text) && --depth < 0) return new Map();
    // Semicolon-separated statements retain their top-level scope.
    if (!chunk.length && continuationColumn !== undefined) token.column = continuationColumn;
    chunk.push(token);
  }
  if (depth) return new Map();
  statement(chunk);
  return resources;
}
