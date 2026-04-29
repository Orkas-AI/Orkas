/**
 * Text chunking for embedding.
 * Splits documents into overlapping chunks suitable for vector search.
 */

export type TextChunk = {
  text: string;
  startLine: number;
  endLine: number;
};

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_CHUNK_OVERLAP = 64;

/**
 * Split text into chunks by line boundaries with overlap.
 * Produces chunks of approximately `chunkSize` characters,
 * with `overlap` characters of overlap between adjacent chunks.
 */
export function chunkText(
  text: string,
  opts?: { chunkSize?: number; overlap?: number },
): TextChunk[] {
  const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts?.overlap ?? DEFAULT_CHUNK_OVERLAP;

  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length === 0) return [];

  const chunks: TextChunk[] = [];
  let currentChars = 0;
  let chunkStartLine = 0;
  let chunkLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    chunkLines.push(line);
    currentChars += line.length + 1; // +1 for newline

    if (currentChars >= chunkSize || i === lines.length - 1) {
      chunks.push({
        text: chunkLines.join("\n"),
        startLine: chunkStartLine + 1, // 1-based
        endLine: i + 1,
      });

      // Calculate overlap: keep the last few lines
      const overlapChars = overlap;
      let overlapLines = 0;
      let overlapSum = 0;
      for (let j = chunkLines.length - 1; j >= 0; j--) {
        overlapSum += chunkLines[j].length + 1;
        overlapLines++;
        if (overlapSum >= overlapChars) break;
      }

      if (i < lines.length - 1) {
        const kept = chunkLines.slice(-overlapLines);
        chunkStartLine = i + 1 - overlapLines;
        chunkLines = [...kept];
        currentChars = kept.reduce((sum, l) => sum + l.length + 1, 0);
      }
    }
  }

  return chunks;
}

/** Truncate a snippet to a max character length, preserving word boundaries. */
export function truncateSnippet(text: string, maxChars: number = 700): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.5 ? truncated.slice(0, lastSpace) : truncated) + "...";
}
