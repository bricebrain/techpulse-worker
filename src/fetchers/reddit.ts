import type { Article, Env, Source } from '../types';
import { makeHash } from '../utils';

// User-Agent réaliste pour le fallback direct (souvent bloqué depuis les IPs Cloudflare)
const REDDIT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export async function fetchReddit(source: Source, env: Env): Promise<Article[]> {
  const subreddit = source.value.replace(/^r\//, '');
  const limit = source.limit_count;

  let posts: RedditPost[] | null = null;

  // Priorité 1 : FastAPI proxy Render (IP AWS, non bloquée par Reddit)
  if (env.REDDIT_PROXY_URL) {
    posts = await tryFastApiProxy(env.REDDIT_PROXY_URL, env.REDDIT_PROXY_SECRET, subreddit, limit);
    if (posts) console.log(`[Reddit] Proxy FastAPI OK pour r/${subreddit} (${posts.length} posts)`);
  }

  // Fallback : fetch direct (souvent 403 depuis Cloudflare, mais ça ne coûte rien d'essayer)
  if (!posts) {
    posts =
      (await tryRedditJson(`https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`)) ??
      (await tryRedditJson(`https://old.reddit.com/r/${subreddit}/hot.json?limit=${limit}`));
    if (posts) console.log(`[Reddit] Fetch direct OK pour r/${subreddit}`);
  }

  if (!posts) {
    console.warn(`[Reddit] Impossible de récupérer r/${subreddit} (proxy non configuré ou bloqué)`);
    return [];
  }

  const now = Date.now();
  return posts.slice(0, limit).map((p) => ({
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

// ─── FastAPI proxy ────────────────────────────────────────────────────────────

async function tryFastApiProxy(
  baseUrl: string,
  secret: string | undefined,
  subreddit: string,
  limit: number,
): Promise<RedditPost[] | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/v1/reddit/${encodeURIComponent(subreddit)}?limit=${limit}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;

    const data = await res.json<{ posts?: RedditPost[] }>();
    return data?.posts?.length ? data.posts : null;
  } catch {
    return null;
  }
}

// ─── Fetch direct Reddit ──────────────────────────────────────────────────────

async function tryRedditJson(url: string): Promise<RedditPost[] | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': REDDIT_UA, Accept: 'application/json' },
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
