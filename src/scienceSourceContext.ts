interface SourceContextInput {
  url: string | null;
  sourceName: string;
  title: string;
  content: string | null;
}

const MIN_EXISTING_CONTEXT = 900;
const MAX_CONTEXT_CHARS = 4200;

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'");
}

function normalizeText(value: string | null | undefined, limit = MAX_CONTEXT_CHARS): string {
  return decodeHtml(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function extractMeta(html: string, key: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${key}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return normalizeText(match[1], 1200);
  }
  return '';
}

function extractJsonLdDescriptions(html: string): string[] {
  const matches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const descriptions: string[] = [];
  for (const match of matches) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1] ?? '')) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        for (const key of ['description', 'abstract', 'articleBody']) {
          const value = record[key];
          if (typeof value === 'string') descriptions.push(normalizeText(value, 1800));
        }
      }
    } catch {
      // Ignore malformed JSON-LD; many publishers embed invalid fragments.
    }
  }
  return descriptions.filter(Boolean);
}

function extractParagraphs(html: string): string {
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => normalizeText(match[1], 900))
    .filter((text) => text.length >= 80)
    .filter((text) => !/(cookie|newsletter|subscribe|advertisement|all rights reserved)/i.test(text))
    .slice(0, 8);
  return paragraphs.join(' ');
}

function extractUsefulText(html: string): string {
  const candidates = [
    extractMeta(html, 'description'),
    extractMeta(html, 'og:description'),
    extractMeta(html, 'twitter:description'),
    ...extractJsonLdDescriptions(html),
    extractParagraphs(html),
  ].filter(Boolean);

  const unique = Array.from(new Set(candidates));
  return normalizeText(unique.join(' '), MAX_CONTEXT_CHARS);
}

function isFetchableUrl(url: string | null): url is string {
  if (!url?.startsWith('https://')) return false;
  return !url.includes('news.google.com/rss/articles/');
}

export async function buildScienceSourceContext(input: SourceContextInput): Promise<string> {
  const existing = normalizeText(input.content, MAX_CONTEXT_CHARS);
  if (existing.length >= MIN_EXISTING_CONTEXT) return existing;
  if (!isFetchableUrl(input.url)) return existing;

  try {
    const res = await fetch(input.url, {
      headers: {
        'User-Agent': 'TechPulse/1.0 science context fetcher',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return existing;

    const contentType = res.headers.get('content-type') ?? '';
    if (!/html|xml|text/i.test(contentType)) return existing;

    const html = await res.text();
    const fetched = extractUsefulText(html);
    if (fetched.length <= existing.length) return existing;

    return fetched;
  } catch {
    return existing;
  }
}
