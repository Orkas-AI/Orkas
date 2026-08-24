import { describe, expect, it } from 'vitest';
import {
  classifyExternalMutationCommand,
  classifyExternalMutationScript,
  referencedExecutableScripts,
} from '../../../../src/main/model/core-agent/external-mutation-risk';

describe('external-mutation-risk › wrapped script inspection', () => {
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
});
