import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeAgent } from '../../../src/main/features/agents';
import { _buildAgentInGroupSystemPromptForTest } from '../../../src/main/features/group_chat/bus';
import { SkillLoader } from '../../../src/core-agent/src/skills/loader';

const marketplace = path.resolve(__dirname, '../../../resources/builtin/marketplace');
const readAgent = () => JSON.parse(fs.readFileSync(path.join(marketplace, 'agents/173d4235a431/agent.json'), 'utf8'));
const readSkill = (id: string, file = 'SKILL.md') => fs.readFileSync(path.join(marketplace, 'skills', id, file), 'utf8');

describe('ContentWriter commerce integration', () => {
  it('selects the intended artifact before loading product-only writing supplements', () => {
    const agent = readAgent();
    expect(agent.description_zh).toMatch(/商品.*文案/);
    expect(agent.description_en).toMatch(/product.*copy/i);
    expect(agent.skill_list).toEqual(['9dfbd4e00c0d', 'de1fe2e2c26a', 'de52c67d49dd']);
    expect(agent.workflow).toMatch(/intended use[\s\S]*editorial.*social[\s\S]*product-commerce/i);
    expect(agent.workflow).toMatch(/product mention alone.*not/i);
    expect(agent.workflow).toContain('`content-writer` as the governing Skill');
    expect(agent.workflow).toMatch(/product-commerce[\s\S]*`ecommerce-listing`/i);
    expect(agent.workflow).not.toContain('`ecommerce-creative`');
    expect(agent.workflow).toMatch(/copy artifacts only/i);
    const framing = agent.workflow.split('### 2.')[0];
    expect(framing).toMatch(/video scripts.*storyboards.*production work even when delivered as text/i);
    expect(framing).toMatch(/independent copy.*capability handback/i);
    expect(agent.tool_list).toEqual(['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web', 'connectors']);
    const accept = agent.inputs.find((input: any) => input.id === 'files').accept.split(',');
    expect(accept).toEqual(expect.arrayContaining(['.tsv', '.xlsx', '.xls', 'image/*', 'video/*']));
    expect(agent.workflow).toMatch(/no store writes/i);
    expect(agent.skill_list).not.toContain('e8868f762c1d');
  });

  it('keeps social defaults separate from platform-bound product fields and mixed deliverables', () => {
    const root = readSkill('9dfbd4e00c0d');
    expect(root).toMatch(/ordinary social.*editorial[\s\S]*never ask/i);
    expect(root).toMatch(/product-commerce[\s\S]*platform.*field/i);
    expect(root).toMatch(/ask only.*changes.*(?:field|constraint)/i);
    expect(root).toMatch(/mixed.*(?:each|per).*artifact/i);
    const listing = readSkill('de52c67d49dd');
    expect(listing).toMatch(/governing.*workflow[\s\S]*product-specific.*checks[\s\S]*not.*(?:second|another).*pipeline/i);
    // The domain's factual and field rules must remain reachable, not be
    // replaced by generic social/article defaults after the Agent retires.
    expect(listing).toContain('references/source-based-writing.md');
    expect(listing).toContain('references/amazon-listing-and-a-plus.md');
    expect(readSkill('de52c67d49dd', 'references/cross-platform-listing.md')).toContain("Do not apply one SKU's attributes to its siblings");
    expect(readSkill('de52c67d49dd', 'references/listing-compliance.md')).toContain('Customer opinions');
    const formats = readSkill('9dfbd4e00c0d', 'references/content-formats.md');
    expect(formats).toMatch(/Douyin.*TikTok.*post captions/i);
    expect(formats).not.toMatch(/spoken script|scene notes|requested script/i);
    expect(listing).not.toMatch(/Use `ecommerce-creative`/);
  });

  it('assembles the new owner with resolvable supplements and the unchanged shared handback', async () => {
    const raw = readAgent();
    const loaded = new SkillLoader({ dirs: [path.join(marketplace, 'skills')] }).list();
    for (const [id, name] of [['de52c67d49dd', 'ecommerce-listing']]) {
      expect(raw.skill_list).toContain(id);
      expect(loaded.find(skill => skill.id === id)?.name).toBe(name);
    }
    const normalized = normalizeAgent(raw, 'builtin')!;
    const prompt = await _buildAgentInGroupSystemPromptForTest(normalized, '/test/content-commerce', 'en');
    expect(prompt).toContain('`ecommerce-listing`');
    expect(prompt).not.toContain('`ecommerce-creative`');
    expect(prompt).toMatch(/video scripts.*storyboards.*production work even when delivered as text/i);
    for (const standard of raw.standards) expect(prompt.split(standard)).toHaveLength(2);
    expect(prompt.split('<handback reason="capability_boundary" />')).toHaveLength(2);
    expect(raw.workflow).not.toMatch(/<handback|@commander|ECommerceWriter/);
  });

  it('advertises image deliverables and independently requested video planning before dispatch', () => {
    const agent = (id: string) => JSON.parse(fs.readFileSync(path.join(marketplace, 'agents', id, 'agent.json'), 'utf8'));
    const image = agent('814b61b027f0');
    const video = agent('79df9cc89f5f');
    expect(image.description_zh).toMatch(/商品主图.*场景图.*细节图/);
    expect(image.description_en).toMatch(/product hero.*lifestyle.*detail images/i);
    expect(video.description_zh).toMatch(/脚本.*分镜/);
    expect(video.description_en).toMatch(/script or storyboard alone/i);
    expect(video.workflow).toMatch(/script\/storyboard-only.*without rendering/i);
  });

  it('preserves the separately selected commerce-creative capability for its other owner', () => {
    const reviewer = JSON.parse(fs.readFileSync(path.join(marketplace, 'agents/a4930d19ba6c/agent.json'), 'utf8'));
    expect(reviewer.skill_list).toContain('59d186285161');
    expect(readSkill('59d186285161')).toContain('references/video-ad-storyboard.md');
    expect(readSkill('59d186285161', 'references/video-ad-storyboard.md')).toContain('storyboard_timing');
  });
});
