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
const { renderMarkdown, renderDashboard, _parseDashboardSpec } = utils as {
  renderMarkdown: (md: string) => string;
  renderDashboard: (spec: unknown) => string;
  _parseDashboardSpec: (body: string) => unknown;
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
    expect(html).toContain('class="db-alert-icon"');
    expect(html).toContain('class="db-alert-content"');
    expect(html).toContain('Down');
    expect(html).toContain('Check uplink');
  });

  it('Alert: accepts common model-guess text aliases', () => {
    const html = renderDashboard({ root: { type: 'Alert', props: { level: 'warning', message: 'Quota near limit' } } });
    expect(html).toMatch(/data-level="warning"/);
    expect(html).toContain('Quota near limit');
    expect(html).not.toContain('db-alert-body');
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

  it('Markdown: accepts `content` as an alias for `text` (model-guess shape)', () => {
    const html = renderDashboard({ root: { type: 'Markdown', props: { content: '## body\nparagraph' } } });
    expect(html).toContain('<h2>body</h2>');
    expect(html).toContain('paragraph');
  });

  it('Markdown: `text` wins when both fields are present', () => {
    const html = renderDashboard({ root: { type: 'Markdown', props: { text: 'from-text', content: 'from-content' } } });
    expect(html).toContain('from-text');
    expect(html).not.toContain('from-content');
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

  it('children nested under props (React-style) still render', () => {
    const html = renderDashboard({ root: { type: 'Stack', props: { gap: 'md', children: [
      { type: 'Card', props: { children: [
        { type: 'Metric', props: { label: 'Stars', value: '103k' } },
      ] } },
      { type: 'Grid', props: { columns: 2, children: [
        { type: 'Metric', props: { label: 'A', value: '1' } },
        { type: 'Metric', props: { label: 'B', value: '2' } },
      ] } },
    ] } } });
    expect((html.match(/db-metric"/g) || []).length).toBe(3);
    expect(html).toContain('Stars');
    expect(html).toContain('103k');
    expect(html).toMatch(/data-columns="2"/);
  });

  it('node-level children win over props.children when both present', () => {
    const html = renderDashboard({ root: { type: 'Card', props: { children: [
      { type: 'Metric', props: { label: 'FromProps', value: 'x' } },
    ] }, children: [
      { type: 'Metric', props: { label: 'FromNode', value: 'y' } },
    ] } });
    expect(html).toContain('FromNode');
    expect(html).not.toContain('FromProps');
  });

  it('Alert: renders child nodes as body when no text prop is present', () => {
    const html = renderDashboard({ root: { type: 'Alert', props: { level: 'info', children: [
      { type: 'Markdown', props: { text: '**one-liner** summary' } },
    ] } } });
    expect(html).toMatch(/data-level="info"/);
    expect(html).toContain('class="db-alert-body"');
    expect(html).toContain('<strong>one-liner</strong>');
    expect(html).toContain('summary');
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

  it('empty Alert → no blank colored block', () => {
    const html = renderDashboard({ root: { type: 'Alert', props: { level: 'info' } } });
    expect(html).toContain('class="dashboard"');
    expect(html).not.toContain('class="db-alert"');
    expect(html).not.toContain('class="db-alert-icon"');
  });
});

describe('_parseDashboardSpec — tolerant parse (matching + look-alike non-matching)', () => {
  it('strict-valid JSON parses unchanged', () => {
    expect(_parseDashboardSpec('{"root":{"type":"Separator"}}'))
      .toEqual({ root: { type: 'Separator' } });
  });

  it('repair 1: one extra trailing `}` after the root close', () => {
    expect(_parseDashboardSpec('{"a":1}\n}')).toEqual({ a: 1 });
  });

  it('repair 1: trailing prose after a complete object is dropped', () => {
    expect(_parseDashboardSpec('{"a":1}\n\nhope this helps!')).toEqual({ a: 1 });
  });

  it('repair 2: truncated tail gets the missing closers appended (innermost first)', () => {
    expect(_parseDashboardSpec('{"a":1,"b":[1,2')).toEqual({ a: 1, b: [1, 2] });
  });

  it('string-aware: a `}` inside a string value never shifts the depth count', () => {
    // Without string-awareness the brace in the body would be counted as a
    // close and the real extra `}` would be mis-located.
    expect(_parseDashboardSpec('{"body":"done 100% } ok"}\n}'))
      .toEqual({ body: 'done 100% } ok' });
  });

  it('escaped quote inside a string does not end the string early', () => {
    expect(_parseDashboardSpec('{"q":"a\\"b"}\n}')).toEqual({ q: 'a"b' });
  });

  it('quote repair: unescaped quote pair inside a string value is escaped', () => {
    const body = `{"root":{"type":"Table","props":{"columns":[{"key":"title","label":"标题"}],"rows":[{"title":"【TF家族练习生】挑战给爸爸打电话说出"我爱你""}]}}}`;
    expect(_parseDashboardSpec(body)).toEqual({
      root: {
        type: 'Table',
        props: {
          columns: [{ key: 'title', label: '标题' }],
          rows: [{ title: '【TF家族练习生】挑战给爸爸打电话说出"我爱你"' }],
        },
      },
    });
  });

  it('repair: extra child-closing brace before the next sibling is dropped', () => {
    const body = `{
"root": { "type": "Stack", "children": [
{ "type": "Table", "props": { "columns": [{"key":"x","label":"X"}], "rows": [{"x":"A"}] } } },
{ "type": "Table", "props": { "columns": [{"key":"y","label":"Y"}], "rows": [{"y":"B"}] } } }
] }
}`;
    expect(_parseDashboardSpec(body)).toEqual({
      root: {
        type: 'Stack',
        children: [
          { type: 'Table', props: { columns: [{ key: 'x', label: 'X' }], rows: [{ x: 'A' }] } },
          { type: 'Table', props: { columns: [{ key: 'y', label: 'Y' }], rows: [{ y: 'B' }] } },
        ],
      },
    });
  });

  it('non-matching: leading non-JSON garbage is NOT repaired → undefined', () => {
    expect(_parseDashboardSpec('not { valid: json }')).toBeUndefined();
  });

  it('non-matching: empty / whitespace body → undefined', () => {
    expect(_parseDashboardSpec('   ')).toBeUndefined();
    expect(_parseDashboardSpec('')).toBeUndefined();
  });

  it('non-matching: irreparable junk → undefined (caller shows fallback)', () => {
    expect(_parseDashboardSpec('{{{')).toBeUndefined();
  });
});

describe('renderMarkdown integration — set B (must not break existing surfaces)', () => {
  const workBuddySpec = {
    schema_version: 1,
    root: {
      type: 'Stack',
      props: { gap: 'md' },
      children: [
        {
          type: 'Grid',
          props: { columns: 3 },
          children: [
            { type: 'Metric', props: { label: '内测期留存率', value: '~60%', tone: 'positive' } },
            { type: 'Metric', props: { label: 'PC端月访问量', value: '885万', tone: 'positive' } },
            { type: 'Metric', props: { label: '全平台DAU(估)', value: '1300万+', tone: 'positive' } },
          ],
        },
        { type: 'Separator', props: {} },
        {
          type: 'Alert',
          props: {
            level: 'info',
            children: [
              {
                type: 'Markdown',
                props: {
                  text: '以上为公开报道汇总，非腾讯官方精确披露。',
                },
              },
            ],
          },
        },
      ],
    },
  };

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

  it('dashboard JSON emitted as a json code fence renders as a dashboard', () => {
    const md = '基于公开资料搜索，以下是关于 WorkBuddy 用户留存的全景分析。\n\n```json\n' +
      JSON.stringify(workBuddySpec, null, 2) +
      '\n```\n\n---\n\n## 一、已知的留存相关数据';
    const html = renderMarkdown(md);
    expect(html).toMatch(/class="dashboard"/);
    expect(html).toContain('内测期留存率');
    expect(html).toContain('1300万+');
    expect(html).toContain('以上为公开报道汇总');
    expect(html).toContain('<h2>一、已知的留存相关数据</h2>');
    expect(html).not.toContain('<pre><code>');
  });

  it('dashboard JSON still renders when a json fence opener misses the newline before JSON', () => {
    const md = '```json' + JSON.stringify(workBuddySpec, null, 2) + '\n```';
    const html = renderMarkdown(md);
    expect(html).toMatch(/class="dashboard"/);
    expect(html).toContain('内测期留存率');
    expect(html).toContain('以上为公开报道汇总');
    expect(html).not.toContain('<pre><code>');
  });

  it('dashboard JSON still renders when the fence info string is the JSON itself', () => {
    const md = '```' + JSON.stringify(workBuddySpec, null, 2) + '\n```';
    const html = renderMarkdown(md);
    expect(html).toMatch(/class="dashboard"/);
    expect(html).toContain('PC端月访问量');
    expect(html).not.toContain('<pre><code>');
  });

  it('dashboard directive accepts an inner json code fence', () => {
    const md = ':::dashboard\n```json\n' + JSON.stringify(workBuddySpec) + '\n```\n:::';
    const html = renderMarkdown(md);
    expect(html).not.toContain('dashboard-parse-error');
    expect(html.match(/class="dashboard"/g)).toHaveLength(1);
    expect(html).toContain('PC端月访问量');
  });

  it('standalone dashboard JSON block renders when the model omits fences', () => {
    const md = '# WorkBuddy 用户留存深度分析\n\n' +
      JSON.stringify(workBuddySpec, null, 2) +
      '\n\n## 一、已知的留存相关数据';
    const html = renderMarkdown(md);
    expect(html).toContain('<h1>WorkBuddy 用户留存深度分析</h1>');
    expect(html).toMatch(/class="dashboard"/);
    expect(html).toContain('全平台DAU(估)');
    expect(html).toContain('<h2>一、已知的留存相关数据</h2>');
  });

  it('ordinary json code blocks stay as code', () => {
    const md = '```json\n{"root":{"type":"NotDashboard"},"value":1}\n```';
    const html = renderMarkdown(md);
    expect(html).toContain('<pre><code>');
    expect(html).toContain('&quot;NotDashboard&quot;');
    expect(html).not.toMatch(/class="dashboard"/);
  });

  it('ordinary same-line fenced json stays code when it is not dashboard-shaped', () => {
    const md = '```json{"root":{"type":"NotDashboard"},"value":1}\n```';
    const html = renderMarkdown(md);
    expect(html).toContain('<pre><code>');
    expect(html).not.toMatch(/class="dashboard"/);
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

  it('extra trailing `}` (the DeepSeek miscount) still renders the dashboard', () => {
    // Reproduces the field report: a structurally complete tree with one
    // surplus `}` after the root close. Strict JSON.parse rejects it; the
    // repair drops the trailing brace so the Alert renders instead of
    // collapsing to a raw code-view block.
    const md = ':::dashboard\n' +
      '{\n"schema_version": 1,\n' +
      '"root": { "type": "Stack", "props": { "gap": "md" }, "children": [\n' +
      '{ "type": "Alert", "props": { "level": "warning", "title": "Funding", "body": "x" } }\n' +
      '] } }\n}\n:::';
    const html = renderMarkdown(md);
    expect(html).not.toContain('dashboard-parse-error');
    expect(html).toMatch(/class="dashboard"/);
    expect(html).toMatch(/data-level="warning"/);
    expect(html).toContain('Funding');
  });

  it('missing child object close before parent array still renders the dashboard', () => {
    const md = `:::dashboard
{
"schema_version": 1,
"root": { "type": "Stack", "props": { "gap": "md" }, "children": [
{ "type": "Grid", "props": { "columns": 3 }, "children": [
{ "type": "Metric", "props": { "label": "内测期留存率", "value": "~60%", "tone": "positive" } },
{ "type": "Metric", "props": { "label": "PC端月访问量", "value": "885万", "tone": "positive" } },
{ "type": "Metric", "props": { "label": "全平台DAU(估)", "value": "1300万+", "tone": "positive" } }
]},
{ "type": "Separator", "props": {} },
{ "type": "Alert", "props": { "level": "info", "children": [ { "type": "Markdown", "props": { "text": "以上为公开报道汇总，非腾讯官方精确披露。" } } ] }
]
}
}
:::`;
    const html = renderMarkdown(md);
    expect(html).not.toContain('dashboard-parse-error');
    expect(html).toMatch(/class="dashboard"/);
    expect(html).toContain('内测期留存率');
    expect(html).toContain('以上为公开报道汇总');
  });

  it('unescaped quotes inside a dashboard string still render the dashboard', () => {
    const md = `:::dashboard
{"root":{"type":"Table","props":{"columns":[{"key":"title","label":"标题"}],"rows":[{"title":"【TF家族练习生】挑战给爸爸打电话说出"我爱你""}]}}}
:::`;
    const html = renderMarkdown(md);
    expect(html).not.toContain('dashboard-parse-error');
    expect(html).toContain('class="db-table"');
    expect(html).toContain('说出&quot;我爱你&quot;');
  });

  it('extra child-closing brace between dashboard siblings still renders the dashboard', () => {
    const md = `:::dashboard
{
"schema_version": 1,
"root": { "type": "Stack", "children": [
{ "type": "Table", "props": { "columns": [{"key":"x","label":"X"}], "rows": [{"x":"A"}] } } },
{ "type": "Table", "props": { "columns": [{"key":"y","label":"Y"}], "rows": [{"y":"B"}] } } }
] }
}
:::`;
    const html = renderMarkdown(md);
    expect(html).not.toContain('dashboard-parse-error');
    expect(html).toMatch(/class="dashboard"/);
    expect((html.match(/class="db-table"/g) || []).length).toBe(2);
    expect(html).toContain('<td>A</td>');
    expect(html).toContain('<td>B</td>');
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
