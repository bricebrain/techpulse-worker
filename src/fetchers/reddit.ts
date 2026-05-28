import type { Article, Source } from '../types';
import { makeHash } from '../utils';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function fetchReddit(source: Source): Promise<Article[]> {
  // source.value = 'r/reactnative'
  const subreddit = source.value.replace(/^r\//, '');
  const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${source.limit_count}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'TechPulse/1.0' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (!res?.ok) return [];

  const json = await res.json<{ data?: { children?: { data: RedditPost }[] } }>();
  const posts = json?.data?.children ?? [];
  const cutoff = Date.now() - MAX_AGE_MS;
  const now = Date.now();

  return posts
    .map((p) => p.data)
    .filter((p) => !p.created_utc || p.created_utc * 1000 >= cutoff)
    .slice(0, source.limit_count)
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

interface RedditPost {
  id: string;
  title: string;
  selftext?: string;
  url?: string;
  permalink: string;
  created_utc?: number;
}
