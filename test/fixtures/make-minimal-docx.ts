/**
 * Minimal .docx generator for tests. A .docx is a ZIP container with specific
 * XML members. We emit an Office Open XML document containing the supplied
 * heading + body paragraphs using STORED (no-compression) ZIP entries — that
 * keeps the central-directory math simple while still being valid for mammoth.
 */

import { Buffer } from 'node:buffer';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function buildDocumentXml(heading: string, paragraphs: string[]): string {
  const headingXml = heading
    ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(heading)}</w:t></w:r></w:p>`
    : '';
  const bodyXml = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${headingXml}
    ${bodyXml}
  </w:body>
</w:document>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface ZipEntry { name: string; data: Buffer; crc32: number; localHeaderOffset: number }

export function makeMinimalDocx(opts: { heading?: string; paragraphs?: string[] } = {}): Buffer {
  const heading = opts.heading ?? '';
  const paragraphs = opts.paragraphs ?? ['Hello docx world.'];
  const members: { name: string; data: Buffer }[] = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels',         data: Buffer.from(RELS, 'utf8') },
    { name: 'word/document.xml',   data: Buffer.from(buildDocumentXml(heading, paragraphs), 'utf8') },
  ];

  const parts: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;

  for (const m of members) {
    const crc32 = crc32of(m.data);
    const localHeader = buildLocalFileHeader(m.name, m.data.length, crc32);
    entries.push({ name: m.name, data: m.data, crc32, localHeaderOffset: offset });
    parts.push(localHeader, m.data);
    offset += localHeader.length + m.data.length;
  }

  const cdStart = offset;
  for (const e of entries) {
    const cdh = buildCentralDirHeader(e.name, e.data.length, e.crc32, e.localHeaderOffset);
    parts.push(cdh);
    offset += cdh.length;
  }
  const cdSize = offset - cdStart;
  parts.push(buildEndOfCentralDir(entries.length, cdSize, cdStart));
  return Buffer.concat(parts);
}

function buildLocalFileHeader(name: string, size: number, crc32: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const buf = Buffer.alloc(30 + nameBuf.length);
  buf.writeUInt32LE(0x04034b50, 0);    // signature
  buf.writeUInt16LE(20, 4);             // version needed
  buf.writeUInt16LE(0, 6);              // flags
  buf.writeUInt16LE(0, 8);              // compression = STORED
  buf.writeUInt16LE(0, 10);             // mod time
  buf.writeUInt16LE(0x21, 12);          // mod date (placeholder)
  buf.writeUInt32LE(crc32, 14);
  buf.writeUInt32LE(size, 18);          // compressed size
  buf.writeUInt32LE(size, 22);          // uncompressed size
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28);             // extra length
  nameBuf.copy(buf, 30);
  return buf;
}

function buildCentralDirHeader(name: string, size: number, crc32: number, localHeaderOffset: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const buf = Buffer.alloc(46 + nameBuf.length);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt16LE(20, 4);             // version made by
  buf.writeUInt16LE(20, 6);             // version needed
  buf.writeUInt16LE(0, 8);              // flags
  buf.writeUInt16LE(0, 10);             // compression = STORED
  buf.writeUInt16LE(0, 12);
  buf.writeUInt16LE(0x21, 14);
  buf.writeUInt32LE(crc32, 16);
  buf.writeUInt32LE(size, 20);
  buf.writeUInt32LE(size, 24);
  buf.writeUInt16LE(nameBuf.length, 28);
  buf.writeUInt16LE(0, 30);             // extra length
  buf.writeUInt16LE(0, 32);             // comment length
  buf.writeUInt16LE(0, 34);             // disk
  buf.writeUInt16LE(0, 36);             // internal attrs
  buf.writeUInt32LE(0, 38);             // external attrs
  buf.writeUInt32LE(localHeaderOffset, 42);
  nameBuf.copy(buf, 46);
  return buf;
}

function buildEndOfCentralDir(entryCount: number, cdSize: number, cdOffset: number): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(0, 4);              // disk number
  buf.writeUInt16LE(0, 6);              // disk where CD starts
  buf.writeUInt16LE(entryCount, 8);     // entries on this disk
  buf.writeUInt16LE(entryCount, 10);    // total entries
  buf.writeUInt32LE(cdSize, 12);
  buf.writeUInt32LE(cdOffset, 16);
  buf.writeUInt16LE(0, 20);             // comment length
  return buf;
}

/** Standard CRC-32 (poly 0xEDB88320) — pure JS implementation. */
function crc32of(buf: Buffer): number {
  let table = (crc32of as any)._table as Uint32Array | undefined;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    (crc32of as any)._table = table;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

