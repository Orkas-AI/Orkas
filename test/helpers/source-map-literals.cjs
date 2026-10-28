'use strict';

// convert-source-map scans raw lines, including lines inside tsx's template
// strings. Vitest must retain the original test failure instead of crashing
// while decoding that template as a source map. Real malformed maps still fail.
const convert = require('convert-source-map');
const original = convert.fromSource;
const ts = require('typescript');

function fromSource(source) {
  try { return original(source); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const parsed = ts.createSourceFile('source.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (parsed.parseDiagnostics.length) throw error;
    const literals = [];
    function visit(node) {
      if (ts.isStringLiteralLike(node) || node.kind === ts.SyntaxKind.TemplateHead
          || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail) {
        literals.push([node.getStart(parsed), node.end]);
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    let removed = false;
    const comments = [...source.matchAll(convert.commentRegex)].filter(match => {
      const marker = match.index + match[0].search(/\/[/*]/);
      const literal = literals.some(([start, end]) => start <= marker && end > marker);
      removed ||= literal;
      return !literal;
    });
    if (!removed) throw error;
    return original(comments.map(match => match[0]).join('\n'));
  }
}

exports.fromSource = fromSource;
exports.install = () => { convert.fromSource = fromSource; };
