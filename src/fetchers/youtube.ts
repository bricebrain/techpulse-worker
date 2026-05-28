import type { Article, Source } from '../types';
import { makeHash } from '../utils';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Rotation de clés : retourne la première clé non-vide */
export function pickYoutubeKey(...keys: (string | undefined)[]): string | undefined {
  return keys.find((k) => k && k.trim().length > 0);
}

export async function fetchYoutube(source: Source, apiKey?: string): Promise<Article[]> {
  // On essaie d'abord via le flux RSS public (0 quota)
  const rssArticles = await fetchYoutubeRss(source);
  if (rssArticles.length > 0) return rssArticles;

  // Fallback sur l'API YouTube si une clé est disponible
  if (apiKey) return fetchYoutubeApi(source, apiKey);

  return [];
}

async function fetchYoutubeRss(source: Source): Promise<Article[]> {
  const channelId = source.value;
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (!res?.ok) return [];

  const xml = await res.text();
  const cutoff = Date.now() - MAX_AGE_MS;
  const now = Date.now();
  const results: Article[] = [];

  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractAtomTag(block, 'title');
    const videoId = extractAtomTag(block, 'yt:videoId');
    const published = extractAtomTag(block, 'published');
    const description = extractAtomTag(block, 'media:description');

    if (!title || !videoId) continue;

    const published_at = published ? new Date(published).getTime() : null;
    if (published_at && published_at < cutoff) continue;

    results.push({
      hash: makeHash(`youtube|${videoId}`),
      theme: source.theme,
      title: title.trim(),
      source_name: source.name,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      content: description?.slice(0, 1000) ?? '',
      published_at,
      fetched_at: now,
    });

    if (results.length >= source.limit_count) break;
  }

  return results;
}

async function fetchYoutubeApi(source: Source, apiKey: string): Promise<Article[]> {
  const channelId = source.value;
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('channelId', channelId);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('order', 'date');
  url.searchParams.set('maxResults', String(source.limit_count));
  url.searchParams.set('type', 'video');
  url.searchParams.set('key', apiKey);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (!res?.ok) return [];

  const json = await res.json<YoutubeApiResponse>();
  const now = Date.now();

  return (json.items ?? []).map((item) => ({
    hash: makeHash(`youtube|${item.id.videoId}`),
    theme: source.theme,
    title: item.snippet.title,
    source_name: source.name,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    content: item.snippet.description?.slice(0, 1000) ?? '',
    published_at: new Date(item.snippet.publishedAt).getTime(),
    fetched_at: now,
  }));
}

function extractAtomTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m?.[1]?.trim() ?? '';
}

interface YoutubeApiResponse {
  items?: {
    id: { videoId: string };
    snippet: { title: string; description: string; publishedAt: string };
  }[];
}
