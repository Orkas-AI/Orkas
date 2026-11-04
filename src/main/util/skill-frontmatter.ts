/** Locate a standalone closing fence without treating scalar dashes as a delimiter. */
export function frontmatterCloseIndex(text: string): number {
  const m = /\n---[ \t]*\r?(?=\n|$)/.exec(text.slice(3));
  return m ? m.index + 3 + 1 : -1;
}
