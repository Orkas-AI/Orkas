import { describe, expect, it } from 'vitest';

import {
  auditPptxContrast,
  contrastRatio,
} from '../../../../src/main/model/core-agent/pptx-contrast';

function presentationTree(background: string = '#0F172A') {
  return {
    success: true,
    data: {
      path: '/',
      type: 'presentation',
      format: {
        'theme.color.dk1': '#000000',
        'theme.color.lt1': '#FFFFFF',
      },
      children: [{
        path: '/slide[1]',
        type: 'slide',
        format: { background },
        children: [
          {
            path: '/slide[1]/shape[1]',
            type: 'shape',
            children: [{
              path: '/slide[1]/shape[1]/p[1]/r[1]',
              type: 'run',
              text: 'AI 办公助手',
              format: { 'effective.size': '44pt' },
            }],
          },
          {
            path: '/slide[1]/shape[2]',
            type: 'shape',
            format: { fill: '#1E293B' },
            children: [{
              path: '/slide[1]/shape[2]/p[1]/r[1]',
              type: 'run',
              text: '01',
              format: { color: '#38BDF8', size: '24pt' },
            }],
          },
        ],
      }],
    },
  };
}

function layeredSlide(...objects: Array<Record<string, unknown>>) {
  const tree = presentationTree('#101010');
  Object.assign(tree.data.children[0], { children: objects });
  return tree;
}

function panel(order: number, properties: Record<string, unknown> = {}) {
  return {
    type: 'shape',
    path: `/slide[1]/shape[@id=${order}]`,
    format: { geometry: 'rect', zorder: order,
      x: '1in', y: '2.54cm', width: '152.4mm', height: '216pt', fill: '#F5C14E', ...properties },
  };
}

const layeredText = {
  type: 'shape',
  path: '/slide[1]/shape[@id=20]',
  text: 'Fixture title',
  format: { geometry: 'rect', zorder: 20, x: '5.08cm', y: '5.08cm', width: '10.16cm', height: '2.54cm',
    fill: 'none', color: '#101010', size: '28pt' },
};

describe('PPTX deterministic contrast audit', () => {
  it('does not block text on an opaque covering panel, even when the tree lists it after the text', () => {
    const upstream = { issues: [
      { id: 'contrast', subtype: 'low_contrast', path: layeredText.path, severity: 'blocker' },
      { id: 'unrelated', subtype: 'shape_out_of_bounds', path: layeredText.path, severity: 'warning' },
    ] };
    const result = auditPptxContrast(upstream, layeredSlide(layeredText, panel(10), panel(5, { width: '2in', rotation: '20' })));
    expect(result).toMatchObject({ issues: { issues: [upstream.issues[1]] }, findingCount: 0, scannedTextCount: 1 });
  });

  it('blocks genuinely low contrast on the closest opaque panel over a brighter one', () => {
    const result = auditPptxContrast({ issues: [] }, layeredSlide(panel(10, { fill: '#202020' }), layeredText, panel(5)));
    expect(result.issues).toMatchObject({ issues: [{
      path: layeredText.path, severity: 'blocker', subtype: 'low_contrast', background: '#202020', contrast_ratio: 1.17,
    }] });
  });

  it.each([
    ['partial coverage', panel(10, { width: '3in' })],
    ['half-opacity fill', panel(10, { opacity: '0.5' })],
    ['an alpha color', panel(10, { fill: '#F5C14E80' })],
    ['rotation', panel(10, { rotation: '20' })],
    ['rounded corners', panel(10, { geometry: 'roundRect' })],
    ['another text box', { ...panel(10), text: 'Other content in the backing shape' }],
    ['a front layer', panel(30)],
    ['unknown order', panel(10, { zorder: undefined })],
    ['conflicting order', panel(10, { zorder: 20 })],
  ])('flags %s for visual review without guessing a ratio', (_label, obstacle) => {
    const result = auditPptxContrast({ issues: [
      { id: 'old-guess', subtype: 'low_contrast', severity: 'blocker', path: layeredText.path },
    ] }, layeredSlide(panel(5), layeredText, obstacle));
    const issues = (result.issues as { issues: Array<Record<string, unknown>> }).issues;
    expect(issues).toEqual([expect.objectContaining({
      subtype: 'contrast_needs_visual_review', path: layeredText.path, severity: 'warning',
      message: expect.stringContaining('Render slide 1'),
    })]);
    expect(issues[0]).not.toHaveProperty('contrast_ratio');
  });

  it('leaves the slide background authoritative when the nearby panel is outside the text bounds', () => {
    const result = auditPptxContrast({ issues: [] }, layeredSlide(layeredText, panel(10, { x: '8in' })));
    expect(result.issues).toMatchObject({ issues: [{
      path: layeredText.path, severity: 'blocker', background: '#101010', contrast_ratio: 1,
    }] });
  });

  it('audits the native title type without treating paragraph containers as separate objects', () => {
    const tree = presentationTree('#10243A');
    tree.data.format['theme.color.dk1'] = '#10243A';
    const title = tree.data.children[0].children[0] as any;
    title.type = 'title';
    title.path = '/slide[1]/shape[@id=2]';
    title.children = [{ type: 'paragraph', children: [{
      type: 'run', text: 'Value starts with a pilot', format: { 'effective.size': '44pt' },
    }] }];

    const result = auditPptxContrast({ issues: [] }, tree);
    expect(result.scannedTextCount).toBe(2);
    expect((result.issues as any).issues).toContainEqual(expect.objectContaining({
      path: title.path, severity: 'blocker', foreground: '#10243A',
      background: '#10243A', contrast_ratio: 1,
    }));
    title.children[0].children[0].format.color = '#FFFFFF';
    expect(auditPptxContrast({ issues: [] }, tree).findingCount).toBe(0);
  });

  it.each(['bare', 'direct', 'query'] as const)('audits %s tree output, catching dark-slide text without retaining an engine false positive', (envelope) => {
    const rawIssues = {
      success: true,
      data: {
        count: 2,
        issues: [
          {
            id: 'C1',
            subtype: 'low_contrast',
            severity: 'warning',
            path: '/slide[1]/shape[2]',
            message: 'Low-contrast text #38BDF8 on dark fill — unreadable on projection.',
          },
          {
            id: 'F1',
            type: 'format',
            severity: 'warning',
            path: '/slide[1]/shape[3]',
            message: 'Unrelated issue',
          },
        ],
      },
    };

    const tree = presentationTree();
    const input = envelope === 'bare' ? tree.data
      : envelope === 'query' ? { success: true, data: { matches: 1, results: [tree.data] } }
        : tree;
    const result = auditPptxContrast(rawIssues, input);
    const output = result.issues as any;

    expect(result).toMatchObject({ findingCount: 1, scannedTextCount: 2 });
    expect(output.data.count).toBe(2);
    expect(output.data.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'F1' }),
      expect.objectContaining({
        subtype: 'low_contrast',
        severity: 'blocker',
        path: '/slide[1]/shape[1]',
        foreground: '#000000',
        background: '#0F172A',
        contrast_ratio: 1.18,
      }),
    ]));
    expect(output.data.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'C1' }),
    ]));
  });

  it('does not replace engine findings when an explicit gradient background is not auditable', () => {
    const rawIssues = {
      issues: [{
        id: 'C1',
        subtype: 'low_contrast',
        path: '/slide[1]/shape[1]',
        message: 'Low-contrast text on a gradient.',
      }],
    };

    const result = auditPptxContrast(rawIssues, presentationTree('112233-445566-45'));

    expect(result).toMatchObject({ findingCount: 0, scannedTextCount: 1 });
    expect((result.issues as any).issues).toEqual(rawIssues.issues);
  });

  it('only warns when the compared background is the theme default rather than a declared fill', () => {
    // A full-bleed picture is a sibling shape the tree does not represent, so
    // white text over it compares against the theme's white default. That is
    // not proof of an unreadable slide; ppt-review treats a blocker as
    // unpublishable, so the audit must not manufacture one from a guess.
    const tree = presentationTree();
    const slide = (tree.data.children[0] as any);
    // No slide background declared at all: the audit falls back to lt1.
    slide.format = {};
    slide.children[0].children[0].format = { 'effective.size': '44pt', color: '#FFFFFF' };

    const result = auditPptxContrast({ issues: [] }, tree);

    expect(result.findingCount).toBe(1);
    const issue = (result.issues as any).issues[0];
    expect(issue).toMatchObject({
      subtype: 'low_contrast',
      severity: 'warning',
      path: '/slide[1]/shape[1]',
      background: '#FFFFFF',
    });
    expect(issue.message).toContain('theme default');
  });

  it('keeps a blocker when the unreadable text sits on a fill the deck declares', () => {
    const tree = presentationTree('#FFFFFF');
    const slide = (tree.data.children[0] as any);
    slide.children[0].children[0].format = { 'effective.size': '44pt', color: '#FFFFFF' };

    const issue = (auditPptxContrast({ issues: [] }, tree).issues as any).issues[0];

    expect(issue).toMatchObject({ severity: 'blocker', path: '/slide[1]/shape[1]' });
    expect(issue.message).not.toContain('theme default');
  });

  it.each([[], [null], [{ path: '/slide[1]', type: 'slide' }]].map(results => ({ results })))(
    'preserves engine findings when query output has no presentation root: %j', ({ results }) => {
      const rawIssues = { issues: [{ id: 'existing', subtype: 'low_contrast', path: '/slide[1]/shape[1]' }] };
      const result = auditPptxContrast(rawIssues, { success: true, data: { matches: results.length, results } });
      expect(result).toMatchObject({ findingCount: 0, scannedTextCount: 0 });
      expect((result.issues as any).issues).toEqual(rawIssues.issues);
    },
  );

  it('does not select an arbitrary presentation from ambiguous query results', () => {
    const root = presentationTree().data;
    const rawIssues = { issues: [{ id: 'existing' }] };
    const result = auditPptxContrast(rawIssues, { success: true, data: { matches: 2, results: [root, root] } });
    expect(result).toMatchObject({ findingCount: 0, scannedTextCount: 0 });
    expect((result.issues as any).issues).toEqual(rawIssues.issues);
  });

  it('uses WCAG relative luminance rather than simple palette brightness', () => {
    expect(contrastRatio('#000000', '#0F172A')).toBeCloseTo(1.18, 2);
    expect(contrastRatio('#38BDF8', '#1E293B')).toBeGreaterThan(6.8);
  });
});
