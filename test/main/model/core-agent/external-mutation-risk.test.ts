import { describe, expect, it } from 'vitest';
import {
  classifyExternalMutationCommand,
  classifyExternalMutationScript,
  referencedExecutableScripts,
} from '../../../../src/main/model/core-agent/external-mutation-risk';

describe('external-mutation-risk › wrapped script inspection', () => {
  it.each([
    ['memory', 'import sqlite3\nc = sqlite3.connect(":memory:")\nc.execute("CREATE TABLE dogs (id)")', ':memory:'],
    ['file and cursor alias', 'import sqlite3 as sql\nfrom pathlib import Path\np = Path("checks.db")\nc = sql.connect(p)\ncursor = c.cursor()\ncursor.execute("INSERT INTO dogs VALUES (1)")', 'checks.db'],
    ['semicolon-separated source', 'from sqlite3 import connect\nc = connect("checks.db"); c.execute("DELETE FROM dogs")', 'checks.db'],
    ['literal SQL parameters', 'import sqlite3\nc = sqlite3.connect("checks.db"); c.execute("INSERT INTO dogs VALUES (?, ?)", ("Cleo", 4))', 'checks.db'],
    ['SQL variable', 'import sqlite3\nc = sqlite3.connect("checks.db")\nsql = "DELETE FROM dogs"\nc.execute(sql)', 'checks.db'],
    ['D05 workspace verification', 'import json, sqlite3, pathlib\nfrom click.testing import CliRunner\nfrom sqlite_utils import cli\npath=pathlib.Path(".orkas-checks/dryrun.db")\nif path.exists(): path.unlink()\nconn=sqlite3.connect(path)\nconn.execute("create table dogs (id integer)")\nconn.execute("insert into dogs values (1)")', '.orkas-checks/dryrun.db'],
  ])('retains SQLite resource provenance for %s without granting access', (_label, source, database) => {
    const findings = classifyExternalMutationScript(source, { language: 'python' });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(f => f.resource?.database === database)).toBe(true);
  });

  it.each([
    'c = other_connection',
    'c.execute = remote.execute',
    'mutate_connections()',
    'if flag: c = other_connection',
    'c.execute("ATTACH DATABASE \'/outside.db\' AS external")',
    'sqlite3.connect = remote',
    'c.executescript("ATTACH DATABASE \'/outside.db\' AS external")',
    'c.create_function("mutate", 0, remote)',
  ])('does not retain local proof after %s', (change) => {
    const findings = classifyExternalMutationScript(`import sqlite3\nc = sqlite3.connect(":memory:")\n${change}\nc.execute("DELETE FROM dogs")`, { language: 'python' });
    expect(findings.find(f => f.action === 'delete')?.resource).toBeUndefined();
    expect(findings.some(f => f.action === 'delete')).toBe(true);
  });

  it('does not apply Python provenance to another language or a custom connection factory', () => {
    const source = 'import sqlite3\nc = sqlite3.connect(":memory:")\nc.execute("DELETE FROM dogs")';
    expect(classifyExternalMutationScript(source)[0].resource).toBeUndefined();
    expect(classifyExternalMutationScript(source.replace('sqlite3.connect(":memory:")', 'sqlite3.connect(":memory:", factory=remote)'), { language: 'python' })[0].resource).toBeUndefined();
  });

  it('keeps same-table writes to an unknown connection alongside a proven local write', () => {
    const source = 'import sqlite3\nc = sqlite3.connect(":memory:")\nc.execute("DELETE FROM dogs")\nremote.execute("DELETE FROM dogs")';
    const findings = classifyExternalMutationScript(source, { language: 'python' });
    expect(findings).toHaveLength(2);
    expect(findings.filter(f => !f.resource)).toEqual([{ kind: 'database_write', action: 'delete', target: 'dogs' }]);
  });

  it('retains approval when source exceeds the bounded provenance analysis', () => {
    const source = '# padding\n'.repeat(7000) + 'import sqlite3\nc = sqlite3.connect(":memory:")\nc.execute("DELETE FROM dogs")';
    expect(classifyExternalMutationScript(source, { language: 'python' })).toEqual([
      { kind: 'database_write', action: 'delete', target: 'dogs' },
    ]);
  });

  it.each([
    'def remove(c):\n c.execute("DELETE FROM dogs")',
    'c.execute("DELETE FROM dogs", mutate())',
    'if flag:\n c = remote\nc.execute("DELETE FROM dogs")',
    'with c:\n c.execute("DELETE FROM dogs")',
  ])('leaves deferred or uncertain execution to existing approval: %s', (tail) => {
    const findings = classifyExternalMutationScript('import sqlite3\nc = sqlite3.connect(":memory:")\n' + tail, { language: 'python' });
    expect(findings.some(f => f.action === 'delete')).toBe(true);
    expect(findings.every(f => !f.resource)).toBe(true);
  });

  it('recognizes the production-shaped Paramiko database deployment wrapper', () => {
    const source = `
import paramiko
sql = """DELETE FROM b_iblock_element_property
WHERE IBLOCK_PROPERTY_ID=190"""
ssh = paramiko.SSHClient()
stdin, stdout, stderr = ssh.exec_command(f'mysql prod -e "{sql}"')
`;
    expect(classifyExternalMutationScript(source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'database_write', action: 'delete', target: 'b_iblock_element_property' }),
    ]));
  });

  it('recognizes literal remote service changes and uploads', () => {
    const source = `
import paramiko
ssh.exec_command("sudo systemctl restart orkas-api")
sftp = ssh.open_sftp()
sftp.put("dist/app.js", "/srv/orkas/app.js")
`;
    expect(classifyExternalMutationScript(source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'service_change', action: 'restart', target: 'orkas-api' }),
      expect.objectContaining({ kind: 'remote_file_write', action: 'upload' }),
    ]));
  });

  it('reports service names in wrapped commands precisely', () => {
    const source = `
import paramiko
ssh.exec_command("service nginx restart")
ssh.exec_command("kubectl rollout status deployment/api")
`;
    expect(classifyExternalMutationScript(source)).toEqual([
      expect.objectContaining({ kind: 'service_change', action: 'restart', target: 'nginx' }),
    ]);
  });

  it('reports option-prefixed service and rollout operations precisely', () => {
    expect(classifyExternalMutationCommand('systemctl', ['--user', 'restart', 'orkas-worker'])).toEqual({
      kind: 'service_change', action: 'restart', target: 'orkas-worker',
    });
    expect(classifyExternalMutationCommand('kubectl', ['--context', 'prod', 'rollout', 'restart', 'deployment/api'])).toEqual({
      kind: 'deployment_change', action: 'rollout restart',
    });
    expect(classifyExternalMutationCommand('kubectl', ['rollout', 'status', 'deployment/api'])).toBeNull();
  });

  it('looks through remote privilege wrappers without matching printed commands', () => {
    expect(classifyExternalMutationCommand('ssh', ['host', 'sudo -u root systemctl restart api'])).toEqual({
      kind: 'service_change', action: 'restart', target: 'api',
    });
    expect(classifyExternalMutationCommand('ssh', ['host', 'echo systemctl restart api'])).toBeNull();
  });

  it('recognizes external HTTP writes in Python and JavaScript', () => {
    expect(classifyExternalMutationScript('requests.patch(url, json=payload)')).toContainEqual({
      kind: 'external_api_write', action: 'PATCH',
    });
    expect(classifyExternalMutationScript(`fetch(url, { method: "DELETE" })`)).toContainEqual({
      kind: 'external_api_write', action: 'DELETE',
    });
  });

  it('recognizes launching an external application as a visible host side effect', () => {
    expect(classifyExternalMutationCommand('open', ['https://example.com'])).toEqual({
      kind: 'external_launch', action: 'open', target: 'https://example.com',
    });
    expect(classifyExternalMutationCommand('xdg-open', ['./report.html'])).toEqual({
      kind: 'external_launch', action: 'open', target: './report.html',
    });
    expect(classifyExternalMutationCommand('gio', ['open', './report.html'])).toEqual({
      kind: 'external_launch', action: 'open', target: './report.html',
    });
    expect(classifyExternalMutationCommand('Start-Process', ['https://example.com'])).toEqual({
      kind: 'external_launch', action: 'start', target: 'https://example.com',
    });
    expect(classifyExternalMutationCommand('open', ['--help'])).toBeNull();
  });

  it('does not flag read-only DB/SSH calls or mutation words in comments and output', () => {
    const source = `
# cursor.execute("DELETE FROM users")
cursor.execute("SELECT id FROM users LIMIT 1")
ssh.exec_command("systemctl status orkas-api")
print("kubectl apply and DELETE FROM are documentation examples")
`;
    expect(classifyExternalMutationScript(source)).toEqual([]);
  });

  it('does not classify executable-looking examples printed by a script', () => {
    const source = `
print('requests.post(url)')
console.log('fetch(url, { method: "DELETE" })')
print('cursor.execute("DELETE FROM users")')
`;
    expect(classifyExternalMutationScript(source)).toEqual([]);
  });

  it('extracts literal script entrypoints without treating inline code as a file', () => {
    expect(referencedExecutableScripts('python deploy_apply.py')).toEqual(['deploy_apply.py']);
    expect(referencedExecutableScripts('node ./scripts/release.mjs --prod')).toEqual(['./scripts/release.mjs']);
    expect(referencedExecutableScripts('pwsh -File "scripts/deploy.ps1"')).toEqual(['scripts/deploy.ps1']);
    expect(referencedExecutableScripts('python -u "release jobs/deploy_apply.py"')).toEqual(['release jobs/deploy_apply.py']);
    expect(referencedExecutableScripts("bash -lc 'python deploy_apply.py'")).toEqual(['deploy_apply.py']);
    expect(referencedExecutableScripts('python -c "print(1)"')).toEqual([]);
  });

  it.each([
    `code = '''db.execute("DELETE FROM dogs")'''\nPath('test_example.py').write_text(code)`,
    `code = r"""requests.post(url)\nssh.exec_command('systemctl restart api')\nsftp.put('a', 'b')"""\nPath('test_example.py').write_text(code)`,
    `const code = \`fetch(url, { method: "DELETE" });\`; fs.writeFileSync('example.js', code);`,
    String.raw`const code = 'it\'s an example: requests.post(url)';`,
    `code = '''# It's an example\n/* comment */ requests.patch(url)\n"""docstring"""\n'''`,
    `text = f'''{{db.execute("DELETE FROM dogs")}}'''`,
    'const text = `escaped: \\${requests.post(url)}`;',
  ])('does not treat generated source text as an executed mutation: %s', (source) => {
    expect(classifyExternalMutationScript(source)).toEqual([]);
  });

  it('keeps the D03 test insertion a file edit, even when the new test contains SQL writes', () => {
    const source = `from pathlib import Path
p = Path('tests/test_cli_insert.py')
s = p.read_text()
anchor = '''def test_insert():
    db.execute("create table dogs (id integer)")
'''
insert = '''def test_insert():
    db.execute("create table dogs (id integer)")
    db.execute("insert into dogs values (1)")
'''
if anchor not in s:
    raise SystemExit('anchor not found')
p.write_text(s.replace(anchor, insert, 1))`;
    expect(classifyExternalMutationScript(source)).toEqual([]);
  });

  it.each([
    `example = '''db.execute("SELECT * FROM dogs")'''\ndb.execute("DELETE FROM dogs")`,
    `example = '''sql = "SELECT * FROM dogs"'''\nsql = "DELETE FROM dogs"\ndb.execute(sql)`,
    `print(db.execute("DELETE FROM dogs"))`,
    `text = f'''result: {db.execute("DELETE FROM dogs")}'''`,
    'const text = `result: ${db.execute("DELETE FROM dogs")}`;',
    `exec('''db.execute("DELETE FROM dogs")''')`,
    `code = '''db.execute("DELETE FROM dogs")'''\nexec(code)`,
    `eval('db.execute("DELETE FROM dogs")')`,
    String.raw`text = f'''\{db.execute("DELETE FROM dogs")}'''`,
    'const text = `outer: ${`inner: ${db.execute("DELETE FROM dogs")}`}`;',
    `db.execute("""DELETE FROM dogs\nWHERE id=1""")`,
    `const count = 1; // don't change this\ndb.execute("DELETE FROM dogs")`,
  ])('still detects executed SQL, including interpolation and explicit code evaluation: %s', (source) => {
    expect(classifyExternalMutationScript(source)).toContainEqual({
      kind: 'database_write', action: 'delete', target: 'dogs',
    });
  });

  it('does not let an earlier example hide a later real HTTP write or upload', () => {
    expect(classifyExternalMutationScript(`example = '''requests.post(url); sftp.put('a', 'b')'''\nrequests.delete(url)`)).toEqual([
      { kind: 'external_api_write', action: 'DELETE' },
    ]);
    expect(classifyExternalMutationScript(`example = '''sftp.put('a', 'b')'''\nsftp.put('c', 'd')`)).toEqual([
      { kind: 'remote_file_write', action: 'upload' },
    ]);
  });
});
