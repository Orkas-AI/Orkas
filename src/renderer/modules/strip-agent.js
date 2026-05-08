// Pure string functions for atomic-container stripping of LLM-emitted
// XML tags surfacing in renderer text. Three tag families share these
// helpers via `tagName` parameter:
//   - `<agent>`               — commander create / edit container
//   - `<agent-input-form>`    — agent's form widget (streaming placeholder)
//   - `<agent-input-submission>` — user form-reply tag (display strip)
//
// All three need the same prose/code guard — if any of them is mentioned
// literally inside a fenced code block or inline backtick span (e.g., a
// protocol explanation), the literal mention must survive; the real
// container must still be stripped/replaced atomically even when its body
// contains backticks / fences / quotes (otherwise the prose/code split
// fragments the container and the post-fragment suffix leaks past — the
// 34e27fcb / a3110e61 / follow-up cycle on `<agent>`).
//
// Lives in a standalone file so vitest can `require()` it under Node and
// pin the set-A vs set-B invariants — regressions in this category aren't
// catchable by typecheck or eyeball review. Matching test file:
// `test/renderer/strip-agent.test.ts`.
//
// CommonJS-export tail at the bottom is the ONLY allowed escape from the
// renderer's "no export/import" rule (PC/CLAUDE.md §8) — it's guarded by
// `typeof module`, evaluates to a no-op in the browser (where `module` is
// undefined), and is purely a test bridge for pure functions. Don't
// extend this convention to non-pure renderer code.

// Split a markdown buffer into alternating prose / code segments. "Code" =
// fenced ``` / ~~~ blocks (≤3-space indent, info-string allowed) plus inline
// backtick spans; everything else is prose. Used by the `<agent>` container
// strippers so coding scenarios — where the LLM legitimately quotes `<agent>`
// inside a code sample to explain how this app's structured-output protocol
// works — don't see the bubble silently truncated. Mid-stream unclosed fences
// and unclosed inline backticks are treated as code through end-of-buffer,
// matching how the markdown renderer would paint them.
function _splitMarkdownProseCode(text) {
  const segs = [];
  if (!text) return segs;
  const n = text.length;
  let proseStart = 0;
  const flushProse = (end) => {
    if (end > proseStart) segs.push({ kind: 'prose', text: text.slice(proseStart, end) });
  };
  let i = 0;
  while (i < n) {
    const lineStart = i === 0 || text[i - 1] === '\n';
    if (lineStart) {
      let j = i;
      let indent = 0;
      while (indent < 3 && text[j] === ' ') { j++; indent++; }
      const ch = text[j];
      if (ch === '`' || ch === '~') {
        let count = 0;
        while (text[j + count] === ch) count++;
        if (count >= 3) {
          let k = j + count;
          while (k < n && text[k] !== '\n') k++;
          let scan = k < n ? k + 1 : n;
          let close = -1;
          while (scan < n) {
            let s = scan;
            let pad = 0;
            while (pad < 3 && text[s] === ' ') { s++; pad++; }
            if (text[s] === ch) {
              let cc = 0;
              while (text[s + cc] === ch) cc++;
              if (cc >= count) {
                let lineEnd = s + cc;
                while (lineEnd < n && text[lineEnd] !== '\n') lineEnd++;
                close = lineEnd;
                break;
              }
            }
            while (scan < n && text[scan] !== '\n') scan++;
            if (scan < n) scan++;
          }
          flushProse(i);
          const endIdx = close >= 0 ? close : n;
          segs.push({ kind: 'code', text: text.slice(i, endIdx) });
          proseStart = endIdx;
          i = endIdx;
          continue;
        }
      }
    }
    if (text[i] === '`') {
      let count = 0;
      while (text[i + count] === '`') count++;
      let j = i + count;
      let close = -1;
      while (j < n) {
        if (text[j] === '`') {
          let cc = 0;
          while (text[j + cc] === '`') cc++;
          if (cc === count) { close = j + cc; break; }
          j += cc;
        } else {
          j++;
        }
      }
      if (close > 0) {
        flushProse(i);
        segs.push({ kind: 'code', text: text.slice(i, close) });
        proseStart = close;
        i = close;
        continue;
      }
      flushProse(i);
      segs.push({ kind: 'code', text: text.slice(i, n) });
      proseStart = n;
      i = n;
      continue;
    }
    i++;
  }
  flushProse(n);
  return segs;
}

// Find every `<TAG>...</TAG>` (or unclosed `<TAG>...EOF`) range whose
// OPENING tag falls in an outer prose segment. The tagged container is
// treated as one atomic unit — once the opening tag is in prose, we walk
// to the matching `</TAG>` (or EOF) regardless of what's inside, so
// backticks / fences / quotes authored inside the body don't fragment
// the container and let the post-fragment suffix (often including the
// closing tag) leak past the stripper. The outer-context check still
// preserves literal mentions of the tag inside fenced code / inline
// backtick spans (coding-explanation case).
//
// Generalized over `tagName` so the same atomic-container guarantee
// covers `<agent>` (commander create/edit container), `<agent-input-form>`
// (agent's form widget), and `<agent-input-submission>` (user form-reply
// tag). Open form: `<tagName>` OR `<tagName attr="..." attr="...">`.
// Close form: `</tagName>`. The boundary check (next char must be `>`,
// whitespace, or `/`) prevents `<agent>` lookup from also matching
// `<agent-input-form>` and similar siblings.
//
// Granularity invariant: the guard (prose/code classification) is
// evaluated at the entity's OPENING boundary, NOT per-fragment inside.
// Re-anchoring inside would re-introduce the leak.
function _findOuterTagRanges(text, tagName) {
  if (!text || !tagName) return [];
  const openLeader = `<${tagName}`;
  const closeLiteral = `</${tagName}>`;
  if (text.indexOf(openLeader) < 0) return [];
  const segs = _splitMarkdownProseCode(text);
  const ranges = [];
  let pos = 0;
  for (const seg of segs) {
    const segStart = pos;
    pos += seg.text.length;
    if (seg.kind !== 'prose') continue;
    let from = segStart;
    while (from < pos) {
      const last = ranges.length ? ranges[ranges.length - 1] : null;
      if (last && from < last[1]) from = last[1];
      if (from >= pos) break;
      const openIdx = text.indexOf(openLeader, from);
      if (openIdx < 0 || openIdx >= pos) break;
      // Boundary check: next char after `<tagName` must be `>` / whitespace
      // / `/` so we don't match `<agent>` against `<agent-input-form>`.
      const next = text.charCodeAt(openIdx + openLeader.length);
      const isBoundary = next === 62 /* > */ || next === 32 /* space */
        || next === 9 /* \t */ || next === 10 /* \n */ || next === 13 /* \r */
        || next === 47 /* / */;
      if (!isBoundary) {
        from = openIdx + openLeader.length;
        continue;
      }
      // Walk past attributes to the closing `>` of the open tag, then to
      // `</tagName>` (or EOF). Unclosed open-tag mid-stream → swallow rest
      // of buffer atomically.
      const tagEnd = text.indexOf('>', openIdx + openLeader.length);
      if (tagEnd < 0) {
        ranges.push([openIdx, text.length]);
        from = text.length;
        break;
      }
      const closeIdx = text.indexOf(closeLiteral, tagEnd + 1);
      const endPos = closeIdx < 0 ? text.length : closeIdx + closeLiteral.length;
      ranges.push([openIdx, endPos]);
      from = endPos;
    }
  }
  return ranges;
}

// Strip every outer `<tagName>` container from `text` entirely. Used at
// final-render time and at user-message-display time as a safety strip.
function _stripOuterTagBlocks(text, tagName) {
  if (!text) return text;
  const ranges = _findOuterTagRanges(text, tagName);
  if (!ranges.length) return text;
  let out = '';
  let cursor = 0;
  for (const [s, e] of ranges) {
    out += text.slice(cursor, s);
    cursor = e;
  }
  out += text.slice(cursor);
  return out;
}

// Replace every outer `<tagName>` container with `placeholder`. Used at
// streaming time to keep the bubble clean while the LLM is still typing
// the body.
function _replaceOuterTagBlocks(buf, tagName, placeholder) {
  if (!buf) return buf;
  const ranges = _findOuterTagRanges(buf, tagName);
  if (!ranges.length) return buf;
  let out = '';
  let cursor = 0;
  for (const [s, e] of ranges) {
    out += buf.slice(cursor, s) + placeholder;
    cursor = e;
  }
  out += buf.slice(cursor);
  return out;
}

// `<agent>`-specific wrappers. The final-time variant collapses runs of
// blank lines and trims — that post-processing matters at the bubble
// boundary (commander wraps the container in surrounding prose; clean
// visual gap matters).
function _findOuterAgentRanges(text) {
  return _findOuterTagRanges(text, 'agent');
}
function _stripSurvivingAgentBlocks(text) {
  if (!text) return text;
  const out = _stripOuterTagBlocks(text, 'agent');
  if (out === text) return text;
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
function _replaceOuterAgentBlocks(buf, placeholder) {
  return _replaceOuterTagBlocks(buf, 'agent', placeholder);
}

// Defense-in-depth final-time strip for **every** structural container
// that may surface in assistant / user message text:
//   - `<agent>`                 — primary case, commander create/edit
//   - `<agent-input-form>`      — agent's form widget; main is supposed to
//     extract the payload + mount the widget so this never reaches final,
//     but if the main extractor misses a variant the raw XML lands in the
//     bubble alongside the widget. Strip silently rather than render raw.
//   - `<agent-input-submission>` — user form-reply tag; user-side render
//     already strips it via _stripSubmissionTagForDisplay, but if it ever
//     leaks into assistant text (LLM hallucination / quoting), strip too.
//
// Each tag is removed independently via the same atomic-container helper
// so the prose/code guard applies uniformly — a literal mention inside a
// fenced block / inline backtick survives all three. After all three
// strip passes, collapse blank-line runs and trim, identical to the
// `<agent>`-only post-processing.
function _stripSurvivingStructuralBlocks(text) {
  if (!text) return text;
  let out = text;
  for (const tag of ['agent', 'agent-input-form', 'agent-input-submission']) {
    out = _stripOuterTagBlocks(out, tag);
  }
  if (out === text) return text;
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// Test bridge — see file header. No-op in the browser (`module` undefined).
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    _splitMarkdownProseCode,
    _findOuterTagRanges,
    _stripOuterTagBlocks,
    _replaceOuterTagBlocks,
    _findOuterAgentRanges,
    _stripSurvivingAgentBlocks,
    _replaceOuterAgentBlocks,
    _stripSurvivingStructuralBlocks,
  };
}
