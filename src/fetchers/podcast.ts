import type { Article, Source } from '../types';
import { makeHash } from '../utils';

// Les épisodes plus vieux que 14 jours restent utiles (podcasts moins fréquents que l'actu)
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface ParsedEpisode {
  title: string;
  url: string | null;
  audioUrl: string | null;
  audioDuration: number | null;
  description: string;
  publishedAt: number | null;
  guid: string | null;
}

/**
 * Fetcher pour flux RSS de podcasts.
 * Détecte les <enclosure> audio (mp3/m4a/ogg) et l'<itunes:duration>.
 * Le transcript n'est PAS fait ici — c'est le pipeline ingest qui décide
 * d'appeler Render FastAPI /transcribe/podcast après filtrage thématique.
 */
export async function fetchPodcast(source: Source): Promise<Article[]> {
  const res = await fetch(source.value, {
    headers: { 'User-Agent': 'TechPulse/1.0 (Podcast reader)' },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!res?.ok) return [];

  const xml = await res.text();
  const cutoff = Date.now() - MAX_AGE_MS;

  return parsePodcastXml(xml)
    .filter((ep) => !ep.publishedAt || ep.publishedAt >= cutoff)
    .slice(0, source.limit_count)
    .map((ep) => toArticle(ep, source));
}

function parsePodcastXml(xml: string): ParsedEpisode[] {
  const results: ParsedEpisode[] = [];

  // RSS 2.0 (standard podcast) — on ignore Atom qui n'est pas utilisé pour les podcasts
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/g;

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const title = extractTag(block, 'title');
    if (!title) continue;

    const url = extractLink(block);
    const description =
      extractTag(block, 'description') ||
      extractTag(block, 'content:encoded') ||
      extractTag(block, 'itunes:summary') ||
      '';
    const dateStr =
      extractTag(block, 'pubDate') ||
      extractTag(block, 'dc:date') ||
      extractTag(block, 'published');

    // <enclosure url="..." type="audio/mpeg" length="..." />
    const audio = extractEnclosure(block);

    // <itunes:duration>HH:MM:SS</itunes:duration> ou secondes
    const durationStr = extractTag(block, 'itunes:duration');
    const audioDuration = parseDuration(durationStr);

    // <guid> pour dédoublonnage stable
    const guid = extractTag(block, 'guid');

    const publishedAt = dateStr ? new Date(dateStr).getTime() || null : null;

    results.push({
      title: stripHtml(title).trim(),
      url,
      audioUrl: audio.url,
      audioDuration,
      description: stripHtml(description).slice(0, 2000),
      publishedAt,
      guid: guid ? stripHtml(guid).trim() : null,
    });
  }

  return results;
}

function toArticle(ep: ParsedEpisode, source: Source): Article {
  const now = Date.now();
  // Préfixer le contenu avec la description pour que le filtrage thématique
  // (côté pipeline ingest) puisse décider de transcrire ou non.
  const content = ep.description || '';
  const hash = makeHash(`${source.name}|${ep.guid || ep.url || ep.title}`);

  return {
    hash,
    theme: source.theme,
    title: ep.title,
    source_name: source.name,
    url: ep.url,
    content,
    published_at: ep.publishedAt,
    fetched_at: now,
    audio_url: ep.audioUrl,
    audio_duration: ep.audioDuration,
  };
}

// ─── Helpers XML ──────────────────────────────────────────────────────────────

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function extractLink(block: string): string | null {
  // <link>https://...</link> (RSS standard)
  const m = block.match(/<link>([\s\S]*?)<\/link>/i);
  return m?.[1] ? decodeHtmlEntities(m[1]).trim() : null;
}

function extractEnclosure(block: string): { url: string | null } {
  // <enclosure url="https://...mp3" type="audio/mpeg" length="123456"/>
  const m = block.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*>/i);
  if (!m?.[1]) return { url: null };

  const url = decodeHtmlEntities(m[1]).trim();
  const typeMatch = block.match(/<enclosure[^>]*type=["']([^"']+)["'][^>]*>/i);
  const type = typeMatch?.[1]?.toLowerCase() ?? '';

  // Accepter uniquement les types audio connus
  if (type && !type.startsWith('audio/')) return { url: null };
  // Si pas de type précisé, filtrer par extension
  if (!type && !/\.(mp3|m4a|ogg|wav|aac|opus)(\?|$)/i.test(url)) return { url: null };

  return { url };
}

function parseDuration(value: string): number | null {
  if (!value) return null;
  const trimmed = value.trim();

  // Format "1234" (secondes)
  if (/^\d+$/.test(trimmed)) {
    const sec = parseInt(trimmed, 10);
    return Number.isFinite(sec) ? sec : null;
  }

  // Format "HH:MM:SS" ou "MM:SS"
  const parts = trimmed.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => !Number.isFinite(p))) return null;

  let seconds = 0;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else {
    return null;
  }

  return seconds;
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'");
}
