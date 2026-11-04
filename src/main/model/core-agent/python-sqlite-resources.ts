/** Bounded, fail-closed provenance for Python SQLite operations.
 * This does not execute Python or authorize a path. Unsupported expressions,
 * scopes and calls discard knowledge; the host still owns filesystem policy.
 */
export type SqliteResource = { kind: 'sqlite'; database: string; imports?: string[] };
type Token = { text: string; at: number; column: number; literal?: string };
type Value = { kind: 'module'; name: string } | { kind: 'path'; text: string }
  | { kind: 'factory'; name: string } | { kind: 'connection'; resource: SqliteResource };
const SQL_CONTROL = /\b(?:attach|detach|pragma|vacuum|load_extension)\b/i;

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

function straightLineSqliteResources(source: string): Map<number, SqliteResource> {
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
      if (['execute', 'executemany', 'executescript'].includes(method)) {
        const sql = ts[4]?.literal ?? (values.get(ts[4]?.text)?.kind === 'path'
          ? (values.get(ts[4].text) as { kind: 'path'; text: string }).text : undefined);
        // Adjacent literals, `+` and `%` extend the SQL past this token, so the
        // control check below would see only a prefix of the executed text.
        const wholeSql = ts[5]?.text === ',' || ts[5]?.text === ')';
        // ATTACH/extension/configuration statements can change where later SQL writes.
        const literalArguments = ts.slice(5, -1).every(t => t.literal !== undefined
          || !/^[A-Za-z_]\w*$/.test(t.text) || ['None', 'True', 'False'].includes(t.text));
        if (sql && wholeSql && literalArguments
          && !SQL_CONTROL.test(sql)) {
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

// These modules are trusted only when the host also rules out workspace shadows.
// The second pass admits a closed data-processing subset, not arbitrary Python.
const DATA_EXPORTS = new Map<string, readonly string[]>(Object.entries({
  sqlite3: ['connect'], pathlib: ['Path'], json: ['loads', 'dumps'], csv: ['DictReader'],
  hashlib: ['sha256'], collections: ['Counter', 'defaultdict'], os: ['environ'],
}));
const DATA_BUILTINS = new Set(['len', 'int', 'float', 'str', 'bool', 'dict', 'list', 'set', 'tuple',
  'sum', 'min', 'max', 'abs', 'any', 'all', 'enumerate', 'range', 'sorted', 'isinstance', 'open', 'print']);
const DATA_METHODS = new Set(['items', 'keys', 'values', 'get', 'strip', 'rstrip', 'lstrip',
  'split', 'splitlines', 'join', 'append', 'extend', 'hexdigest', 'read_bytes', 'read_text',
  'write_text', 'write_bytes', 'exists', 'unlink', 'mkdir', 'stat', 'fetchone', 'fetchall']);

function statements(tokens: Token[]): Token[][] {
  const result: Token[][] = [];
  let chunk: Token[] = [], depth = 0;
  for (const token of tokens) {
    if ((token.text === '\n' || token.text === ';') && depth === 0) {
      if (chunk.length) result.push(chunk);
      chunk = [];
    } else if (token.text !== '\n') {
      if (['(', '[', '{'].includes(token.text)) depth++;
      if ([')', ']', '}'].includes(token.text)) depth--;
      chunk.push(token);
    }
  }
  if (chunk.length) result.push(chunk);
  return result;
}

/** Prove stable in-memory bindings across data-only loops/comprehensions.
 * Inspect every executable expression, including f-string interpolation, using
 * the caller's existing code mask. A single unknown call, escaped/rebound
 * connection, reflective operation or unsupported SQL discards the whole proof.
 * SQL/file permissions themselves remain with the host.
 */
function dataProgramSqliteResources(source: string, code: Uint8Array): Map<number, SqliteResource> {
  const empty = () => new Map<number, SqliteResource>();
  const original = tokenize(source);
  if (!original || code.length !== source.length) return empty();
  for (let i = 0; i < original.length; i++) {
    const t = original[i], formatted = ['f', 'F'].includes(t.text)
      && original[i + 1]?.at === t.at + 1 && original[i + 1]?.literal !== undefined;
    if (formatted) {
      // The small lexer does not parse PEP 701 same-quote nesting. Reject an
      // incomplete interpolation rather than treating its contents as bindings.
      const text = original[i + 1].literal!;
      let braces = 0;
      for (let j = 0; j < text.length; j++) {
        if (!braces && ['{{', '}}'].includes(text.slice(j, j + 2))) { j++; continue; }
        if (text[j] === '{') braces++;
        if (text[j] === '}' && --braces < 0) return empty();
      }
      if (braces) return empty();
    }
    if (t.text !== '\n' && t.text !== '<string>' && !code[t.at] && !formatted) return empty();
  }
  const surface = source.replace(/[^\n]/g, (c, at) => code[at] ? c : ' ');
  const executable = tokenize(surface)?.filter(t => t.text !== '\n');
  if (!executable || executable.some(t => !/^[\x00-\x7f]*$/.test(t.text) || t.text.includes('__')
    || ['def', 'class', 'global', 'nonlocal', 'exec', 'eval', 'globals', 'locals', 'getattr', 'setattr',
      'delattr', 'del', 'with', 'try', 'except', 'finally', 'async', 'await', 'yield', 'match', 'case', '\\'].includes(t.text))) return empty();
  const chunks = statements(original);
  const ts = original.filter(t => t.text !== '\n');
  let work = 48_000, sqlTextBudget = 256 * 1024;
  const index = new Map(ts.map((t, i) => [t.at, i]));
  const modules = new Map<string, string>(), factories = new Map<string, string>();
  const declarations = new Set<number>();
  const register = (bindings: Map<string, string>, alias: string, name: string) => {
    if (DATA_BUILTINS.has(alias) || modules.has(alias) || factories.has(alias)) return false;
    bindings.set(alias, name);
    return true;
  };
  for (const chunk of chunks) {
    if (!['import', 'from'].includes(chunk[0].text)) continue;
    if (!code[chunk[0].at]) return empty();
    for (const t of chunk) declarations.add(t.at);
    if (chunk[0].text === 'import') {
      for (let i = 1; i < chunk.length;) {
        const name = chunk[i++]?.text;
        let alias = name;
        if (chunk[i]?.text === 'as') { i++; alias = chunk[i++]?.text; }
        if (!name || !alias || !DATA_EXPORTS.has(name) || (chunk[i] && chunk[i].text !== ',')
          || !register(modules, alias, name)) return empty();
        i++;
      }
    } else {
      const module = chunk[1]?.text, member = chunk[3]?.text;
      const alias = chunk[4]?.text === 'as' ? chunk[5]?.text : member;
      if (chunk[2]?.text !== 'import' || !DATA_EXPORTS.get(module)?.includes(member) || member === 'environ'
        || chunk.length !== (chunk[4]?.text === 'as' ? 6 : 4)
        || !register(factories, alias, module + '.' + member)) return empty();
    }
  }
  if (![...modules.values()].includes('sqlite3') && ![...factories.values()].includes('sqlite3.connect')) return empty();
  const proofImports = [...new Set([...modules.values(), ...[...factories.values()].map(name => name.split('.')[0])])];
  const protectedNames = new Set([...DATA_BUILTINS, ...modules.keys(), ...factories.keys()]);
  const assignments = new Map<string, number[]>();
  const bind = (token: Token) => {
    if (!code[token.at] || protectedNames.has(token.text)) return false;
    const occurrences = assignments.get(token.text) ?? [];
    occurrences.push(token.at);
    assignments.set(token.text, occurrences);
    return true;
  };
  for (const chunk of chunks) {
    let depth = 0, start = 0, assigned = false;
    for (let i = 0; i < chunk.length; i++) {
      const t = chunk[i].text;
      if (['(', '[', '{'].includes(t)) depth++;
      if ([')', ']', '}'].includes(t)) depth--;
      if (depth) continue;
      if (t === ':' && ['if', 'elif', 'else', 'for', 'while'].includes(chunk[0].text)) start = i + 1;
      if (t !== '=' || chunk[i + 1]?.text === '=' || ['=', '!', '<', '>'].includes(chunk[i - 1]?.text)) continue;
      if (assigned) return empty(); // Chained/destructured binding is unsupported.
      assigned = true;
      const lhs = chunk.slice(start, i);
      if (['+', '-', '*', '/', '%'].includes(lhs.at(-1)?.text ?? '')) lhs.pop();
      if (lhs.length === 1 && /^[A-Za-z_]\w*$/.test(lhs[0].text)) {
        if (!bind(lhs[0])) return empty();
      } else if (lhs[1]?.text !== '[' || lhs.at(-1)?.text !== ']') return empty();
    }
  }
  for (let i = 0; i < executable.length; i++) {
    const t = executable[i], previous = executable[i - 1]?.text;
    if (t.text === '=' && executable[i + 1]?.text !== '=' && !['=', '!', '<', '>'].includes(previous)) {
      // Attribute mutation and assignment expressions invalidate native API identity.
      if (previous === ':' || executable[i - 2]?.text === '.') return empty();
    }
    if (t.text === 'for' || t.text === 'lambda') {
      for (let j = i + 1; j < executable.length && !['in', ':'].includes(executable[j].text); j++) {
        if (--work < 0) return empty();
        const target = executable[j];
        if (/^[A-Za-z_]\w*$/.test(target.text)) { if (!bind(target)) return empty(); }
        else if (![',', '(', ')'].includes(target.text)) return empty();
      }
    }
  }
  const argsAt = (open: number): Token[][] | undefined => {
    if (ts[open]?.text !== '(') return;
    const args: Token[][] = [];
    let arg: Token[] = [], depth = 0;
    for (let i = open + 1; i < ts.length; i++) {
      if (--work < 0) return;
      const t = ts[i];
      if (t.text === ')' && !depth) { if (arg.length) args.push(arg); return args; }
      if (t.text === ',' && !depth) { args.push(arg); arg = []; continue; }
      if (['(', '[', '{'].includes(t.text)) depth++;
      if ([')', ']', '}'].includes(t.text) && --depth < 0) return;
      arg.push(t);
    }
  };
  const connections = new Set<string>(), connectionDefinitions = new Set<number>();
  const constants = new Map<string, Token[]>();
  for (const chunk of chunks) {
    if (chunk[1]?.text === '=' && assignments.get(chunk[0].text)?.length === 1) constants.set(chunk[0].text, chunk.slice(2));
  }
  const stringExpression = (tokens: Token[], depth = 0): { text: string; dynamic: boolean } | undefined => {
    work -= tokens.length;
    if (work < 0 || depth > 4 || !tokens.length) return;
    if (tokens.length === 1) {
      if (tokens[0].literal !== undefined) return { text: tokens[0].literal, dynamic: false };
      const value = constants.get(tokens[0].text);
      return value ? stringExpression(value, depth + 1) : undefined;
    }
    if (tokens.length === 2 && ['f', 'F'].includes(tokens[0].text) && tokens[1].literal !== undefined) {
      return { text: tokens[1].literal, dynamic: true };
    }
    const plus = tokens.findIndex(t => t.text === '+');
    if (plus > 0) {
      const left = stringExpression(tokens.slice(0, plus), depth + 1);
      const right = stringExpression(tokens.slice(plus + 1), depth + 1);
      if (left && right) return { text: left.text + right.text, dynamic: left.dynamic || right.dynamic };
    }
  };
  const callable = (i: number): string | undefined => {
    if (executable[i - 1]?.text === '.') {
      const owner = modules.get(executable[i - 2]?.text);
      return owner && DATA_EXPORTS.get(owner)?.includes(executable[i].text) ? owner + '.' + executable[i].text : undefined;
    }
    return factories.get(executable[i].text);
  };
  // Connections/cursors must have one simple definition and never escape.
  for (let i = 0; i < executable.length; i++) {
    if (executable[i + 1]?.text !== '(' || declarations.has(executable[i].at)) continue;
    const fn = callable(i);
    const cursor = executable[i].text === 'cursor' && executable[i - 1]?.text === '.'
      && connections.has(executable[i - 2]?.text);
    if (fn !== 'sqlite3.connect' && !cursor) continue;
    const at = index.get(executable[i].at);
    if (at === undefined) return empty();
    const start = fn && executable[i - 1]?.text !== '.' ? at : at - 2;
    const target = ts[start - 2];
    const args = argsAt(at + 1);
    if (ts[start - 1]?.text !== '=' || !target || protectedNames.has(target.text)
      || assignments.get(target.text)?.length !== 1 || !args
      || (cursor ? args.length !== 0 : args.length !== 1 || args[0].length !== 1 || args[0][0].literal !== ':memory:')) return empty();
    connections.add(target.text);
    connectionDefinitions.add(target.at);
  }
  if (!connections.size) return empty();
  const resources = empty();
  for (let i = 0; i < executable.length; i++) {
    const t = executable[i], before = executable[i - 1]?.text, after = executable[i + 1]?.text;
    if (declarations.has(t.at)) continue;
    if (before !== '.' && connections.has(t.text)) {
      if (connectionDefinitions.has(t.at)) continue;
      if (after !== '.' || executable[i + 3]?.text !== '(') return empty();
    }
    if (before !== '.' && modules.has(t.text) && (after !== '.' || !DATA_EXPORTS.get(modules.get(t.text)!)!.includes(executable[i + 2]?.text))) return empty();
    if (before !== '.' && factories.has(t.text) && after !== '(') return empty();
    if (t.text === '.') {
      const member = executable[i + 1]?.text;
      const owner = executable[i - 1]?.text;
      if (modules.has(owner)) {
        if (!DATA_EXPORTS.get(modules.get(owner)!)!.includes(member)
          || (member !== 'environ' && executable[i + 2]?.text !== '(')) return empty();
      } else if (connections.has(owner)) {
        if (!['execute', 'executemany', 'executescript', 'cursor', 'commit', 'rollback', 'close', 'fetchone', 'fetchall'].includes(member)) return empty();
      } else if (!DATA_METHODS.has(member) && !['parent', 'st_size'].includes(member)) return empty();
    }
    if (after !== '(') continue;
    if (['if', 'while', 'assert', 'not', 'and', 'or', 'in'].includes(t.text)) continue;
    if (before !== '.') {
      if (!DATA_BUILTINS.has(t.text) && !factories.has(t.text) && !['(', '[', '{', ',', '=', ':', '+', '-', '*', '/', '%', '<', '>'].includes(t.text)) return empty();
      continue;
    }
    const owner = executable[i - 2]?.text;
    if (modules.has(owner)) continue; // Module members were validated above.
    if (!connections.has(owner)) {
      if (!DATA_METHODS.has(t.text)) return empty();
      continue;
    }
    const at = index.get(t.at);
    if (at === undefined) return empty(); // No hidden SQL inside interpolation.
    const args = argsAt(at + 1);
    if (!args) return empty();
    if (['execute', 'executemany', 'executescript'].includes(t.text)) {
      const sql = stringExpression(args[0] ?? []);
      if (!sql || (sqlTextBudget -= sql.text.length) < 0 || SQL_CONTROL.test(sql.text)) return empty();
      // execute/executemany accept one statement. A complete static first
      // keyword prevents interpolation from choosing ATTACH/PRAGMA/VACUUM;
      // executescript requires the entire SQL text to be static.
      if (sql.dynamic && (t.text === 'executescript' || !/^[A-Za-z]+\s+/.test(sql.text.trimStart()))) return empty();
      resources.set(executable[i - 1].at, { kind: 'sqlite', database: ':memory:',
        imports: proofImports });
    } else if (args.length) return empty();
  }
  return resources;
}

export function pythonSqliteResources(source: string, code?: Uint8Array): Map<number, SqliteResource> {
  const resources = straightLineSqliteResources(source);
  const extended = code ? dataProgramSqliteResources(source, code) : new Map<number, SqliteResource>();
  // A deduplicated SQL finding may retain an earlier straight-line occurrence.
  // Carry the whole-program import requirements to it as well.
  if ([...extended.keys()].some(at => !resources.has(at))) {
    for (const [at, resource] of extended) resources.set(at, resource);
  }
  return resources;
}
