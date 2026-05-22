// Pin the `:::dashboard` directive renderer behavior in
// `src/renderer/modules/utils.js`.
//
// Set A — shapes the renderer MUST handle:
//   - every component type (Stack / Grid / Card / Separator / Metric /
//     Chart / Table / Alert / Timeline / Code / Markdown / Image)
//   - nested trees (Stack wrapping Grid wrapping Metric)
//   - props enum coercion (gap=md, columns=3, tone=positive, level=warning)
//   - $-prefixed escaping in text (no regex-replacement footgun)
//
// Set B — shapes the renderer MUST NOT break:
//   - existing `:::chart-bar` directive still renders alongside `:::dashboard`
//   - plain markdown (headings, lists, tables) around a `:::dashboard` block
//     parses normally
//   - malformed JSON falls back to `.dashboard-parse-error` code block,
//     does NOT silently drop the block and does NOT throw
//   - unknown component `type` renders an inert `<div class="db-unknown">`
//     (no exception, surrounding tree continues)
//
// Per PC/CLAUDE.md §9 (LLM-output text munging): adding any guard / new
// component / new enum value requires extending these fixtures and
// keeping every prior fixture green.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const { renderMarkdown, renderDashboard } = utils as {
  renderMarkdown: (md: string) => string;
  renderDashboard: (spec: unknown) => string;
};

function fence(spec: unknown): string {
  return '```fence-placeholder```\n\n:::dashboard\n' + JSON.stringify(spec) + '\n:::\n';
}

describe('renderDashboard — component coverage (set A)', () => {
  it('renders the root wrapper with theme data attrs', () => {
    const html = renderDashboard({ schema_version: 1, theme: { color: 'brand', style: 'card' }, root: null });
    expect(html).toMatch(/class="dashboard"/);
    expect(html).toMatch(/data-theme-color="brand"/);
    expect(html).toMatch(/data-theme-style="card"/);
  });

  it('Stack: respects direction + gap', () => {
    const html = renderDashboard({ root: { type: 'Stack', props: { direction: 'horizontal', gap: 'lg' }, children: [] } });
    expect(html).toMatch(/data-direction="horizontal"/);
    expect(html).toMatch(/data-gap="lg"/);
  });

  it('Grid: clamps columns to 1..4 and applies gap', () => {
    const html = renderDashboard({ root: { type: 'Grid', props: { columns: 99, gap: 'sm' }, children: [] } });
    expect(html).toMatch(/data-columns="4"/);
    expect(html).toMatch(/data-gap="sm"/);
  });

  it('Card: emits title + tone', () => {
    const html = renderDashboard({ root: { type: 'Card', props: { title: 'Status', tone: 'warning' }, children: [] } });
    expect(html).toMatch(/data-tone="warning"/);
    expect(html).toContain('Status');
  });

  it('Separator: renders <hr>', () => {
    const html = renderDashboard({ root: { type: 'Separator' } });
    expect(html).toMatch(/<hr class="db-separator">/);
  });

  it('Metric: label / value / delta with tone', () => {
    const html = renderDashboard({ root: { type: 'Metric', props: { label: 'Revenue', value: '$164B', delta: '+18%', tone: 'positive' } } });
    expect(html).toContain('Revenue');
    expect(html).toContain('$164B');
    expect(html).toContain('+18%');
    expect(html).toMatch(/db-metric-delta[^>]*data-tone="positive"/);
  });

  it('Alert: level + title + body', () => {
    const html = renderDashboard({ root: { type: 'Alert', props: { level: 'error', title: 'Down', body: 'Check uplink' } } });
    expect(html).toMatch(/data-level="error"/);
    expect(html).toContain('Down');
    expect(html).toContain('Check uplink');
  });

  it('Table: emits columns + rows with numeric alignment', () => {
    const html = renderDashboard({ root: { type: 'Table', props: {
      columns: [{ key: 'host', label: 'Host' }, { key: 'rtt', label: 'RTT', numeric: true }],
      rows: [{ host: '10.0.0.1', rtt: 12 }, { host: '10.0.0.2', rtt: 84 }],
    } } });
    expect(html).toContain('<th>Host</th>');
    expect(html).toContain('<th data-numeric="1">RTT</th>');
    expect(html).toContain('10.0.0.1');
    expect(html).toMatch(/<td data-numeric="1">12<\/td>/);
  });

  it('Timeline: enumerates items', () => {
    const html = renderDashboard({ root: { type: 'Timeline', props: { items: [
      { time: '09:00', label: 'Deploy', body: 'rollout v3.4' },
      { time: '09:12', label: 'Smoke OK' },
    ] } } });
    expect(html).toContain('09:00');
    expect(html).toContain('Deploy');
    expect(html).toContain('rollout v3.4');
    expect(html).toContain('Smoke OK');
  });

  it('Code: emits language attr', () => {
    const html = renderDashboard({ root: { type: 'Code', props: { lang: 'bash', code: 'ls -la' } } });
    expect(html).toMatch(/data-lang="bash"/);
    expect(html).toContain('ls -la');
  });

  it('Markdown: re-enters markdown renderer for nested text', () => {
    const html = renderDashboard({ root: { type: 'Markdown', props: { text: '## hi\n- one\n- two' } } });
    expect(html).toContain('<h2>hi</h2>');
    expect(html).toContain('<li>one');
    expect(html).toContain('<li>two');
  });

  it('Markdown: strips nested :::dashboard to prevent infinite recursion', () => {
    const html = renderDashboard({ root: { type: 'Markdown', props: { text: 'before\n:::dashboard\n{}\n:::\nafter' } } });
    expect(html).toContain('before');
    expect(html).toContain('after');
    // The stripped nested directive must not produce a second .dashboard wrap.
    expect(html.match(/class="dashboard"/g)).toHaveLength(1);
  });

  it('Image: src + alt + caption', () => {
    const html = renderDashboard({ root: { type: 'Image', props: { src: 'https://x.test/a.png', alt: 'A', caption: 'fig 1' } } });
    expect(html).toContain('src="https://x.test/a.png"');
    expect(html).toContain('alt="A"');
    expect(html).toContain('fig 1');
  });

  it('Chart bar: emits one <rect> per data point', () => {
    const html = renderDashboard({ root: { type: 'Chart', props: { kind: 'bar', data: [
      { x: 'a', y: 3 }, { x: 'b', y: 5 }, { x: 'c', y: 1 },
    ] } } });
    expect(html).toMatch(/data-kind="bar"/);
    expect((html.match(/<rect /g) || []).length).toBe(3);
  });

  it('Chart line: emits a <path class="db-chart-line">', () => {
    const html = renderDashboard({ root: { type: 'Chart', props: { kind: 'line', data: [
      { x: 't0', y: 0 }, { x: 't1', y: 4 },
    ] } } });
    expect(html).toMatch(/class="db-chart-line"/);
  });

  it('Chart pie: emits one slice per item and a legend', () => {
    const html = renderDashboard({ root: { type: 'Chart', props: { kind: 'pie', data: [
      { label: 'A', value: 1 }, { label: 'B', value: 2 }, { label: 'C', value: 3 },
    ] } } });
    expect((html.match(/db-chart-slice/g) || []).length).toBe(3);
    expect(html).toContain('class="db-chart-legend"');
  });

  it('nested tree: Stack → Grid → Metric × 3', () => {
    const html = renderDashboard({ root: { type: 'Stack', props: { gap: 'md' }, children: [
      { type: 'Grid', props: { columns: 3 }, children: [
        { type: 'Metric', props: { label: 'A', value: '1' } },
        { type: 'Metric', props: { label: 'B', value: '2' } },
        { type: 'Metric', props: { label: 'C', value: '3' } },
      ] },
    ] } });
    expect((html.match(/db-metric"/g) || []).length).toBe(3);
    expect(html).toMatch(/data-columns="3"/);
  });
});

describe('renderDashboard — defensive / unknown shapes (set A safety)', () => {
  it('unknown component type → inert placeholder, no throw', () => {
    const html = renderDashboard({ root: { type: 'Nonsense', props: {} } });
    expect(html).toContain('class="db-unknown"');
    expect(html).toContain('data-type="Nonsense"');
  });

  it('missing props on Metric → still renders empty fields, no throw', () => {
    expect(() => renderDashboard({ root: { type: 'Metric' } })).not.toThrow();
  });

  it('non-object spec → empty string', () => {
    expect(renderDashboard(null)).toBe('');
    expect(renderDashboard(42)).toBe('');
  });

  it('escapes HTML in user-supplied text', () => {
    const html = renderDashboard({ root: { type: 'Metric', props: { label: '<script>x</script>', value: '"q"' } } });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;q&quot;');
  });

  it('handles $ in value without regex-replacement breakage', () => {
    const html = renderDashboard({ root: { type: 'Metric', props: { label: 'Cost', value: '$1,234' } } });
    expect(html).toContain('$1,234');
  });
});

describe('renderMarkdown integration — set B (must not break existing surfaces)', () => {
  it(':::chart-bar still renders alongside :::dashboard', () => {
    const md = ':::chart-bar\n[{"label":"x","value":5}]\n:::\n\n:::dashboard\n' +
      JSON.stringify({ root: { type: 'Metric', props: { label: 'A', value: '1' } } }) + '\n:::';
    const html = renderMarkdown(md);
    expect(html).toContain('chart-bar-container');
    expect(html).toContain('db-metric');
  });

  it('plain markdown around a dashboard block parses normally', () => {
    const md = '# Title\n\nSome **bold** text.\n\n' +
      ':::dashboard\n' + JSON.stringify({ root: { type: 'Separator' } }) + '\n:::\n\n' +
      '- item 1\n- item 2\n';
    const html = renderMarkdown(md);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('db-separator');
    expect(html).toContain('<li>item 1');
  });

  it('malformed JSON in :::dashboard falls back to code-view, no throw', () => {
    const md = ':::dashboard\nnot { valid: json }\n:::';
    const html = renderMarkdown(md);
    expect(html).toContain('dashboard-parse-error');
    // raw body is preserved (HTML-escaped) so the user can copy it
    expect(html).toContain('not { valid: json }');
    // and NO .dashboard wrapper was emitted
    expect(html).not.toMatch(/class="dashboard"/);
  });

  it('unclosed :::dashboard at end of doc → not a dashboard, body kept', () => {
    const md = ':::dashboard\n{ "root": null }\n';
    const html = renderMarkdown(md);
    // The regex requires a closing :::, so an unclosed block stays as text.
    expect(html).not.toMatch(/class="dashboard"/);
    // The literal `:::dashboard` line ends up as paragraph text — that's fine,
    // the test pins the no-crash + no-wrong-render behavior, not the verbatim
    // pre-paragraph output (markdown phase 2 may shape it).
    expect(html.length).toBeGreaterThan(0);
  });
});
