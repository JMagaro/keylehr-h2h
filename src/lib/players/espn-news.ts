/**
 * ESPN NFL news headlines — free, public, no auth. Used for the "around the league"
 * context strip on My Team. Pairs the Sleeper availability signals with human-readable
 * news so the page reads like a fantasy desk, not just numbers.
 *
 * Endpoint:
 *   GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=N
 * Response (subset we read):
 *   articles[] { headline, description, published, links.web.href }
 *
 * Cached every 30 minutes via the Next Data Cache. Returns [] on any error so the
 * strip degrades gracefully.
 */

const NEWS_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news';

export interface NewsHeadline {
  headline: string;
  description: string | null;
  link: string | null;
  published: string | null;
}

interface RawArticle {
  headline?: string;
  description?: string;
  published?: string;
  links?: { web?: { href?: string } };
}

export async function getLeagueNews(limit = 6): Promise<NewsHeadline[]> {
  try {
    const res = await fetch(`${NEWS_URL}?limit=${limit}`, {
      headers: { accept: 'application/json' },
      next: { revalidate: 1800 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { articles?: RawArticle[] };
    const articles = data.articles ?? [];
    const out: NewsHeadline[] = [];
    for (const a of articles) {
      const headline = a.headline?.trim();
      if (!headline) continue;
      out.push({
        headline,
        description: a.description?.trim() || null,
        link: a.links?.web?.href ?? null,
        published: a.published ?? null,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    console.error('[espn-news] fetch failed:', err);
    return [];
  }
}
