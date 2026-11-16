import { inflateSync } from 'node:zlib';

// Independent, bounded PSD v1/8-bit RGB oracle for the subset we export.
// Based on Adobe's file format specification; it imports no writer/parser library.
class Reader {
  position = 0;
  constructor(readonly bytes: Buffer) {}
  take(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || this.position + size > this.bytes.length) throw new Error('Truncated PSD');
    const result = this.bytes.subarray(this.position, this.position + size); this.position += size; return result;
  }
  u8() { return this.take(1)[0]; }
  u16() { return this.take(2).readUInt16BE(); }
  i16() { return this.take(2).readInt16BE(); }
  u32() { return this.take(4).readUInt32BE(); }
  i32() { return this.take(4).readInt32BE(); }
  ascii(size: number) { return this.take(size).toString('ascii'); }
  unicode() { const length = this.u32(); if (length > 8192) throw new Error('Oversized PSD text'); return Buffer.from(this.take(length * 2)).swap16().toString('utf16le').replace(/\0$/, ''); }
  id() { const length = this.u32(); return this.ascii(length || 4); }
}
function descriptor(reader: Reader, depth = 0): Record<string, unknown> {
  if (depth > 16) throw new Error('Oversized descriptor');
  reader.unicode(); reader.id(); const count = reader.u32(); if (count > 512) throw new Error('Oversized descriptor');
  const result: Record<string, unknown> = {};
  const value = (type: string): unknown => {
    if (type === 'TEXT') return reader.unicode();
    if (type === 'long') return reader.i32();
    if (type === 'bool') return !!reader.u8();
    if (type === 'doub') return reader.take(8).readDoubleBE();
    if (type === 'UntF') { reader.take(4); return reader.take(8).readDoubleBE(); }
    if (type === 'enum') return [reader.id(), reader.id()];
    if (type === 'Objc' || type === 'GlbO') return descriptor(reader, depth + 1);
    if (type === 'tdta' || type === 'alis') return reader.take(reader.u32());
    if (type === 'VlLs') { const length = reader.u32(); if (length > 512) throw new Error('Oversized list'); return Array.from({ length }, () => value(reader.ascii(4))); }
    throw new Error(`Unsupported descriptor type ${type}`);
  };
  for (let i = 0; i < count; i++) { const key = reader.id(); result[key] = value(reader.ascii(4)); }
  return result;
}
function plane(bytes: Buffer, width: number, height: number): Buffer {
  const reader = new Reader(bytes), compression = reader.u16(), size = width * height;
  if (compression === 0) return Buffer.from(reader.take(size));
  if (compression === 2) {
    const result = inflateSync(reader.take(bytes.length - 2), { maxOutputLength: Math.max(1, size) });
    if (result.length !== size) throw new Error('Wrong channel size'); return result;
  }
  if (compression !== 1) throw new Error('Unsupported channel encoding');
  const lengths = Array.from({ length: height }, () => reader.u16()), result = Buffer.alloc(size);
  for (let y = 0; y < height; y++) {
    const row = new Reader(reader.take(lengths[y])); let x = 0;
    while (row.position < row.bytes.length) {
      const control = row.take(1).readInt8();
      if (control === -128) continue;
      const length = control < 0 ? 1 - control : control + 1;
      if (x + length > width) throw new Error('Channel row overflow');
      if (control < 0) result.fill(row.u8(), y * width + x, y * width + x + length);
      else row.take(length).copy(result, y * width + x);
      x += length;
    }
    if (x !== width) throw new Error('Channel row underflow');
  }
  return result;
}
export interface PsdLayerEvidence {
  name: string; top: number; left: number; width: number; height: number;
  opacity: number; hidden: boolean; section?: number; text?: string;
  channels: Map<number, Buffer>; mask?: { width: number; height: number };
}
export function inspectPsdBytes(bytes: Buffer) {
  if (bytes.length > 134_217_728) throw new Error('Oversized PSD');
  const reader = new Reader(bytes);
  if (reader.ascii(4) !== '8BPS' || reader.u16() !== 1) throw new Error('Not PSD v1');
  reader.take(6); const channelCount = reader.u16(), height = reader.u32(), width = reader.u32();
  if (reader.u16() !== 8 || reader.u16() !== 3 || width * height > 4_194_304 || channelCount < 3 || channelCount > 4) throw new Error('Unsupported PSD document');
  reader.take(reader.u32()); reader.take(reader.u32());
  const layerSectionLength = reader.u32(), layerSectionEnd = reader.position + layerSectionLength;
  const layerInfo = new Reader(reader.take(reader.u32()));
  const count = Math.abs(layerInfo.i16()); if (count > 192) throw new Error('Too many layer records');
  let totalPixels = 0;
  const records = Array.from({ length: count }, () => {
    const top = layerInfo.i32(), left = layerInfo.i32(), bottom = layerInfo.i32(), right = layerInfo.i32();
    const lw = right - left, lh = bottom - top;
    if (lw < 0 || lh < 0 || lw > 8192 || lh > 8192 || (totalPixels += lw * lh) > 16_777_216) throw new Error('Oversized layer');
    const count = layerInfo.u16(); if (count > 5) throw new Error('Unsupported layer channels');
    const data = Array.from({ length: count }, () => ({ id: layerInfo.i16(), size: layerInfo.u32() }));
    if (layerInfo.ascii(4) !== '8BIM') throw new Error('Bad layer signature');
    layerInfo.take(4); const opacity = layerInfo.u8(); layerInfo.u8(); const flags = layerInfo.u8(); layerInfo.take(1);
    const extra = new Reader(layerInfo.take(layerInfo.u32()));
    const maskBytes = extra.take(extra.u32()); let mask;
    if (maskBytes.length >= 18) { const m = new Reader(maskBytes); const mt = m.i32(), ml = m.i32(), mb = m.i32(), mr = m.i32(); mask = { width: mr - ml, height: mb - mt }; if (mask.width !== lw || mask.height !== lh) throw new Error('Unsupported mask bounds'); }
    extra.take(extra.u32()); const nameLength = extra.u8(); let name = extra.take(nameLength).toString('utf8'); extra.take((4 - (nameLength + 1) % 4) % 4);
    const layer: PsdLayerEvidence = { name, top, left, width: lw, height: lh, opacity, hidden: !!(flags & 2), channels: new Map(), ...(mask ? { mask } : {}) };
    while (extra.position + 12 <= extra.bytes.length) {
      if (extra.ascii(4) !== '8BIM') throw new Error('Unsupported additional block');
      const key = extra.ascii(4), size = extra.u32(), block = new Reader(extra.take(size)); if (size % 2) extra.take(1);
      if (key === 'luni') layer.name = block.unicode();
      if (key === 'lsct') layer.section = block.u32();
      if (key === 'TySh') { block.take(2 + 6 * 8 + 2 + 4); layer.text = descriptor(block)['Txt '] as string; }
    }
    return { layer, data };
  });
  for (const record of records) for (const channel of record.data) record.layer.channels.set(channel.id, plane(layerInfo.take(channel.size), record.layer.width, record.layer.height));
  reader.position = layerSectionEnd;
  const compressed = reader.u16(); if (compressed !== 1) throw new Error('Unsupported composite encoding');
  const lengths = Array.from({ length: height * channelCount }, () => reader.u16());
  const planes = Array.from({ length: channelCount }, (_, c) => {
    const sizes = lengths.slice(c * height, (c + 1) * height); const header = Buffer.alloc(2 + height * 2); header.writeUInt16BE(1);
    sizes.forEach((size, y) => header.writeUInt16BE(size, 2 + y * 2));
    return plane(Buffer.concat([header, reader.take(sizes.reduce((a, b) => a + b, 0))]), width, height);
  });
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 4; c++) rgba[i * 4 + c] = planes[c]?.[i] ?? 255;
  return { width, height, rgba, layers: records.map(record => record.layer) };
}
