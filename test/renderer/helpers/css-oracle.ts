// Declaration-level oracle for renderer stylesheet tests. Cases assert what a
// rule declares (`{ width: 'min(240px, 100%)' }`) instead of freezing the
// stylesheet's whitespace or ordering, so a reformat cannot fail them while a
// real declaration change still does. Shared by conversation-sidebar.test.ts
// and connectors-degraded-card.test.ts.

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every rule whose selector list names `selector` exactly, in source order
 *  (rules nested inside `@media` blocks included). */
export function cssDeclarationsForSelector(source: string, selector: string): Array<Record<string, string>> {
  const rules: Array<Record<string, string>> = [];
  for (const match of stripComments(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(item => item.trim());
    if (!selectors.includes(selector)) continue;
    const declarations: Record<string, string> = {};
    for (const entry of match[2].split(';')) {
      const separator = entry.indexOf(':');
      if (separator < 0) continue;
      const property = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      if (property && value) declarations[property] = value;
    }
    rules.push(declarations);
  }
  return rules;
}

export function onlyCssDeclarations(source: string, selector: string): Record<string, string> {
  const rules = cssDeclarationsForSelector(source, selector);
  if (rules.length !== 1) {
    throw new Error(`Expected one CSS rule for ${selector}, found ${rules.length}`);
  }
  return rules[0];
}

/** Top-level `@media` blocks as `{ query, body }`; a body keeps its nested
 *  rules so it can be fed back into `cssDeclarationsForSelector`. */
export function cssMediaBlocks(source: string): Array<{ query: string; body: string }> {
  const text = stripComments(source);
  const blocks: Array<{ query: string; body: string }> = [];
  const opener = /@media\s*([^{]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text))) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < text.length && depth > 0) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push({ query: match[1].trim(), body: text.slice(opener.lastIndex, index - 1) });
    opener.lastIndex = index;
  }
  return blocks;
}
