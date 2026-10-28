/** Default configured-service query bound, measured in Unicode characters. */
const DEFAULT_SEARCH_QUERY_CHARS = 128;

export function getSearchQueryMaxChars(provider?: string): number {
  // Tavily permits longer queries. The keyless route does not use this bound.
  return provider === 'tavily' ? 400 : DEFAULT_SEARCH_QUERY_CHARS;
}

export function validateSearchQuery(query: string, maxChars = DEFAULT_SEARCH_QUERY_CHARS): void {
  if (!query.trim()) throw new Error('A search query is required');
  let length = 0;
  for (const _character of query) {
    if (++length > maxChars) {
      throw new Error(`This search service supports at most ${maxChars} Unicode characters. Shorten the query and try again.`);
    }
  }
}
