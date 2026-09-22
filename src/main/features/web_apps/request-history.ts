/** Compact sequential SDK ids without expiring replay protection. Legacy/custom
 * ids remain supported; out-of-order calls and cancel-before-call are remembered. */
export class RequestHistory {
  private documents = new Map<string, Array<[number, number]>>();
  private other = new Set<string>();
  private sequence(id: string): { document: string; n: number } | null {
    const match = /^((?:d[a-f0-9]{32})?q)([1-9][0-9]*)$/.exec(id);
    if (!match) return null;
    const n = Number(match[2]);
    return Number.isSafeInteger(n) ? { document: match[1], n } : null;
  }
  has(id: string): boolean {
    const sequence = this.sequence(id);
    return sequence === null ? this.other.has(id) : (this.documents.get(sequence.document) ?? []).some(([start, end]) => start <= sequence.n && sequence.n <= end);
  }
  add(id: string): void {
    const sequence = this.sequence(id);
    if (sequence === null) { this.other.add(id); return; }
    const { document, n } = sequence;
    let ranges = this.documents.get(document);
    if (!ranges) { ranges = []; this.documents.set(document, ranges); }
    let i = 0;
    while (i < ranges.length && ranges[i][1] < n - 1) i++;
    let start = n, end = n;
    const first = i;
    while (i < ranges.length && ranges[i][0] <= end + 1) {
      start = Math.min(start, ranges[i][0]);
      end = Math.max(end, ranges[i][1]);
      i++;
    }
    ranges.splice(first, i - first, [start, end]);
  }
  clear(): void { this.documents.clear(); this.other.clear(); }
}
