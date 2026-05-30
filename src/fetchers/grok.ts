/**
 * Fetcher Grok Live Search — xAI Responses API
 *
 * Utilise le nouveau format xAI (/v1/responses) avec web_search tool.
 * L'ancien search_parameters est déprécié (HTTP 410).
 *
 * Doc : https://docs.x.ai/docs/guides/tools/overview
 */

import type { Env, Source, Article } from '../types';
import { makeHash } from '../utils';

interface GrokArticle {
  title: string;
  url: string;
  summary: string;
  published_at?: string;
}

// Responses API response shape
interface XAIResponsesOutput {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface XAIResponsesResult {
  output?: XAIResponsesOutput[];
  status?: string;
}

function buildPrompt(query: string, limit: number): string {
  return (
    `Search the web right now for: "${query}".\n\n` +
    `Return exactly the ${limit} most recent news articles (published in the last 48 hours) as a valid JSON array:\n` +
    `[{"title":"...","url":"https://...","summary":"2-3 sentence summary in English","published_at":"2026-05-31T10:00:00Z"},...]\n\n` +
    `Rules:\n` +
    `- Only real articles published in the last 48 hours\n` +
    `- Real URLs only (no placeholders)\n` +
    `- No markdown, no commentary — ONLY the JSON array`
  );
}

function extractText(data: XAIResponsesResult): string {
  // Responses API: output[0].content[0].text
  for (const out of data.output ?? []) {
    if (out.type === 'message') {
      for (const block of out.content ?? []) {
        if (block.type === 'output_text' && block.text) return block.text;
      }
    }
  }
  return '';
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

  console.log(`[Grok] Fetch live : "${query.slice(0, 60)}" (limite ${limit})`);

  try {
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-3',
        input: [
          {
            role: 'user',
            content: buildPrompt(query, limit),
          },
        ],
        tools: [{ type: 'web_search' }],
        temperature: 0.1,
        max_output_tokens: 2500,
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[Grok] ${source.name} → HTTP ${res.status}: ${errText.slice(0, 300)}`);
      return [];
    }

    const data = await res.json<XAIResponsesResult>();
    const text = extractText(data);

    if (!text) {
      console.warn(`[Grok] ${source.name} → réponse vide (status=${data.status})`);
      return [];
    }

    const parsed = parseArticles(text);
    if (!parsed.length) {
      console.warn(`[Grok] ${source.name} → aucun article parsé (extrait: ${text.slice(0, 200)})`);
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

    console.log(`[Grok] ${source.name} → ${articles.length} articles`);
    return articles;
  } catch (e) {
    console.warn(`[Grok] Exception ${source.name}:`, e);
    return [];
  }
}
