import AdmZip from 'adm-zip';
import * as path from 'node:path';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

/** Revision of derived DOCX text only; never invalidate unrelated PDF/Office caches. */
export const DOCX_EXTRACTION_VERSION = 1;
type Node = Record<string, any>;
type Level = { start: number; format: string; text: string; suffix: string; restart?: number; style?: string; legal?: boolean };
const options = { preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false };
function fail(): never { throw new Error('DOCX list numbering could not be read reliably; use the original document for its numbering.'); }
const name = (n: Node): string => Object.keys(n).find(k => k !== ':@' && !k.startsWith('#') && !k.startsWith('?')) || '';
const local = (n: Node): string => name(n).split(':').at(-1) || '';
const children = (n: Node): Node[] => Array.isArray(n[name(n)]) ? n[name(n)] : [];
const child = (n: Node | undefined, tag: string): Node | undefined => n && children(n).find(c => local(c) === tag);
function attr(n: Node | undefined, key: string): string | undefined {
  const a = n?.[':@'] || {};
  const k = Object.keys(a).find(k => k.replace(/^@_/, '').split(':').at(-1) === key);
  return k === undefined ? undefined : String(a[k]);
}
const val = (n: Node | undefined, tag: string): string | undefined => attr(child(n, tag), 'val');
function integer(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  if (!/^-?\d+$/.test(s)) fail();
  const n = Number(s); if (!Number.isSafeInteger(n) || Math.abs(n) > 2147483647) fail(); return n;
}
function readLevel(n: Node, base?: Level): Level {
  return {
    start: integer(val(n, 'start'), base?.start ?? 0),
    format: val(n, 'numFmt') ?? base?.format ?? 'decimal',
    text: val(n, 'lvlText') ?? base?.text ?? `%${integer(attr(n, 'ilvl'), 0) + 1}.`,
    suffix: val(n, 'suff') ?? base?.suffix ?? 'tab',
    restart: val(n, 'lvlRestart') === undefined ? base?.restart : integer(val(n, 'lvlRestart'), 0),
    style: val(n, 'pStyle') ?? base?.style,
    legal: child(n, 'isLgl') ? !['0', 'false', 'off'].includes(val(n, 'isLgl') || '') : base?.legal,
  };
}
function format(n: number, fmt: string): string {
  if (fmt === 'decimal') return String(n);
  if (fmt === 'decimalZero') return n >= 0 && n < 10 ? `0${n}` : String(n);
  if (n < 1) fail();
  if (fmt === 'lowerLetter' || fmt === 'upperLetter') {
    let out = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) out = String.fromCharCode(65 + (x - 1) % 26) + out;
    return fmt === 'lowerLetter' ? out.toLowerCase() : out;
  }
  if (fmt === 'lowerRoman' || fmt === 'upperRoman') {
    if (n > 3999) fail();
    let out = '';
    for (const [v, c] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const) {
      while (n >= v) { out += c; n -= v; }
    }
    return fmt === 'lowerRoman' ? out.toLowerCase() : out;
  }
  fail();
}

/** Produce an in-memory conversion input. Only document XML is changed; the
 * source Buffer and compressed image payloads remain untouched. Literal labels
 * survive both Mammoth's Markdown escaping and HTML's automatic list counters. */
export function preserveDocxNumbering(buf: Buffer): Buffer {
  const zip = new AdmZip(buf);
  let totalXml = 0;
  const read = (file: string): Node[] => {
    const entry = zip.getEntry(file); if (!entry) return [];
    if (entry.header.size > 32 * 1024 ** 2 || (totalXml += entry.header.size) > 64 * 1024 ** 2) fail();
    const data = entry.getData(); if (data.length > 32 * 1024 ** 2) fail();
    const xml = data.toString('utf8'); if (/<!DOCTYPE\b/i.test(xml)) fail();
    try { return new XMLParser(options).parse(xml, true); } catch { return fail(); }
  };
  const target = (base: string, raw: string): string => {
    const value = path.posix.normalize(raw.startsWith('/') ? raw.slice(1) : path.posix.join(base, raw));
    if (value.startsWith('../') || value.includes('\\')) fail(); return value;
  };
  const relationships = (file: string) => read(file).flatMap(n => local(n) === 'Relationships' ? children(n) : []);
  const mainRel = relationships('_rels/.rels').find(r => attr(r, 'Type')?.endsWith('/officeDocument') && attr(r, 'TargetMode') !== 'External');
  const main = mainRel ? target('', attr(mainRel, 'Target') || '') : 'word/document.xml';
  const dir = path.posix.dirname(main);
  const rels = relationships(path.posix.join(dir, '_rels', path.posix.basename(main) + '.rels'));
  const related = (kind: string) => {
    const rel = rels.find(r => attr(r, 'Type')?.endsWith('/' + kind) && attr(r, 'TargetMode') !== 'External');
    return rel ? target(dir, attr(rel, 'Target') || '') : path.posix.join(dir, kind + '.xml');
  };
  // The common no-numbering path neither serializes nor copies the archive.
  if (!zip.getEntry(related('numbering'))) return buf;
  const numbering = read(related('numbering')).find(n => local(n) === 'numbering');
  if (!numbering) fail();
  const definitions = new Map(children(numbering).filter(n => local(n) === 'abstractNum').map(n => [attr(n, 'abstractNumId')!, n]));
  const nums = new Map(children(numbering).filter(n => local(n) === 'num').map(n => [attr(n, 'numId')!, n]));
  const styleRoot = read(related('styles')).find(n => local(n) === 'styles');
  const styles = new Map((styleRoot ? children(styleRoot) : []).filter(n => local(n) === 'style').map(n => [attr(n, 'styleId')!, n]));
  const defaultStyle = [...styles.values()].find(n => attr(n, 'type') === 'paragraph' && ['1', 'true'].includes(attr(n, 'default') || ''));
  const styleMemo = new Map<string, { numId?: string; level?: string }>();
  function styleNumbering(id: string | undefined, seen = new Set<string>()): { numId?: string; level?: string } {
    if (!id) return {};
    if (styleMemo.has(id)) return styleMemo.get(id)!;
    if (seen.has(id) || seen.size > 64) fail(); seen.add(id);
    const s = styles.get(id); if (!s) return {};
    const inherited = styleNumbering(val(s, 'basedOn'), seen), pr = child(child(s, 'pPr'), 'numPr');
    const result = { numId: val(pr, 'numId') ?? inherited.numId, level: val(pr, 'ilvl') ?? inherited.level };
    styleMemo.set(id, result); return result;
  }
  const levelsMemo = new Map<string, Map<number, Level>>();
  function levelsFor(id: string, seen = new Set<string>()): Map<number, Level> {
    if (levelsMemo.has(id)) return levelsMemo.get(id)!;
    if (seen.has(id) || seen.size > 64) fail(); seen.add(id);
    const num = nums.get(id), definition = definitions.get(val(num, 'abstractNumId') || '');
    if (!num || !definition) fail();
    const link = val(definition, 'numStyleLink');
    const linkedNum = link ? styleNumbering(link).numId : undefined;
    if (link && !linkedNum) fail();
    const levels = linkedNum ? new Map(levelsFor(linkedNum, seen)) : new Map<number, Level>();
    for (const n of children(definition).filter(n => local(n) === 'lvl')) levels.set(integer(attr(n, 'ilvl'), 0), readLevel(n));
    for (const n of children(num).filter(n => local(n) === 'lvlOverride')) {
      const index = integer(attr(n, 'ilvl'), 0), override = child(n, 'lvl');
      const old = levels.get(index);
      if (!old && !override) fail();
      const level = override ? readLevel(override, old) : { ...old! };
      // Word ignores start/lvlRestart inside an override's lvl. Only the
      // instance's startOverride changes its start (MS-OI29500 2.1.282/292).
      if (override) { level.start = old?.start ?? 0; level.restart = old?.restart; }
      level.start = integer(val(n, 'startOverride'), level.start); levels.set(index, level);
    }
    if ([...levels.keys()].some(n => n < 0 || n > 8)) fail();
    levelsMemo.set(id, levels); return levels;
  }
  const counters = new Map<string, Map<number, number>>();
  const xml = read(main), document = xml.find(n => local(n) === 'document');
  if (!document) fail();
  const prefix = name(document).includes(':') ? name(document).split(':')[0] + ':' : '';
  const node = (tag: string, contents: Node[], attrs?: Record<string, string>): Node => ({ [prefix + tag]: contents, ...(attrs ? { ':@': attrs } : {}) });
  let changed = false, visited = 0;
  function walk(nodes: Node[], depth = 0): void {
    if (depth > 192) fail();
    for (const n of nodes) {
      if (++visited > 1000000) fail();
      if (['del', 'moveFrom'].some(tag => name(n) === prefix + tag)) continue;
      if (name(n) === prefix + 'p') {
        let pr = child(n, 'pPr'); const direct = child(pr, 'numPr');
        const style = val(pr, 'pStyle') ?? attr(defaultStyle, 'styleId');
        const inherited = styleNumbering(style);
        const id = val(direct, 'numId') ?? inherited.numId;
        let index = integer(val(direct, 'ilvl') ?? inherited.level, 0);
        if (id && id !== '0') {
          const levels = levelsFor(id);
          if (val(direct, 'ilvl') === undefined && style) {
            let current: string | undefined = style; const seen = new Set<string>();
            while (current) {
              if (seen.has(current) || seen.size > 64) fail(); seen.add(current);
              const associated = [...levels].find(([, level]) => level.style === current);
              if (associated) { index = associated[0]; break; }
              current = val(styles.get(current), 'basedOn');
            }
          }
          const level = levels.get(index); if (!level || level.start < 0) fail();
          let count = counters.get(id); if (!count) { count = new Map(); counters.set(id, count); }
          count.set(index, (count.get(index) ?? level.start - 1) + 1);
          for (const [deeper, definition] of levels) {
            const trigger = definition.restart === undefined || definition.restart > deeper ? deeper - 1 : definition.restart - 1;
            if (deeper > index && trigger >= index) count.delete(deeper);
          }
          if (level.format !== 'bullet') {
            const label = level.format === 'none' ? '' : level.text.replace(/%([1-9])/g, (_m, digit) => {
              const i = Number(digit) - 1, part = levels.get(i); if (!part || i > index) fail();
              return format(count!.get(i) ?? part.start, level.legal ? 'decimal' : part.format);
            });
            if (label.length > 1024 || /%\d/.test(label)) fail();
            if (!pr) { pr = node('pPr', []); children(n).unshift(pr); }
            // Explicit numId=0 also blocks numbering inherited from a style.
            const content = children(pr), old = content.findIndex(c => local(c) === 'numPr');
            if (old >= 0) content.splice(old, 1);
            content.push(node('numPr', [node('ilvl', [], { ['@_' + prefix + 'val']: '0' }), node('numId', [], { ['@_' + prefix + 'val']: '0' })]));
            if (!['tab', 'space', 'nothing'].includes(level.suffix)) fail();
            if (label) children(n).splice(children(n).indexOf(pr) + 1, 0, node('r', [node('t', [{ '#text': label + (level.suffix === 'nothing' ? '' : ' ') }], { '@_xml:space': 'preserve' })]));
            changed = true;
          }
        }
      }
      walk(children(n), depth + 1);
    }
  }
  walk(children(document));
  if (!changed) return buf;
  zip.updateFile(main, Buffer.from(new XMLBuilder({ ...options, suppressEmptyNode: true }).build(xml)));
  return zip.toBuffer();
}
