/**
 * Fetcher Grok Live Search — xAI API (OpenAI-compatible)
 *
 * Interroge Grok avec la recherche web en temps réel pour récupérer
 * les dernières actualités tech/finance/AI du jour.
 *
 * Coût estimé : ~1 500 tokens/appel à ~$1.25/1M input + $2.50/1M output
 * soit ~$0.002/appel → sustainable avec 3 sources × 12 runs/j (cron 2h).
 */

import type { Env, Source, Article } from '../types';
import { makeHash } from '../utils';

interface GrokArticle {
  title: string;
  url: string;
  summary: string;
  published_at?: string;
}

// Modèle xAI avec live search activée
// grok-3 = le modèle standard de xAI, supporte search_parameters
const GROK_MODEL = 'grok-3';

function buildPrompt(query: string, limit: number): string {
  return (
    `Search the web right now for: "${query}".\n\n` +
    `Return exactly the ${limit} most recent news articles (last 24-48 hours) as a valid JSON array:\n` +
    `[{"title":"...","url":"https://...","summary":"2-3 sentence summary","published_at":"2026-05-31T10:00:00Z"},...]\n\n` +
    `Rules:\n` +
    `- Only articles published in the last 48 hours\n` +
    `- Real URLs only (no placeholders)\n` +
    `- Summary in English, 2-3 sentences max\n` +
    `- No markdown, no commentary, ONLY the JSON array`
  );
}

function parseArticles(text: string): GrokArticle[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as Array<Partial<GrokArticle>>;
    return parsed.filter(
      (a): a is GrokArticle =>
        typeof a.title === 'string' &&
        typeof a.url === 'string' &&
        a.url.startsWith('http'),
    );
  } catch {
    return [];
  }
}

export async function fetchGrokLive(source: Source, env: Env): Promise<Article[]> {
  if (!env.XAI_API_KEY) {
    console.warn('[Grok] XAI_API_KEY non configurée — source ignorée');
    return [];
  }

  const query = source.value;
  const limit = Math.min(source.limit_count ?? 10, 15);

  console.log(`[Grok] Fetch live : "${query}" (limite ${limit})`);

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a tech journalist assistant. You search the web for the latest news and return structured JSON. Always return real, verified URLs.',
          },
          { role: 'user', content: buildPrompt(query, limit) },
        ],
        search_parameters: {
          mode: 'on',           // Force live web search
          return_citations: false,
          max_search_results: limit + 5, // Marge pour filtrage
        },
        temperature: 0.1,
        max_tokens: 2500,
      }),
      signal: AbortSignal.timeout(35_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[Grok] ${source.name} → HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return [];
    }

    const data = await res.json<{ choices?: { message?: { content?: string } }[] }>();
    const text = data?.choices?.[0]?.message?.content ?? '';

    if (!text) {
      console.warn(`[Grok] ${source.name} → réponse vide`);
      return [];
    }

    const parsed = parseArticles(text);
    if (!parsed.length) {
      console.warn(`[Grok] ${source.name} → aucun article parsé (réponse: ${text.slice(0, 200)})`);
      return [];
    }

    const now = Date.now();
    const articles: Article[] = parsed.map((a) => ({
      hash: makeHash(`grok|${a.url}`),
      theme: source.theme,
      title: a.title.trim(),
      source_name: source.name,
      url: a.url,
      content: (a.summary ?? '').trim() || null,
      published_at: a.published_at
        ? (new Date(a.published_at).getTime() || now)
        : now,
      fetched_at: now,
    }));

    console.log(`[Grok] ${source.name} → ${articles.length} articles récupérés`);
    return articles;
  } catch (e) {
    console.warn(`[Grok] Exception ${source.name}:`, e);
    return [];
  }
}
