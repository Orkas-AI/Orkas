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

describe('PPTX deterministic contrast audit', () => {
  it('catches inherited black placeholder text on a dark slide and removes the engine false positive', () => {
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

    const result = auditPptxContrast(rawIssues, presentationTree());
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

  it('uses WCAG relative luminance rather than simple palette brightness', () => {
    expect(contrastRatio('#000000', '#0F172A')).toBeCloseTo(1.18, 2);
    expect(contrastRatio('#38BDF8', '#1E293B')).toBeGreaterThan(6.8);
  });
});
