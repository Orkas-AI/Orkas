/** Independent, uncompressed Bayer DNG fixture. This exercises real RAW
 * decoding, not a camera-support claim or an embedded JPEG shortcut. */
export function bayerDng(width = 256, height = 192): Buffer {
  const entries: Array<{ tag: number; type: number; count: number; data: Buffer }> = [];
  const shorts = (values: number[]) => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; };
  const longs = (values: number[]) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32LE(v, i * 4)); return b; };
  const rational = (values: number[]) => { const b = Buffer.alloc(values.length * 8); values.forEach((v, i) => { b.writeInt32LE(Math.round(v * 10000), i * 8); b.writeInt32LE(10000, i * 8 + 4); }); return b; };
  const add = (tag: number, type: number, count: number, data: Buffer) => entries.push({ tag, type, count, data });
  const text = (tag: number, value: string) => add(tag, 2, value.length + 1, Buffer.from(value + '\0'));
  for (const [tag, value] of [[256, width], [257, height], [273, 0], [278, height], [279, width * height * 2], [50717, 4095]]) add(tag, 4, 1, longs([value]));
  for (const [tag, value] of [[258, 16], [259, 1], [262, 32803], [274, 1], [277, 1], [284, 1], [50778, 21]]) add(tag, 3, 1, shorts([value]));
  text(271, 'Orkas'); text(272, 'Bayer test sensor'); text(50708, 'Orkas Bayer test sensor');
  add(33421, 3, 2, shorts([2, 2])); add(33422, 1, 4, Buffer.from([0, 1, 1, 2]));
  add(50706, 1, 4, Buffer.from([1, 4, 0, 0])); add(50707, 1, 4, Buffer.from([1, 1, 0, 0]));
  add(50714, 5, 1, rational([0])); add(50721, 10, 9, rational([1, 0, 0, 0, 1, 0, 0, 0, 1]));
  add(50728, 5, 3, rational([1, 1, 1]));
  entries.sort((a, b) => a.tag - b.tag);
  let cursor = 8 + 2 + entries.length * 12 + 4;
  const offsets = entries.map(e => { if (e.data.length <= 4) return 0; const at = cursor; cursor += e.data.length + e.data.length % 2; return at; });
  const bytes = Buffer.alloc(cursor + width * height * 2);
  bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4); bytes.writeUInt16LE(entries.length, 8);
  entries.forEach((e, i) => {
    const at = 10 + i * 12; bytes.writeUInt16LE(e.tag, at); bytes.writeUInt16LE(e.type, at + 2); bytes.writeUInt32LE(e.count, at + 4);
    if (e.tag === 273) bytes.writeUInt32LE(cursor, at + 8);
    else if (offsets[i]) { bytes.writeUInt32LE(offsets[i], at + 8); e.data.copy(bytes, offsets[i]); }
    else e.data.copy(bytes, at + 8);
  });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const level = 180 + Math.floor(x / width * 700 + y / height * 200);
    bytes.writeUInt16LE(level, cursor + (y * width + x) * 2);
  }
  return bytes;
}
