import AdmZip from 'adm-zip';
import { makeMinimalDocx } from './make-minimal-docx';

export const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export function numberedParagraph(text: string, numId = 1, level = 0, style = ''): string {
  return `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}
export function makeNumberedDocx(body: string, definitions = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="7"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>', styles = ''): Buffer {
  const zip = new AdmZip(makeMinimalDocx());
  zip.updateFile('word/document.xml', Buffer.from(`<w:document xmlns:w="${wordNs}"><w:body>${body}</w:body></w:document>`));
  zip.addFile('word/numbering.xml', Buffer.from(`<w:numbering xmlns:w="${wordNs}">${definitions}</w:numbering>`));
  zip.addFile('word/styles.xml', Buffer.from(`<w:styles xmlns:w="${wordNs}">${styles}</w:styles>`));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="n" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'));
  return zip.toBuffer();
}
