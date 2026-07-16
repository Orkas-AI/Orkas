export type HtmlStartTag = {
  tagName: string;
  attrs: Record<string, string>;
  start: number;
  end: number;
  rawText?: string;
};

export type HtmlStructure = {
  tags: HtmlStartTag[];
  diagnostics: string[];
  textContent: string;
};

export type HtmlResourceRef = {
  attr: 'src' | 'href' | 'poster' | 'style-url' | 'css-import';
  ref: string;
};

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function findTagEnd(html: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote && html[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function parseStartTag(raw: string, start: number, end: number): HtmlStartTag | null {
  let i = 1;
  while (/\s/.test(raw[i] || '')) i += 1;
  if (!raw[i] || raw[i] === '/' || raw[i] === '!' || raw[i] === '?') return null;

  const nameStart = i;
  while (/[A-Za-z0-9:_-]/.test(raw[i] || '')) i += 1;
  const tagName = raw.slice(nameStart, i).toLowerCase();
  if (!tagName) return null;

  const attrs: Record<string, string> = {};
  while (i < raw.length - 1) {
    while (/\s/.test(raw[i] || '')) i += 1;
    if (i >= raw.length - 1 || raw[i] === '/' || raw[i] === '>') break;

    const attrStart = i;
    while (i < raw.length - 1 && !/[\s=/>]/.test(raw[i] || '')) i += 1;
    const attrName = raw.slice(attrStart, i).toLowerCase();
    if (!attrName) {
      i += 1;
      continue;
    }
    while (/\s/.test(raw[i] || '')) i += 1;
    let value = '';
    if (raw[i] === '=') {
      i += 1;
      while (/\s/.test(raw[i] || '')) i += 1;
      const quote = raw[i] === '"' || raw[i] === "'" ? raw[i] : '';
      if (quote) {
        i += 1;
        const valueStart = i;
        while (i < raw.length - 1 && raw[i] !== quote) i += 1;
        value = raw.slice(valueStart, i);
        if (raw[i] === quote) i += 1;
      } else {
        const valueStart = i;
        while (i < raw.length - 1 && !/[\s>]/.test(raw[i] || '')) i += 1;
        value = raw.slice(valueStart, i);
      }
    }
    attrs[attrName] = decodeHtmlAttribute(value);
  }
  return { tagName, attrs, start, end };
}

export function parseHtmlStructure(html: string): HtmlStructure {
  const tags: HtmlStartTag[] = [];
  const diagnostics: string[] = [];
  const textParts: string[] = [];
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf('<', i);
    if (start < 0) {
      textParts.push(html.slice(i));
      break;
    }
    if (start > i) textParts.push(html.slice(i, start));
    if (html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4);
      if (commentEnd < 0) {
        diagnostics.push('unclosed HTML comment');
        break;
      }
      i = commentEnd + 3;
      continue;
    }
    const end = findTagEnd(html, start);
    if (end < 0) {
      diagnostics.push(`unclosed HTML tag near offset ${start}`);
      break;
    }
    const tag = parseStartTag(html.slice(start, end + 1), start, end + 1);
    if (!tag) {
      i = end + 1;
      continue;
    }
    tags.push(tag);
    if ((tag.tagName === 'script' || tag.tagName === 'style') && !html.slice(start, end + 1).trimEnd().endsWith('/>')) {
      const closeStart = lower.indexOf(`</${tag.tagName}`, end + 1);
      if (closeStart < 0) {
        diagnostics.push(`unclosed <${tag.tagName}> element`);
        tag.rawText = html.slice(end + 1);
        break;
      }
      tag.rawText = html.slice(end + 1, closeStart);
      i = closeStart;
      continue;
    }
    i = end + 1;
  }
  return {
    tags,
    diagnostics,
    textContent: decodeHtmlAttribute(textParts.join(' ')).replace(/\s+/g, ' ').trim(),
  };
}

export function extractCssUrls(css: string): string[] {
  const refs: string[] = [];
  let i = 0;
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const commentEnd = css.indexOf('*/', i + 2);
      i = commentEnd < 0 ? css.length : commentEnd + 2;
      continue;
    }
    if (css.slice(i, i + 3).toLowerCase() !== 'url') {
      i += 1;
      continue;
    }
    const before = i > 0 ? css[i - 1] : '';
    if (before && /[A-Za-z0-9_-]/.test(before)) {
      i += 3;
      continue;
    }
    let cursor = i + 3;
    while (/\s/.test(css[cursor] || '')) cursor += 1;
    if (css[cursor] !== '(') {
      i += 3;
      continue;
    }
    cursor += 1;
    while (/\s/.test(css[cursor] || '')) cursor += 1;
    const quote = css[cursor] === '"' || css[cursor] === "'" ? css[cursor] : '';
    if (quote) cursor += 1;
    const valueStart = cursor;
    while (cursor < css.length) {
      const ch = css[cursor];
      if (ch === '\\') {
        cursor += 2;
        continue;
      }
      if ((quote && ch === quote) || (!quote && ch === ')')) break;
      cursor += 1;
    }
    const value = css.slice(valueStart, cursor).trim();
    if (value) refs.push(value);
    if (quote && css[cursor] === quote) cursor += 1;
    while (cursor < css.length && css[cursor] !== ')') cursor += 1;
    i = cursor < css.length ? cursor + 1 : css.length;
  }
  return refs;
}

export function extractCssImports(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const refs: string[] = [];
  const pattern = /@import\s+(?:url\(\s*)?(?:([\"'])(.*?)\1|([^\s;)'\"]+))\s*\)?[^;]*;/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments))) {
    const value = String(match[2] || match[3] || '').trim();
    if (value) refs.push(value);
  }
  return refs;
}

export function extractHtmlResourceRefs(structure: HtmlStructure): HtmlResourceRef[] {
  const refs: HtmlResourceRef[] = [];
  const seen = new Set<string>();
  const add = (attr: HtmlResourceRef['attr'], ref: string) => {
    const value = String(ref || '').trim();
    const key = `${attr}\0${value}`;
    if (!value || seen.has(key)) return;
    seen.add(key);
    refs.push({ attr, ref: value });
  };
  for (const tag of structure.tags) {
    for (const attr of ['src', 'href', 'poster'] as const) {
      if (tag.attrs[attr]) add(attr, tag.attrs[attr]);
    }
    if (tag.attrs.style) extractCssUrls(tag.attrs.style).forEach((ref) => add('style-url', ref));
    if (tag.tagName === 'style' && tag.rawText) extractCssUrls(tag.rawText).forEach((ref) => add('style-url', ref));
  }
  return refs;
}
