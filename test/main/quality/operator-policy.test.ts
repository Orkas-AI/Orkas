import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseOperatorPolicy, runOperatorPolicy, validateSkillFile } from '../../../src/main/quality';
const rule = { id: 'internal_bucket', level: 'EXTREME', pattern: 's3://acme-internal', message: 'Internal buckets are off limits.' };
const policy = (rules: unknown[] = [rule]) => JSON.stringify({ version: 1, rules });
const md = (body: string) => `---\nname: weekly-report\ndescription: Build the weekly report\n---\n${body}`;
async function scan(content: string, rules: unknown[] = [rule], relpath = 'scripts/run.sh') {
  const result = await runOperatorPolicy(policy(rules), { kind: 'files', files: [{ relpath, content }] });
  expect(result).toHaveProperty('reports');
  if (!('reports' in result)) throw new Error('scan failed');
  return result.reports[0];
}
describe('operator policy', () => {
  it('loads versioned policy with a separate rule namespace and defaults', () => {
    const parsed = parseOperatorPolicy(policy());
    expect(parsed.errors).toEqual([]);
    expect(parsed.rules[0]).toMatchObject({ id: 'operator:internal_bucket', appliesTo: ['skill_md', 'script', 'agent_json'] });
  });
  it('rejects the entire config for unsupported versions, typos, types, duplicates, regex syntax or excess rules', () => {
    for (const config of [
      { rules: [rule] }, { version: 2, rules: [rule] }, { version: 1, rules: [rule], typo: true },
      ...[{ ...rule, flags: 5 }, { ...rule, message: false }, { ...rule, typo: 1 }, { ...rule, pattern: '(' },
        { ...rule, flags: 'g' }, { ...rule, appliesTo: ['other'] }].map(bad => ({ version: 1, rules: [rule, bad] })),
      { version: 1, rules: [rule, rule] }, { version: 1, rules: Array.from({ length: 51 }, (_, i) => ({ ...rule, id: `r${i}` })) },
    ]) {
      const parsed = parseOperatorPolicy(JSON.stringify(config));
      expect(parsed.errors.length).toBeGreaterThan(0);
      expect(parsed.rules).toEqual([]);
    }
  });
  it('retains built-in findings verbatim and allows only additive policy findings', async () => {
    const content = 'security find-generic-password -s x -w';
    const before = validateSkillFile({ relpath: 'scripts/run.sh', content });
    const after = await scan(content, [{ ...rule, id: 'no_credential_path_read', level: 'LOW', pattern: 'security' }]);
    expect(after.ok).toBe(false);
    for (const finding of before.violations) expect(after.violations).toContainEqual(finding);
    expect(after.violations).toContainEqual(expect.objectContaining({ rule: 'operator:no_credential_path_read', source: 'operator-policy', level: 'LOW' }));
  });
  it('routes only executable Markdown fences to skill_md, not prose or script-only rules', async () => {
    const content = md('s3://acme-internal prose\n```bash\necho s3://acme-internal\n```');
    expect((await scan(content, [rule], 'SKILL.md')).violations).toContainEqual(expect.objectContaining({ rule: 'operator:internal_bucket' }));
    expect((await scan(content, [{ ...rule, appliesTo: ['script'] }], 'SKILL.md')).violations).toEqual([]);
    expect((await scan(md('s3://acme-internal prose'), [rule], 'SKILL.md')).violations).toEqual([]);
  });
  it('checks sidecar and Agent JSON using their own target kinds', async () => {
    expect((await scan('{"category":"s3://acme-internal"}', [{ ...rule, appliesTo: ['skill_meta'] }], '_meta.json')).violations)
      .toContainEqual(expect.objectContaining({ rule: 'operator:internal_bucket', source: 'operator-policy' }));
    const result = await runOperatorPolicy(policy(), { kind: 'agent', args: { agentJson: { name: 'Writer', workflow: 's3://acme-internal' } } });
    expect(result).toMatchObject({ reports: [{ ok: false, violations: expect.arrayContaining([expect.objectContaining({ rule: 'operator:internal_bucket' })]) }] });
  });
  it('scans directory scripts and sidecars and rejects unreadable or linked trees', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-dir-'));
    try {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), md('Body'));
      fs.writeFileSync(path.join(dir, '_meta.json'), '{"category":"s3://acme-internal"}');
      fs.mkdirSync(path.join(dir, 'scripts'));
      fs.writeFileSync(path.join(dir, 'scripts/run.sh'), 'echo s3://acme-internal');
      const result = await runOperatorPolicy(policy([{ ...rule, appliesTo: ['script', 'skill_meta'] }]), { kind: 'directory', dir });
      expect(result).toMatchObject({ reports: [{ violations: expect.arrayContaining([
        expect.objectContaining({ rule: 'operator:internal_bucket', field: '_meta.json:1' }),
        expect.objectContaining({ rule: 'operator:internal_bucket', field: 'scripts/run.sh:1' }),
      ]) }] });
      fs.unlinkSync(path.join(dir, 'SKILL.md'));
      expect(await runOperatorPolicy(policy(), { kind: 'directory', dir })).toEqual({ error: 'scan' });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), md('Body'));
      fs.symlinkSync(path.join(dir, 'SKILL.md'), path.join(dir, 'link'));
      expect(await runOperatorPolicy(policy(), { kind: 'directory', dir })).toEqual({ error: 'scan' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('terminates catastrophic regex without blocking the event loop and recovers on the next scan', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const start = performance.now();
    try {
      const result = await runOperatorPolicy(policy([{ ...rule, pattern: '^(a+)+$' }]), { kind: 'files', files: [{ relpath: 'run.sh', content: 'a'.repeat(31) + '!' }] });
      expect(result).toEqual({ error: 'timeout' });
      expect(ticks).toBeGreaterThan(10);
      expect(performance.now() - start).toBeLessThan(4000);
      expect((await scan('echo harmless')).ok).toBe(true);
    } finally { clearInterval(timer); }
  }, 7000);
  it('bounds concurrent work and input without spawning unbounded workers', async () => {
    const slow = () => runOperatorPolicy(policy([{ ...rule, pattern: '^(a+)+$' }]), { kind: 'files', files: [{ relpath: 'run.sh', content: 'a'.repeat(31) + '!' }] });
    const a = slow(); const b = slow();
    expect(await slow()).toEqual({ error: 'busy' });
    await Promise.all([a, b]);
    expect(await runOperatorPolicy(policy(), { kind: 'files', files: [{ relpath: 'run.sh', content: 'x'.repeat(2 * 1024 * 1024) }] })).toEqual({ error: 'size' });
  }, 7000);
  it('bounds finding volume instead of returning an oversized partial report', async () => {
    const rules = Array.from({ length: 50 }, (_, index) => ({ ...rule, id: `match${index}`, pattern: 'hit' }));
    const result = await runOperatorPolicy(policy(rules), { kind: 'files', files: Array.from({ length: 12 }, (_, index) => ({ relpath: `run${index}.sh`, content: 'echo hit' })) });
    expect(result).toEqual({ error: 'size' });
  });
  it('fails closed when a synchronous caller mistakenly supplies operator rules', () => {
    const result = validateSkillFile({ relpath: 'run.sh', content: 'a'.repeat(31) + '!', operatorRules: parseOperatorPolicy(policy([{ ...rule, pattern: '^(a+)+$' }])).rules });
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({ rule: 'operator:incomplete' }));
  });
});
