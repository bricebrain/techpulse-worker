import type { Article, Source } from '../types';
import { makeHash } from '../utils';

// User-Agent réaliste pour éviter le blocage Reddit
const REDDIT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export async function fetchReddit(source: Source): Promise<Article[]> {
  const subreddit = source.value.replace(/^r\//, '');
  const limit = source.limit_count;

  // Essai 1 : API JSON www.reddit.com
  const res = await tryRedditJson(`https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`)
    // Essai 2 : old.reddit.com (souvent moins filtré)
    ?? await tryRedditJson(`https://old.reddit.com/r/${subreddit}/hot.json?limit=${limit}`);

  if (!res) return [];

  const now = Date.now();
  return res
    .slice(0, limit)
    .map((p) => ({
      hash: makeHash(`reddit|${p.id}`),
      theme: source.theme,
      title: p.title,
      source_name: source.name,
      url: p.url || `https://reddit.com${p.permalink}`,
      content: p.selftext?.slice(0, 1000) ?? '',
      published_at: p.created_utc ? p.created_utc * 1000 : null,
      fetched_at: now,
    }));
}

async function tryRedditJson(url: string): Promise<RedditPost[] | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': REDDIT_UA,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = await res.json<{ data?: { children?: { data: RedditPost }[] } }>();
    return json?.data?.children?.map((c) => c.data) ?? null;
  } catch {
    return null;
  }
}

interface RedditPost {
  id: string;
  title: string;
  selftext?: string;
  url?: string;
  permalink: string;
  created_utc?: number;
}
