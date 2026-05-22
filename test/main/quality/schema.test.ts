import { describe, it, expect } from 'vitest';
import {
  validateSkillFrontmatter,
  validateAgentJsonShape,
  parseFailureViolation,
} from '../../../src/main/quality/rules/schema';

describe('quality › schema › validateSkillFrontmatter', () => {
  it('passes a complete bilingual frontmatter', () => {
    const v = validateSkillFrontmatter({
      name: 'pdf-summarize',
      description_zh: 'PDF 摘要工具',
      description_en: 'Summarize PDF documents',
      category: 'data',
    });
    expect(v).toEqual([]);
  });

  it('flags missing name', () => {
    const v = validateSkillFrontmatter({
      description_zh: 'x', description_en: 'x',
    });
    expect(v.map((x) => x.rule)).toContain('frontmatter_name_missing');
  });

  it('flags name starting with digit', () => {
    const v = validateSkillFrontmatter({
      name: '7zip-helper',
      description_zh: 'x', description_en: 'x',
    });
    expect(v.map((x) => x.rule)).toContain('frontmatter_name_invalid');
  });

  it('flags name with double space', () => {
    const v = validateSkillFrontmatter({
      name: 'foo  bar',
      description_zh: 'x', description_en: 'x',
    });
    expect(v.map((x) => x.rule)).toContain('frontmatter_name_invalid');
  });

  it('flags missing description (no zh / en / legacy)', () => {
    const v = validateSkillFrontmatter({ name: 'foo' });
    expect(v.map((x) => x.rule)).toContain('frontmatter_description_missing');
  });

  it('accepts legacy description (migrated by loader heuristic)', () => {
    const v = validateSkillFrontmatter({
      name: 'foo',
      description: 'a description in some language',
    });
    expect(v.map((x) => x.rule)).not.toContain('frontmatter_description_missing');
  });

  it('flags overlong description as MEDIUM', () => {
    const long = 'x'.repeat(900);
    const v = validateSkillFrontmatter({
      name: 'foo',
      description_en: long,
      description_zh: 'short',
      category: 'general',
    });
    const long_v = v.find((x) => x.rule === 'frontmatter_description_too_long');
    expect(long_v?.level).toBe('MEDIUM');
    expect(long_v?.field).toBe('frontmatter:description_en');
  });

  it('a valid name with single-space groups passes', () => {
    const v = validateSkillFrontmatter({
      name: 'Foo Bar Baz',
      description_zh: 'x', description_en: 'x', category: 'general',
    });
    expect(v.map((x) => x.rule)).not.toContain('frontmatter_name_invalid');
  });

  it('flags missing or invalid category', () => {
    const missing = validateSkillFrontmatter({
      name: 'foo', description_zh: 'x', description_en: 'x',
    });
    const missingCat = missing.find((x) => x.rule === 'frontmatter_category_missing');
    expect(missingCat?.level).toBe('MEDIUM');

    const invalid = validateSkillFrontmatter({
      name: 'foo', description_zh: 'x', description_en: 'x', category: 'bad category',
    });
    const invalidCat = invalid.find((x) => x.rule === 'frontmatter_category_invalid');
    expect(invalidCat?.level).toBe('MEDIUM');
  });
});

describe('quality › schema › validateAgentJsonShape', () => {
  it('passes a minimal valid agent.json', () => {
    const v = validateAgentJsonShape({
      agent_id: 'abc123',
      name: 'My Agent',
      description_zh: 'zh', description_en: 'en',
      category: 'general',
    });
    expect(v).toEqual([]);
  });

  it('flags missing agent_id', () => {
    const v = validateAgentJsonShape({
      name: 'My Agent',
      description_zh: 'zh', description_en: 'en',
    });
    expect(v.map((x) => x.rule)).toContain('agent_id_missing');
  });

  it('flags missing name', () => {
    const v = validateAgentJsonShape({
      agent_id: 'abc',
      description_zh: 'zh', description_en: 'en',
    });
    expect(v.map((x) => x.rule)).toContain('agent_name_missing');
  });

  it('flags missing all description variants', () => {
    const v = validateAgentJsonShape({
      agent_id: 'abc', name: 'X',
    });
    expect(v.map((x) => x.rule)).toContain('agent_description_missing');
  });

  it('flags overlong description as MEDIUM', () => {
    const v = validateAgentJsonShape({
      agent_id: 'abc', name: 'X',
      description_en: 'y'.repeat(900), description_zh: 'short', category: 'general',
    });
    const long = v.find((x) => x.rule === 'agent_description_too_long');
    expect(long?.level).toBe('MEDIUM');
  });

  it('flags missing or invalid category', () => {
    const missing = validateAgentJsonShape({
      agent_id: 'abc', name: 'X', description_zh: 'zh', description_en: 'en',
    });
    const missingCat = missing.find((x) => x.rule === 'agent_category_missing');
    expect(missingCat?.level).toBe('MEDIUM');

    const invalid = validateAgentJsonShape({
      agent_id: 'abc', name: 'X', description_zh: 'zh', description_en: 'en', category: 'bad category',
    });
    const invalidCat = invalid.find((x) => x.rule === 'agent_category_invalid');
    expect(invalidCat?.level).toBe('MEDIUM');
  });
});

describe('quality › schema › parseFailureViolation', () => {
  it('builds a frontmatter parse failure violation', () => {
    const v = parseFailureViolation({ kind: 'frontmatter', message: 'oops' });
    expect(v.level).toBe('EXTREME');
    expect(v.rule).toBe('frontmatter_unparseable');
    expect(v.snippet).toBe('oops');
  });

  it('builds an agent_json parse failure violation', () => {
    const v = parseFailureViolation({ kind: 'agent_json', message: 'JSON parse error' });
    expect(v.rule).toBe('agent_json_unparseable');
  });

  it('truncates long messages to 200 chars', () => {
    const v = parseFailureViolation({ kind: 'frontmatter', message: 'x'.repeat(500) });
    expect(v.snippet.length).toBe(200);
  });
});
