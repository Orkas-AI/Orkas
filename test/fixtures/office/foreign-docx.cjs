'use strict';
const AdmZip = require('adm-zip');

function foreignDocxBytes(spacedBreaks) {
  // Build independently of OfficeCLI: its own output already uses its ZIP
  // encoding and hid the read-only close-time repack regression upstream.
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  ));
  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  ));
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>Readonly review fixture 检查不应改写原文件</w:t>'
    + (spacedBreaks ? '<w:br /><w:tab />' : '')
    + '<w:t>Stable text 123</w:t></w:r></w:p>'
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>',
  ));
  return zip.toBuffer();
}


function annotatedDocxBytes(kinds, footnoteCount = 1) {
  const zip = new AdmZip(foreignDocxBytes(true));
  let document = zip.readAsText('word/document.xml');
  let types = zip.readAsText('[Content_Types].xml');
  const relationships = [];
  for (const kind of kinds) {
    const id = kind === 'footnote' ? 7 : 12;
    const text = kind === 'footnote' ? 'FOOTNOTE_RECEIPT_529' : 'ENDNOTE_RECEIPT_731';
    let notes = '';
    for (let index = 0; index < (kind === 'footnote' ? footnoteCount : 1); index++) {
      const noteId = id + index;
      const noteText = index === 0 ? text : `FOOTNOTE_RECEIPT_${noteId}`;
      document = document.replace('</w:p>', `<w:r><w:${kind}Reference w:id="${noteId}"/></w:r></w:p>`);
      notes += `<w:${kind} w:id="${noteId}"><w:p><w:r><w:${kind}Ref/></w:r><w:r><w:t>${noteText}</w:t></w:r></w:p></w:${kind}>`;
    }
    zip.addFile(`word/${kind}s.xml`, Buffer.from(
      `<?xml version="1.0"?><w:${kind}s xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
      + `<w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}>`
      + `<w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`
      + notes + `</w:${kind}s>`,
    ));
    relationships.push(`<Relationship Id="rId${kind}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}s" Target="${kind}s.xml"/>`);
    types = types.replace('</Types>', `<Override PartName="/word/${kind}s.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}s+xml"/></Types>`);
  }
  if (relationships.length) zip.addFile('word/_rels/document.xml.rels', Buffer.from(
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + relationships.join('') + '</Relationships>',
  ));
  zip.updateFile('word/document.xml', Buffer.from(document));
  zip.updateFile('[Content_Types].xml', Buffer.from(types));
  return zip.toBuffer();
}

module.exports = { foreignDocxBytes, annotatedDocxBytes };
