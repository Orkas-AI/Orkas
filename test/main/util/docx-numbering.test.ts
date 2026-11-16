import { describe, expect, it } from 'vitest';
import { docxBufferToChunks, docxBufferToHtml, docxBufferToMarkdown } from '../../../src/main/util/extract-docx';
import { makeNumberedDocx, numberedParagraph as p } from '../../fixtures/make-numbered-docx';

// Labels are independently specified by source XML, never inferred from the
// extractor. Both read text and preview must attest the same original labels.
const plain = (s: string) => s.replace(/\\([.\[\]()])/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
async function labels(doc: Buffer, expected: string[]) {
  const before = Buffer.from(doc);
  for (const content of [await docxBufferToMarkdown(doc), await docxBufferToHtml(doc), (await docxBufferToChunks(doc, { maxChars: 100 })).map(c => c.text).join(' ')]) {
    const text = plain(content);
    for (const label of expected) expect(text).toContain(label);
  }
  expect(doc).toEqual(before);
}
describe('source-defined DOCX numbering', () => {
  it('retains non-one starts in read text, preview and indexed chunks', async () => {
    await labels(makeNumberedDocx(p('Alpha') + p('Bravo')), ['7. Alpha', '8. Bravo']);
  });
  it('uses instance start overrides and keeps independent list identities separate', async () => {
    const n = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="7"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="12"/></w:lvlOverride></w:num>'
      + '<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>';
    await labels(makeNumberedDocx(p('Alpha') + p('Other', 2) + p('Bravo'), n), ['12) Alpha', '7) Other', '13) Bravo']);
  });
  it.each([false, true])('resolves parent placeholders and respects nested restart disabled=%s', async never => {
    const n = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>'
      + `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/>${never ? '<w:lvlRestart w:val="0"/>' : ''}</w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
    await labels(makeNumberedDocx(p('Parent') + p('First', 1, 1) + p('Second', 1, 1) + p('Next') + p('Child', 1, 1), n),
      ['3. Parent', '3.a) First', '3.b) Second', '4. Next', never ? '4.c) Child' : '4.a) Child']);
  });
  it('inherits paragraph numbering styles and respects explicit numbering removal', async () => {
    const styles = '<w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:pPr><w:numPr><w:numId w:val="1"/><w:ilvl w:val="0"/></w:numPr></w:pPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Derived"><w:name w:val="Derived"/><w:basedOn w:val="Base"/></w:style>';
    const body = '<w:p><w:pPr><w:pStyle w:val="Derived"/></w:pPr><w:r><w:t>Alpha</w:t></w:r></w:p>' + p('Manual', 0, 0, 'Derived') + p('Bravo');
    await labels(makeNumberedDocx(body, undefined, styles), ['7. Alpha', 'Manual', '8. Bravo']);
    expect(plain(await docxBufferToMarkdown(makeNumberedDocx(body, undefined, styles)))).not.toContain('8. Manual');
  });
  it('continues through tables without adding numbering to manually typed text', async () => {
    const body = p('Alpha') + '<w:tbl><w:tr><w:tc>' + p('Bravo') + '</w:tc></w:tr></w:tbl><w:p><w:r><w:t>9. Manual</w:t></w:r></w:p>' + p('Charlie');
    await labels(makeNumberedDocx(body), ['7. Alpha', '8. Bravo', '9. Manual', '9. Charlie']);
  });
  it('rejects unsupported active formats rather than inventing a one-based list', async () => {
    const n = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="7"/><w:numFmt w:val="ordinalText"/><w:lvlText w:val="%1"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    await expect(docxBufferToMarkdown(makeNumberedDocx(p('Alpha'), n))).rejects.toThrow(/numbering/i);
  });
  it('uses the level associated with an inherited paragraph style', async () => {
    const styles = '<w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="Base"/></w:style>';
    const n = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="4"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="(%2)"/><w:pStyle w:val="Base"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const body = '<w:p><w:pPr><w:pStyle w:val="Derived"/></w:pPr><w:r><w:t>Alpha</w:t></w:r></w:p>';
    await labels(makeNumberedDocx(body, n, styles), ['(IV) Alpha']);
  });
  it('preserves decimal zero, full overrides, formatting and unnumbered bullets', async () => {
    const n = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="7"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0"><w:start w:val="90"/><w:numFmt w:val="decimalZero"/><w:lvlText w:val="[%1]"/></w:lvl><w:startOverride w:val="8"/></w:lvlOverride></w:num><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>';
    const body = p('Alpha') + p('Bravo') + p('Bullet item', 2) + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold text</w:t></w:r></w:p>';
    const doc = makeNumberedDocx(body, n);
    await labels(doc, ['[08] Alpha', '[09] Bravo', 'Bullet item', 'Bold text']);
    expect(await docxBufferToHtml(doc)).toContain('<strong>Bold text</strong>');
    expect(await docxBufferToHtml(doc)).toContain('<ul>');
  });
  it('uses the specified zero start when start is omitted and rejects cyclic styles', async () => {
    const n = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    await labels(makeNumberedDocx(p('Alpha'), n), ['0. Alpha']);
    const styles = '<w:style w:type="paragraph" w:styleId="Loop"><w:basedOn w:val="Loop"/></w:style>';
    await expect(docxBufferToMarkdown(makeNumberedDocx(p('Alpha', 1, 0, 'Loop'), n, styles))).rejects.toThrow(/numbering/i);
  });
  it('keeps numbering labels as escaped document text in HTML', async () => {
    const n = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="7"/><w:numFmt w:val="decimal"/><w:lvlText w:val="&lt;script&gt;%1&lt;/script&gt;"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const html = await docxBufferToHtml(makeNumberedDocx(p('Alpha'), n));
    expect(html).toContain('&lt;script&gt;7&lt;/script&gt; Alpha');
    expect(html).not.toContain('<script>');
  });
});
