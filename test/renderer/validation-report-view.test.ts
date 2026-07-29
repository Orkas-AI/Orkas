import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type Listener = (event?: any) => void;

class FakeButton {
  readonly listeners = new Map<string, Listener>();
  focused = false;

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  focus(): void {
    this.focused = true;
  }

  click(): void {
    this.listeners.get('click')?.({ target: this });
  }

  closest(selector: string): FakeButton | null {
    return selector.includes('button') ? this : null;
  }
}

class FakeOverlay {
  className = '';
  innerHTML = '';
  removed = false;
  readonly okButton = new FakeButton();
  readonly forceButton = new FakeButton();

  querySelector(selector: string): FakeButton | null {
    if (selector === '[data-act="ok"]') return this.okButton;
    if (selector === '[data-act="force"]' && this.innerHTML.includes('data-act="force"')) {
      return this.forceButton;
    }
    return null;
  }

  remove(): void {
    this.removed = true;
  }
}

function loadValidationReportView() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/validation-report-view.js'),
    'utf8',
  );
  const overlays: FakeOverlay[] = [];
  const documentListeners = new Map<string, Listener>();
  const qualityCalls: Array<{ kind: 'skill' | 'agent'; id: string }> = [];
  const qualityResponses = new Map<string, unknown>();
  const translations: Record<string, string> = {
    'common.close': 'Close',
    'quality.empty': 'No findings.',
    'quality.level.EXTREME': 'Critical',
    'quality.level.MEDIUM': 'Warning',
    'quality.level.LOW': 'Advice',
    'quality.fix.no_eval_with_external_input': 'Use a fixed command.',
  };
  const context: any = {
    console,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    escapeHtml: (value: unknown) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;'),
    t: (key: string) => translations[key] || key,
    document: {
      body: {
        appendChild: (overlay: FakeOverlay) => overlays.push(overlay),
      },
      createElement: () => new FakeOverlay(),
      addEventListener: (type: string, listener: Listener) => {
        documentListeners.set(type, listener);
      },
      removeEventListener: (type: string, listener: Listener) => {
        if (documentListeners.get(type) === listener) documentListeners.delete(type);
      },
    },
    window: {
      orkas: {
        quality: {
          readSkillReport: async (id: string) => {
            qualityCalls.push({ kind: 'skill', id });
            return qualityResponses.get(`skill:${id}`) ?? { report: null };
          },
          readAgentReport: async (id: string) => {
            qualityCalls.push({ kind: 'agent', id });
            return qualityResponses.get(`agent:${id}`) ?? { report: null };
          },
        },
      },
    },
    _overlays: overlays,
    _documentListeners: documentListeners,
    _qualityCalls: qualityCalls,
    _qualityResponses: qualityResponses,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'validation-report-view.js' });
  return context;
}

describe('quality validation report renderer', () => {
  it('sorts findings by severity, localizes fixes, and escapes report-controlled text', async () => {
    const ctx = loadValidationReportView();
    const report = {
      ok: false,
      violations: [
        {
          level: 'LOW',
          rule: 'low_rule',
          field: 'description',
          snippet: 'safe',
          suggested_fix: 'Low fix',
        },
        {
          level: 'EXTREME',
          rule: 'no_eval_with_external_input',
          field: '<img src=x onerror=alert(1)>',
          snippet: '<script>steal()</script>',
          suggested_fix: '<b>unsafe fallback</b>',
        },
        {
          level: 'MEDIUM',
          rule: 'medium_rule',
          field: 'name',
          snippet: '',
          suggested_fix: 'Medium fix',
        },
      ],
    };

    const result = ctx.showValidationReport({
      title: '<img src=x onerror=alert(2)>',
      report,
      forceLabel: 'Install anyway',
    });
    const overlay = ctx._overlays[0] as FakeOverlay;
    const html = overlay.innerHTML;

    expect(html.indexOf('no_eval_with_external_input')).toBeLessThan(html.indexOf('medium_rule'));
    expect(html.indexOf('medium_rule')).toBeLessThan(html.indexOf('low_rule'));
    expect(html).toContain('Use a fixed command.');
    expect(html).not.toContain('unsafe fallback');
    expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
    expect(html).not.toContain('<script>steal()</script>');
    expect(html).not.toContain('<img src=x');
    expect(report.violations.map((violation) => violation.level)).toEqual(['LOW', 'EXTREME', 'MEDIUM']);

    overlay.okButton.click();
    await expect(result).resolves.toBe('close');
    expect(overlay.removed).toBe(true);
    expect(ctx._documentListeners.has('keydown')).toBe(false);
  });

  it('lets keyboard activation of the focused override button choose force', async () => {
    const ctx = loadValidationReportView();
    const result = ctx.showValidationReport({
      report: { ok: false, violations: [] },
      forceLabel: 'Install anyway',
    });
    const overlay = ctx._overlays[0] as FakeOverlay;
    overlay.forceButton.focus();

    ctx._documentListeners.get('keydown')?.({
      key: 'Enter',
      keyCode: 13,
      isComposing: false,
      target: overlay.forceButton,
    });
    if (!overlay.removed) overlay.forceButton.click();

    await expect(result).resolves.toBe('force');
  });

  it('skips malformed findings instead of losing the whole recovery dialog', async () => {
    const ctx = loadValidationReportView();
    const result = ctx.showValidationReport({
      report: {
        ok: false,
        violations: [
          null,
          7,
          {},
          {
            level: 'EXTREME',
            rule: 'no_eval_with_external_input',
            field: 'scripts/run.js',
            snippet: 'eval(userInput)',
            suggested_fix: 'fallback',
          },
        ],
      },
    });
    const overlay = ctx._overlays[0] as FakeOverlay;

    expect(overlay.innerHTML).toContain('no_eval_with_external_input');
    expect(overlay.innerHTML.match(/class="quality-violation"/g)).toHaveLength(1);
    overlay.okButton.click();
    await expect(result).resolves.toBe('close');
  });

  it('fails closed on unsafe report identifiers before crossing IPC', async () => {
    const ctx = loadValidationReportView();

    await expect(ctx.readQualityReport('skill', '../config/auth-profiles')).resolves.toBeNull();
    await expect(ctx.readQualityReport('agent', 'writer/../../secret')).resolves.toBeNull();
    await expect(ctx.readQualityReport('skill', 'safe-skill_1')).resolves.toBeNull();

    expect(ctx._qualityCalls).toEqual([{ kind: 'skill', id: 'safe-skill_1' }]);
  });

  it('returns only successful structured report responses', async () => {
    const ctx = loadValidationReportView();
    const report = {
      ok: false,
      violations: [],
      validated_at: '2026-07-25T00:00:00.000Z',
      validator_version: '1',
    };
    ctx._qualityResponses.set('agent:writer', { report });
    ctx._qualityResponses.set('skill:broken', { ok: false, report });

    await expect(ctx.readQualityReport('agent', 'writer')).resolves.toEqual(report);
    await expect(ctx.readQualityReport('skill', 'broken')).resolves.toBeNull();
    await expect(ctx.readQualityReport('other', 'writer')).resolves.toBeNull();
    await expect(ctx.readQualityReport('agent', '')).resolves.toBeNull();
  });
});
