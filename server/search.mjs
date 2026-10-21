// SPDX-License-Identifier: MIT
import { publicUrl, required } from '../shared/domain.mjs';
import { readableHtml } from './network.mjs';
export class WebSearch {
  constructor({ apiKey = '', fetcher = fetch } = {}) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }
  get configured() {
    return !!this.apiKey;
  }
  async search(query, signal) {
    query = required(query, 'Search query', 500);
    if (!this.configured)
      throw new Error(
        'Web search needs BRAVE_SEARCH_API_KEY on the server. You can provide public URLs for research without a search key.',
      );
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.search = new URLSearchParams({ q: query, count: '5' }).toString();
    const response = await this.fetcher(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`The search provider returned HTTP ${response.status}.`);
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error('The search response exceeded the limit.');
    const json = JSON.parse(body);
    const results = [];
    for (const r of (json.web?.results || []).slice(0, 5)) {
      try {
        results.push({
          title: String(r.title || 'Public page').slice(0, 200),
          url: publicUrl(r.url),
          excerpt: readableHtml(String(r.description || '')).text.slice(0, 1000),
        });
      } catch {
        /* Discard private or unsupported URLs. */
      }
    }
    return { provider: 'Brave Search', query, results };
  }
}
