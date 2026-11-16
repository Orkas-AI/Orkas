import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeAgent } from '../../../src/main/features/agents';
import { _buildAgentInGroupSystemPromptForTest } from '../../../src/main/features/group_chat/bus';

const root = path.resolve(__dirname, '../../../resources/builtin/marketplace/agents');
const readAgent = (id: string) => JSON.parse(fs.readFileSync(path.join(root, id, 'agent.json'), 'utf8'));

describe('writing versus target-site SEO/GEO responsibility', () => {
  it('advertises complete SEO/GEO writing without a site-audit launch gate', () => {
    const writer = readAgent('173d4235a431');
    expect(writer.description_zh).toContain('SEO/GEO');
    expect(writer.description_en).toMatch(/SEO\/GEO.*articles/i);
    expect(writer.description_en).toMatch(/delivers copy only/i);
    expect(writer.workflow).toMatch(/complete SEO\/GEO (?:articles|writing) from the supplied topic/i);
    expect(writer.workflow).toMatch(/site diagnostics and website code are outside this role/i);
    expect(writer.inputs.filter((field: any) => field.required).map((field: any) => field.id)).toEqual(['task']);
    expect(writer.workflow.length).toBeLessThanOrEqual(1800);
  });

  it('keeps specialist page drafts as part of site optimization, with the existing source-change authority', () => {
    const seo = readAgent('e064dca9e1bd');
    expect(seo.description_zh).toMatch(/目标网站/);
    expect(seo.description_en).toMatch(/target-site.*page briefs and drafts/i);
    expect(seo.description_en).toMatch(/not standalone editorial or social copy/i);
    expect(seo.workflow).toMatch(/CONTENT is target-site page optimization, not standalone editorial\/social copy/);
    expect(seo.workflow).toMatch(/CONTENT creates an answer-first brief and target-page draft.*optimization goal/);
    expect(seo.workflow).toContain('publishing remains APPLY');
    expect(seo.workflow).toMatch(/APPLY requires a supplied local repository path/);
    expect(seo.workflow).toMatch(/user's current request authorizes the exact source-change batch/);
    expect(seo.inputs.filter((field: any) => field.required).map((field: any) => field.id)).toEqual(['url']);
  });

  it('assembles both responsibility boundaries without changing capabilities or duplicating handback', async () => {
    const writer = readAgent('173d4235a431');
    const seo = readAgent('e064dca9e1bd');
    expect(writer.tool_list).toEqual(['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web', 'connectors']);
    expect(writer.skill_list).toEqual(['9dfbd4e00c0d', 'de1fe2e2c26a', 'de52c67d49dd']);
    expect(seo.tool_list).toEqual(['workspace.read', 'workspace.write', 'workspace.execute.command', 'web', 'connectors']);
    expect(seo.skill_list).toEqual(['seo-crawl', 'seo-tech-audit', 'seo-content', 'seo-schema', 'seo-cwv', 'geo-score', 'geo-probe', 'seo-keywords', 'seo-opportunity', 'seo-monitor', 'seo-report', 'seo-backlink-value']);
    expect(writer.workflow).toMatch(/complete independent copy.*return production scope.*shared capability handback/i);
    for (const spec of [writer, seo]) {
      const normalized = normalizeAgent(spec, 'builtin')!;
      const prompt = await _buildAgentInGroupSystemPromptForTest(normalized, '/test/copy-seo', 'en');
      expect(prompt).toContain(spec.workflow);
      for (const standard of spec.standards) expect(prompt.split(standard)).toHaveLength(2);
      expect(prompt.split('<handback reason="capability_boundary" />')).toHaveLength(2);
      expect(spec.workflow).not.toMatch(/@commander|<handback|ContentWriter|SeoGeoAgent/);
    }
  });
});
