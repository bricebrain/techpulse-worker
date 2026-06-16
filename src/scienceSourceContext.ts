interface SourceContextInput {
  url: string | null;
  sourceName: string;
  title: string;
  content: string | null;
  xaiApiKey?: string;
}

const MIN_EXISTING_CONTEXT = 900;
const MIN_CONTEXT_FOR_WEB_SEARCH = 1200;
const MAX_CONTEXT_CHARS = 4200;

interface XaiResponsesOutput {
  type: string;
  content?: Array<{ type: string; text?: string }>;
}

interface XaiResponsesResult {
  output?: XaiResponsesOutput[];
  status?: string;
}

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

function extractXaiText(data: XaiResponsesResult): string {
  for (const out of data.output ?? []) {
    if (out.type !== 'message') continue;
    for (const block of out.content ?? []) {
      if (block.type === 'output_text' && block.text) return block.text;
    }
  }
  return '';
}

function parseContextJson(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return normalizeText(text, MAX_CONTEXT_CHARS);
  try {
    const parsed = JSON.parse(match[0]) as { context?: unknown; sources?: unknown };
    const context = typeof parsed.context === 'string' ? parsed.context : '';
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter((item): item is string => typeof item === 'string').slice(0, 5)
      : [];
    return normalizeText(
      [context, sources.length ? `Sources consultées: ${sources.join(' ; ')}` : ''].join('\n'),
      MAX_CONTEXT_CHARS,
    );
  } catch {
    return normalizeText(text, MAX_CONTEXT_CHARS);
  }
}

function buildWebSearchPrompt(input: SourceContextInput, existing: string): string {
  return `Recherche sur le web le contenu scientifique réel correspondant à ce signal.

Objectif : produire un contexte factuel exploitable par TechPulse pour écrire une fiche pédagogique.

Contraintes :
- Utilise uniquement des informations trouvées dans des sources réelles.
- Privilégie la source primaire, le papier, le preprint, la revue, l'institution ou un média scientifique fiable.
- Ne remplis pas avec des généralités si tu ne trouves pas l'article exact.
- Reste factuel : méthode, résultat, mécanisme, limite, implication.
- Si le sujet est médical, précise le stade de preuve quand il est identifiable.

Signal :
Titre : ${input.title}
Source initiale : ${input.sourceName}
URL initiale : ${input.url ?? 'absente'}
Extrait déjà disponible : ${existing || 'aucun'}

Réponds uniquement en JSON valide :
{
  "context": "contexte scientifique détaillé en français, 700 à 1200 mots si possible",
  "sources": ["url source 1", "url source 2"]
}`;
}

async function fetchXaiWebContext(input: SourceContextInput, existing: string): Promise<string> {
  if (!input.xaiApiKey || existing.length >= MIN_CONTEXT_FOR_WEB_SEARCH) return existing;

  try {
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.xaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-4',
        input: [
          {
            role: 'user',
            content: buildWebSearchPrompt(input, existing),
          },
        ],
        tools: [{ type: 'web_search' }],
        temperature: 0.1,
        max_output_tokens: 2500,
      }),
      signal: AbortSignal.timeout(55_000),
    });

    if (!res.ok) return existing;
    const data = await res.json<XaiResponsesResult>();
    const context = parseContextJson(extractXaiText(data));
    return context.length > existing.length ? context : existing;
  } catch {
    return existing;
  }
}

export async function buildScienceSourceContext(input: SourceContextInput): Promise<string> {
  const existing = normalizeText(input.content, MAX_CONTEXT_CHARS);
  if (existing.length >= MIN_CONTEXT_FOR_WEB_SEARCH) return existing;
  if (!isFetchableUrl(input.url)) return fetchXaiWebContext(input, existing);

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
    const best = fetched.length > existing.length ? fetched : existing;
    if (best.length < MIN_EXISTING_CONTEXT) return fetchXaiWebContext(input, best);

    return best.length < MIN_CONTEXT_FOR_WEB_SEARCH
      ? await fetchXaiWebContext(input, best)
      : best;
  } catch {
    return fetchXaiWebContext(input, existing);
  }
}
