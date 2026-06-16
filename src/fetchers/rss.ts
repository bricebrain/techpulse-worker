import type { Article, Source } from '../types';
import { makeHash } from '../utils';

// Articles plus vieux que 7 jours → pas d'intérêt (on veut des infos fraîches)
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function fetchRss(source: Source): Promise<Article[]> {
  const res = await fetch(source.value, {
    headers: { 'User-Agent': 'TechPulse/1.0 (RSS reader)' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (!res?.ok) return [];

  const xml = await res.text();
  const cutoff = Date.now() - MAX_AGE_MS;
  return parseXml(xml, source)
    .filter((a) => !a.published_at || a.published_at >= cutoff)
    .slice(0, source.limit_count);
}

function parseXml(xml: string, source: Source): Article[] {
  const now = Date.now();
  const results: Article[] = [];

  // Supporte RSS 2.0 et Atom
  const isAtom = xml.includes('<feed');
  const itemRegex = isAtom
    ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/g
    : /<item\b[^>]*>([\s\S]*?)<\/item>/g;

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const url   = extractLink(block, isAtom);
    const desc  = extractTag(block, isAtom ? 'summary' : 'description') ||
                  extractTag(block, 'content:encoded') ||
                  extractTag(block, 'content');
    const dateStr = extractTag(block, isAtom ? 'updated' : 'pubDate') ||
                    extractTag(block, 'published') ||
                    extractTag(block, 'dc:date') ||
                    extractTag(block, 'prism:publicationDate');

    if (!title) continue;

    const published_at = dateStr ? new Date(dateStr).getTime() || null : null;
    const content = desc ? stripHtml(desc).slice(0, 1000) : '';
    const hash = makeHash(`${source.name}|${url || title}`);

    results.push({
      hash,
      theme: source.theme,
      title: stripHtml(title).trim(),
      source_name: source.name,
      url: url || null,
      content,
      published_at,
      fetched_at: now,
    });
  }

  return results;
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function extractLink(block: string, isAtom: boolean): string {
  if (isAtom) {
    const alternate = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    if (alternate?.[1]) return decodeHtmlEntities(alternate[1]).trim();
    const m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    return m?.[1] ? decodeHtmlEntities(m[1]).trim() : '';
  }
  const m = block.match(/<link>([\s\S]*?)<\/link>/i);
  return m?.[1] ? decodeHtmlEntities(m[1]).trim() : '';
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
