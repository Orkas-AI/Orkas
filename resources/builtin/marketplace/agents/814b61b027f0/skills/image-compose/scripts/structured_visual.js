'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KINDS = new Set(['diagram', 'bar', 'line', 'donut']);
const DEFAULT_COLORS = ['#6d5dfc', '#17b890', '#ffb547', '#ef6f6c', '#4ea5d9', '#b86bff'];

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  const result = String(value == null ? '' : value).trim();
  return result || fallback;
}

function number(value, fallback, min, max) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) fail('E_STRUCTURED_VISUAL_SPEC', `number must be from ${min} to ${max}`);
  return result;
}

function xml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paint(value, fallback) {
  const result = text(value, fallback);
  if (!/^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.%+,\s-]+\)|[a-z]{1,24})$/i.test(result)) {
    fail('E_STRUCTURED_VISUAL_SPEC', 'theme and node colors must be static CSS colors');
  }
  return result;
}

function parseArgs(args) {
  const out = { project: '', input: '', output: '' };
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const next = () => {
      if (index + 1 >= args.length) fail('E_STRUCTURED_VISUAL_ARGS', `${current} requires a value`);
      index += 1;
      return args[index];
    };
    if (current === '--project' || current === '--project-dir') out.project = next();
    else if (current === '--input' || current === '-i') out.input = next();
    else if (current === '--output' || current === '-o') out.output = next();
    else fail('E_STRUCTURED_VISUAL_ARGS', `unknown argument: ${current}`);
  }
  if (!out.project || !out.input || !out.output) fail('E_STRUCTURED_VISUAL_ARGS', '--project, --input, and --output are required');
  return out;
}

function realOrResolve(candidate) {
  try { return fs.realpathSync(candidate); }
  catch {
    let existing = path.resolve(candidate);
    const missing = [];
    while (existing !== path.dirname(existing)) {
      try { existing = fs.realpathSync(existing); break; }
      catch { missing.unshift(path.basename(existing)); existing = path.dirname(existing); }
    }
    return missing.length ? path.join(existing, ...missing) : existing;
  }
}

function inside(root, candidate) {
  const rel = path.relative(realOrResolve(root), realOrResolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function resolveProjectFile(project, raw, label) {
  const root = realOrResolve(path.resolve(process.cwd(), project));
  const candidate = realOrResolve(path.resolve(root, raw));
  if (!inside(root, candidate)) fail('E_STRUCTURED_VISUAL_PATH', `${label} must stay inside the project`);
  return { root, path: candidate };
}

function splitLabel(value, maxChars = 24) {
  const source = text(value);
  if (!source) return [];
  const words = source.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= maxChars) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length <= 3) return lines;
  return [...lines.slice(0, 2), `${lines.slice(2).join(' ').slice(0, maxChars - 1)}…`];
}

function theme(spec) {
  const raw = record(spec.theme) ? spec.theme : {};
  const colors = Array.isArray(raw.accents) && raw.accents.length
    ? raw.accents.slice(0, 12).map((value) => paint(value, '#6d5dfc'))
    : DEFAULT_COLORS;
  return {
    background: paint(raw.background, '#f6f3ed'),
    surface: paint(raw.surface, '#ffffff'),
    text: paint(raw.text, '#17171c'),
    muted: paint(raw.muted, '#676774'),
    grid: paint(raw.grid, '#d9d5cc'),
    accents: colors.length ? colors : DEFAULT_COLORS,
    font: text(raw.font_family, 'Inter, ui-sans-serif, system-ui, sans-serif'),
  };
}

function frame(spec, width, height, palette, body) {
  const title = text(spec.title);
  const subtitle = text(spec.subtitle);
  const titleMarkup = title
    ? `<text x="64" y="70" font-size="36" font-weight="760" fill="${xml(palette.text)}">${xml(title)}</text>`
    : '';
  const subtitleMarkup = subtitle
    ? `<text x="64" y="104" font-size="17" font-weight="450" fill="${xml(palette.muted)}">${xml(subtitle)}</text>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title || spec.kind)}">\n  <rect width="${width}" height="${height}" fill="${xml(palette.background)}"/>\n  <g font-family="${xml(palette.font)}">${titleMarkup}${subtitleMarkup}${body}</g>\n</svg>\n`;
}

function diagramSvg(spec, width, height, palette) {
  const source = record(spec.diagram) ? spec.diagram : spec;
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const rawEdges = Array.isArray(source.edges) ? source.edges : [];
  if (!rawNodes.length || rawNodes.length > 40) fail('E_STRUCTURED_VISUAL_SPEC', 'diagram requires 1 to 40 nodes');
  if (rawEdges.length > 80) fail('E_STRUCTURED_VISUAL_SPEC', 'diagram supports at most 80 edges');
  const nodes = rawNodes.map((item, index) => {
    if (!record(item)) fail('E_STRUCTURED_VISUAL_SPEC', `nodes[${index}] must be an object`);
    const id = text(item.id);
    const label = text(item.label);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || !label) fail('E_STRUCTURED_VISUAL_SPEC', `nodes[${index}] needs a safe id and label`);
    return { id, label, detail: text(item.detail), level: item.level === undefined ? null : number(item.level, 0, 0, 39), accent: item.color === undefined ? '' : paint(item.color, '#6d5dfc') };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) fail('E_STRUCTURED_VISUAL_SPEC', 'diagram node ids must be unique');
  const edges = rawEdges.map((item, index) => {
    if (!record(item)) fail('E_STRUCTURED_VISUAL_SPEC', `edges[${index}] must be an object`);
    const from = text(item.from); const to = text(item.to);
    if (!byId.has(from) || !byId.has(to)) fail('E_STRUCTURED_VISUAL_SPEC', `edges[${index}] references an unknown node`);
    return { from, to, label: text(item.label) };
  });
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const levels = new Map();
  for (const node of nodes) if (node.level !== null) levels.set(node.id, node.level);
  const queue = nodes.filter((node) => (incoming.get(node.id) || 0) === 0).map((node) => node.id);
  for (const node of nodes) if (!queue.includes(node.id) && node.level !== null) queue.push(node.id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift(); seen += 1;
    const level = levels.get(id) || 0;
    for (const target of outgoing.get(id) || []) {
      if (!levels.has(target)) levels.set(target, Math.max(levels.get(target) || 0, level + 1));
      incoming.set(target, (incoming.get(target) || 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  if (seen < nodes.length) nodes.forEach((node, index) => { if (!levels.has(node.id)) levels.set(node.id, index); });
  const groups = new Map();
  for (const node of nodes) {
    const level = levels.get(node.id) || 0;
    if (!groups.has(level)) groups.set(level, []);
    groups.get(level).push(node);
  }
  const orderedLevels = [...groups.keys()].sort((a, b) => a - b);
  const direction = text(source.direction, 'LR').toUpperCase() === 'TB' ? 'TB' : 'LR';
  const top = spec.title ? (spec.subtitle ? 148 : 126) : 48;
  const left = 56; const right = 56; const bottom = 52;
  const availableWidth = width - left - right;
  const availableHeight = height - top - bottom;
  const boxWidth = Math.min(230, Math.max(130, direction === 'LR' ? availableWidth / Math.max(orderedLevels.length, 1) - 44 : availableWidth / Math.max(...orderedLevels.map((level) => groups.get(level).length), 1) - 38));
  const boxHeight = 88;
  const positions = new Map();
  orderedLevels.forEach((level, levelIndex) => {
    const group = groups.get(level);
    group.forEach((node, rowIndex) => {
      const x = direction === 'LR'
        ? left + (availableWidth * (levelIndex + 0.5) / orderedLevels.length)
        : left + (availableWidth * (rowIndex + 0.5) / group.length);
      const y = direction === 'LR'
        ? top + (availableHeight * (rowIndex + 0.5) / group.length)
        : top + (availableHeight * (levelIndex + 0.5) / orderedLevels.length);
      positions.set(node.id, { x, y });
    });
  });
  const marker = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${xml(palette.muted)}"/></marker></defs>`;
  const edgeMarkup = edges.map((edge) => {
    const a = positions.get(edge.from); const b = positions.get(edge.to);
    const startX = direction === 'LR' ? a.x + boxWidth / 2 : a.x;
    const startY = direction === 'LR' ? a.y : a.y + boxHeight / 2;
    const endX = direction === 'LR' ? b.x - boxWidth / 2 - 8 : b.x;
    const endY = direction === 'LR' ? b.y : b.y - boxHeight / 2 - 8;
    const d = direction === 'LR'
      ? `M ${startX} ${startY} C ${(startX + endX) / 2} ${startY}, ${(startX + endX) / 2} ${endY}, ${endX} ${endY}`
      : `M ${startX} ${startY} C ${startX} ${(startY + endY) / 2}, ${endX} ${(startY + endY) / 2}, ${endX} ${endY}`;
    const label = edge.label ? `<text x="${(startX + endX) / 2}" y="${(startY + endY) / 2 - 8}" text-anchor="middle" font-size="13" fill="${xml(palette.muted)}">${xml(edge.label)}</text>` : '';
    return `<g><path d="${d}" fill="none" stroke="${xml(palette.muted)}" stroke-width="2" stroke-linecap="round" marker-end="url(#arrow)" opacity="0.82"/>${label}</g>`;
  }).join('');
  const nodeMarkup = nodes.map((node, index) => {
    const pos = positions.get(node.id); const color = node.accent || palette.accents[index % palette.accents.length];
    const lines = splitLabel(node.label, 23);
    const labelY = pos.y - ((lines.length - 1) * 11) + (node.detail ? -6 : 5);
    const labels = lines.map((line, lineIndex) => `<tspan x="${pos.x}" y="${labelY + lineIndex * 22}">${xml(line)}</tspan>`).join('');
    const detail = node.detail ? `<text x="${pos.x}" y="${pos.y + 30}" text-anchor="middle" font-size="13" fill="${xml(palette.muted)}">${xml(node.detail.slice(0, 38))}</text>` : '';
    return `<g id="${xml(node.id)}"><rect x="${pos.x - boxWidth / 2}" y="${pos.y - boxHeight / 2}" width="${boxWidth}" height="${boxHeight}" rx="18" fill="${xml(palette.surface)}" stroke="${xml(color)}" stroke-width="3"/><circle cx="${pos.x - boxWidth / 2 + 18}" cy="${pos.y - boxHeight / 2 + 18}" r="5" fill="${xml(color)}"/><text text-anchor="middle" font-size="17" font-weight="680" fill="${xml(palette.text)}">${labels}</text>${detail}</g>`;
  }).join('');
  return marker + edgeMarkup + nodeMarkup;
}

function chartData(spec) {
  const raw = record(spec.chart) ? spec.chart : spec;
  const labels = Array.isArray(raw.labels) ? raw.labels.map((value) => text(value)) : [];
  const series = Array.isArray(raw.series) ? raw.series.map((item, index) => {
    if (!record(item) || !Array.isArray(item.values)) fail('E_STRUCTURED_VISUAL_SPEC', `series[${index}] requires values`);
    const values = item.values.map((value) => Number(value));
    if (values.some((value) => !Number.isFinite(value))) fail('E_STRUCTURED_VISUAL_SPEC', `series[${index}] contains a non-number`);
    return { name: text(item.name, `Series ${index + 1}`), values, color: item.color === undefined ? '' : paint(item.color, '#6d5dfc') };
  }) : [];
  if (!labels.length || labels.length > 100 || !series.length || series.length > 8) fail('E_STRUCTURED_VISUAL_SPEC', 'chart requires 1 to 100 labels and 1 to 8 series');
  if (series.some((item) => item.values.length !== labels.length)) fail('E_STRUCTURED_VISUAL_SPEC', 'every series length must match labels');
  return { labels, series };
}

function cartesianSvg(spec, width, height, palette) {
  const { labels, series } = chartData(spec);
  const left = 82; const right = 48; const top = spec.title ? (spec.subtitle ? 158 : 138) : 58; const bottom = 86;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const values = series.flatMap((item) => item.values);
  const min = Math.min(0, ...values); const max = Math.max(1, ...values);
  const span = max - min || 1;
  const y = (value) => top + plotHeight - ((value - min) / span) * plotHeight;
  const ticks = 5;
  let out = '';
  for (let index = 0; index <= ticks; index += 1) {
    const value = min + (span * index / ticks); const yPos = y(value);
    out += `<line x1="${left}" y1="${yPos}" x2="${width - right}" y2="${yPos}" stroke="${xml(palette.grid)}" stroke-width="1"/><text x="${left - 14}" y="${yPos + 5}" text-anchor="end" font-size="13" fill="${xml(palette.muted)}">${xml(Number(value.toFixed(2)))}</text>`;
  }
  const slot = plotWidth / labels.length;
  labels.forEach((label, index) => { out += `<text x="${left + slot * (index + 0.5)}" y="${height - 48}" text-anchor="middle" font-size="13" fill="${xml(palette.muted)}">${xml(label.slice(0, 16))}</text>`; });
  if (spec.kind === 'bar') {
    const groupWidth = slot * 0.7; const barWidth = Math.max(3, groupWidth / series.length - 3);
    series.forEach((item, seriesIndex) => {
      const color = item.color || palette.accents[seriesIndex % palette.accents.length];
      item.values.forEach((value, index) => {
        const x = left + slot * index + (slot - groupWidth) / 2 + seriesIndex * (groupWidth / series.length);
        const yZero = y(0); const yValue = y(value); const h = Math.max(1, Math.abs(yZero - yValue));
        out += `<rect x="${x}" y="${Math.min(yZero, yValue)}" width="${barWidth}" height="${h}" rx="${Math.min(8, barWidth / 3)}" fill="${xml(color)}"/>`;
      });
    });
  } else {
    series.forEach((item, seriesIndex) => {
      const color = item.color || palette.accents[seriesIndex % palette.accents.length];
      const points = item.values.map((value, index) => `${left + slot * (index + 0.5)},${y(value)}`).join(' ');
      out += `<polyline points="${points}" fill="none" stroke="${xml(color)}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
      item.values.forEach((value, index) => { out += `<circle cx="${left + slot * (index + 0.5)}" cy="${y(value)}" r="5" fill="${xml(palette.surface)}" stroke="${xml(color)}" stroke-width="3"/>`; });
    });
  }
  series.forEach((item, index) => {
    const color = item.color || palette.accents[index % palette.accents.length]; const x = left + index * 150;
    out += `<circle cx="${x}" cy="${height - 18}" r="5" fill="${xml(color)}"/><text x="${x + 11}" y="${height - 13}" font-size="13" fill="${xml(palette.text)}">${xml(item.name.slice(0, 18))}</text>`;
  });
  return out;
}

function polar(cx, cy, radius, angle) {
  const rad = (angle - 90) * Math.PI / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function arcPath(cx, cy, outer, inner, start, end) {
  const p1 = polar(cx, cy, outer, end); const p2 = polar(cx, cy, outer, start);
  const p3 = polar(cx, cy, inner, start); const p4 = polar(cx, cy, inner, end);
  const large = end - start > 180 ? 1 : 0;
  return `M ${p1.x} ${p1.y} A ${outer} ${outer} 0 ${large} 0 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${inner} ${inner} 0 ${large} 1 ${p4.x} ${p4.y} Z`;
}

function donutSvg(spec, width, height, palette) {
  const { labels, series } = chartData(spec);
  const values = series[0].values.map((value) => Math.max(0, value));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) fail('E_STRUCTURED_VISUAL_SPEC', 'donut values must total more than zero');
  const top = spec.title ? (spec.subtitle ? 150 : 132) : 40;
  const cx = Math.min(width * 0.38, height * 0.48); const cy = top + (height - top) * 0.48;
  const outer = Math.min(width * 0.22, (height - top) * 0.36); const inner = outer * 0.6;
  let angle = 0; let out = '';
  values.forEach((value, index) => {
    const next = angle + value / total * 360; const color = palette.accents[index % palette.accents.length];
    out += `<path d="${arcPath(cx, cy, outer, inner, angle + 0.8, next - 0.8)}" fill="${xml(color)}"/>`;
    angle = next;
  });
  out += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="34" font-weight="760" fill="${xml(palette.text)}">${xml(Number(total.toFixed(1)))}</text><text x="${cx}" y="${cy + 24}" text-anchor="middle" font-size="14" fill="${xml(palette.muted)}">total</text>`;
  const legendX = width * 0.66; const startY = top + 36;
  labels.forEach((label, index) => {
    const value = values[index]; const color = palette.accents[index % palette.accents.length]; const y = startY + index * 42;
    out += `<rect x="${legendX}" y="${y - 13}" width="14" height="14" rx="4" fill="${xml(color)}"/><text x="${legendX + 25}" y="${y}" font-size="16" fill="${xml(palette.text)}">${xml(label.slice(0, 24))}</text><text x="${width - 60}" y="${y}" text-anchor="end" font-size="16" font-weight="680" fill="${xml(palette.text)}">${xml(`${Math.round(value / total * 100)}%`)}</text>`;
  });
  return out;
}

function renderStructuredVisual(spec) {
  if (!record(spec) || spec.schema_version !== 1 || !KINDS.has(spec.kind)) fail('E_STRUCTURED_VISUAL_SPEC', 'schema_version must be 1 and kind must be diagram, bar, line, or donut');
  const canvas = record(spec.canvas) ? spec.canvas : {};
  const width = number(canvas.width, 1200, 128, 4096); const height = number(canvas.height, 675, 128, 4096);
  if (width * height > 16_777_216) fail('E_STRUCTURED_VISUAL_SPEC', 'canvas area exceeds 16,777,216 pixels');
  const palette = theme(spec);
  const body = spec.kind === 'diagram'
    ? diagramSvg(spec, width, height, palette)
    : spec.kind === 'donut'
      ? donutSvg(spec, width, height, palette)
      : cartesianSvg(spec, width, height, palette);
  return { svg: frame(spec, width, height, palette, body), width, height, kind: spec.kind };
}

async function runStructuredVisual({ args }) {
  const opts = parseArgs(args || []);
  const input = resolveProjectFile(opts.project, opts.input, 'input');
  const output = resolveProjectFile(opts.project, opts.output, 'output');
  if (path.extname(output.path).toLowerCase() !== '.svg') fail('E_STRUCTURED_VISUAL_PATH', 'output must end in .svg');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(input.path, 'utf8')); }
  catch (error) { fail('E_STRUCTURED_VISUAL_READ', `could not read JSON input: ${error.message}`); }
  const rendered = renderStructuredVisual(spec);
  fs.mkdirSync(path.dirname(output.path), { recursive: true });
  const temporary = `${output.path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, rendered.svg, 'utf8');
  fs.renameSync(temporary, output.path);
  return {
    ok: true,
    op: 'render',
    kind: rendered.kind,
    output_path: output.path,
    width: rendered.width,
    height: rendered.height,
    bytes: Buffer.byteLength(rendered.svg),
    engine: 'image-compose-skill-svg',
    model_calls: 0,
  };
}

module.exports = runStructuredVisual;
module.exports.renderStructuredVisual = renderStructuredVisual;
