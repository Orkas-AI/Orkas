import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { buildInspectScript } from '../../../src/main/features/video_studio';
import type { Issue } from '../../../src/main/features/video_studio_qa';
import { smallTextMessage } from '../../../src/main/features/video_timeline_render';

// The production page probe on a controlled DOM: one text element of a given size on a canvas.
// 2026-11-17 Luna explainer runs scored 58 and 67 for reading on a phone while the old 18 px
// floor never fired: on a 1080 px wide upright video, 18 px shows as 6 px on a 360 px phone.
function smallText(width: number, height: number, fontSize: string): Issue[] {
  const canvas = { left: 0, top: 0, width, height, right: width, bottom: height };
  const box = { left: Math.round(width * 0.2), top: Math.round(height * 0.3), width: 300, height: 80 };
  const rect = { ...box, right: box.left + box.width, bottom: box.top + box.height };
  const base = { display: 'block', visibility: 'visible', opacity: '1', color: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(0, 0, 0)', backgroundImage: 'none', backgroundClip: 'border-box',
    mixBlendMode: 'normal', filter: 'none', backdropFilter: 'none', maskImage: 'none', overflow: 'visible' };
  const body: any = {
    id: 'body', tagName: 'BODY', nodeType: 1, parentElement: null, children: [], childNodes: [],
    style: { ...base, fontSize: '42px' },
    getBoundingClientRect: () => canvas, getClientRects: () => [canvas], closest: () => null, getAttribute: () => null,
    contains(other: any) { for (let cur = other; cur; cur = cur.parentElement) if (cur === this) return true; return false; },
    scrollWidth: width, clientWidth: width, scrollHeight: height, clientHeight: height,
  };
  const text: any = {
    id: 'line', tagName: 'SPAN', nodeType: 1, parentElement: body, children: [],
    childNodes: [{ nodeType: 3, textContent: 'Readable line' }],
    style: { ...base, fontSize },
    getBoundingClientRect: () => rect, getClientRects: () => [rect], closest: () => null, getAttribute: () => null,
    contains: (other: any) => other === text,
    scrollWidth: box.width, clientWidth: box.width, scrollHeight: box.height, clientHeight: box.height,
  };
  body.children.push(text);
  body.querySelectorAll = () => [text];
  return runInNewContext(buildInspectScript({ width, height } as any, 0), {
    document: { body, documentElement: null, elementsFromPoint: () => [text, body] },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, getComputedStyle: (el: any) => el.style,
  }).filter((issue: Issue) => issue.code === 'FONT_TOO_SMALL');
}

describe('small text, judged at the size a phone shows it', () => {
  it('asks for about 14 px on a phone: 42 px on a 1080 px wide upright video', () => {
    const [issue] = smallText(1080, 1920, '36px');
    expect(issue?.message).toBe('[0.00s] text is 36px, under the 42px it needs to be read when this video fills a phone screen.');
    expect(issue?.evidence).toMatchObject({ font_size_px: 36, minimum_px: 42 });
    expect(smallText(1080, 1920, '42px')).toEqual([]);
  });

  it('measures a wide video by its short side, as it fills a phone held sideways', () => {
    expect(smallText(1920, 1080, '38px')[0]?.evidence).toMatchObject({ minimum_px: 42 });
    expect(smallText(1920, 1080, '48px')).toEqual([]);
  });

  it('scales with a smaller canvas', () => {
    expect(smallText(720, 1280, '30px')).toEqual([]);
    expect(smallText(720, 1280, '24px')[0]?.evidence).toMatchObject({ minimum_px: 28 });
  });

  it('still catches the page whose styles were dropped, which falls back to 16 px', () => {
    expect(smallText(1080, 1920, '16px')).toHaveLength(1);
  });
});

describe('the check\'s small-text hint', () => {
  it('names the size this canvas needs and what to enlarge', () => {
    const message = smallTextMessage(['hook', 'end'], [
      { code: 'SCENE_STATIC' },
      { code: 'FONT_TOO_SMALL', evidence: { font_size_px: 30, minimum_px: 42 } },
    ]);
    expect(message).toBe('Text in hook, end is under 42px, about 14px when the video fills a phone screen, so it may be too small to read on a phone.'
      + ' Enlarge what viewers must read (the main line, labels, captions and the end card\'s call to action) or say less;'
      + ' small print they need not read can stay. If you did not set that size, a CSS error may have dropped the page\'s styles.');
  });

  it('still says so without a measured minimum', () => {
    expect(smallTextMessage(['a'], [{ code: 'FONT_TOO_SMALL' }])).toContain('Text in a is small, so it may be too small to read on a phone.');
  });
});

describe('guidance that agrees with the check', () => {
  const skills = path.join(__dirname, '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills');
  const read = (relative: string) => fs.readFileSync(path.join(skills, relative), 'utf8').replace(/\s+/g, ' ');

  it('states the phone size, not the old 18 px or 28 px floors', () => {
    const craft = read('video-craft/SKILL.md');
    expect(craft).toContain('body 42–54 px; native QA flags text under 42 px there, about 14 px on a phone');
    expect(craft).toContain('native QA flags what is under about 14 px on a phone');
    expect(craft).not.toMatch(/18 ?px/);
    const presets = read('frontend-design/references/design-presets.md');
    expect(presets).toContain('what viewers must read at least 42px on a 1080px short side (about 14px on a phone); small print never below 22px.');
    expect(presets).not.toContain('body copy at least 28px');
  });

  it('asks ads for stills that can move and gives each one a move', () => {
    const marketing = read('video-craft/references/marketing.md');
    expect(marketing).toContain('Ask for stills the page can move: wider than the frame with the subject clear of the edges');
    expect(marketing).toContain('One key image cannot carry the whole ad.');
    expect(marketing).toContain('Give each still one move that shows what its line points at');
    expect(marketing).toContain('A picture that only sits while the words change reads as a slide; the end card can hold still.');
  });
});
