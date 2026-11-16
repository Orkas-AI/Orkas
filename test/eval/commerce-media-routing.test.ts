import fs from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';

const root=path.resolve(__dirname,'../../resources/builtin/marketplace/agents');
const read=(id:string,file:string)=>fs.readFileSync(path.join(root,id,'skills',file),'utf8');

describe('commerce resource routing and fallback owners',()=>{
  it('makes commercial visual intent participate before generic image route selection', () => {
    const router = read('814b61b027f0', 'image-router/SKILL.md');
    const commerce = router.split('## Product creative before route lock')[1]?.split('## Route selection')[0] || '';
    expect(commerce).toMatch(/GENERATE.*HYBRID/);
    expect(commerce).toMatch(/COMPOSE.*HTML/i);
    expect(commerce).toMatch(/specification|comparison/i);
    expect(router).toContain('After route lock, for product listing or sales-creative work');
  });

  it('gives refusal and fidelity exhaustion the same requirement-preserving fallback owner', () => {
    const main = read('79df9cc89f5f', 'video-studio/SKILL.md');
    const fallback = main.split('## Material fallback')[1]?.split('\n## ')[0] || '';
    expect(fallback).toMatch(/accepted.*alternative/i);
    expect(fallback).toMatch(/static.*zoom/i);
    expect(read('79df9cc89f5f', 'video-studio/references/generation.md')).toContain('../SKILL.md#material-fallback');
    expect(read('79df9cc89f5f', 'video-studio/references/product-fidelity.md')).toContain('../SKILL.md#material-fallback');
  });
});
