/**
 * Fetcher Grok Live Search — xAI Responses API
 *
 * Utilise le nouveau format xAI (/v1/responses) avec web_search tool.
 * L'ancien search_parameters est déprécié (HTTP 410).
 *
 * Doc : https://docs.x.ai/docs/guides/tools/overview
 */

import type { Env, Source, Article } from '../types';
import { resolveSecrets } from '../types';
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

function getThemeGuidance(theme: string): string {
  switch (theme) {
    case 'ai':
      return 'Prioritize frontier model launches, inference infrastructure, AI chips, compute partnerships, hyperscaler AI capex, enterprise platform moves, and meaningful developer tooling announcements.';
    case 'finance':
      return 'Prioritize market-moving developments in tech finance: earnings, semiconductor demand, cloud margins, AI capex, fintech infrastructure, crypto market structure, ETF flows, regulation, funding, and M&A.';
    case 'general':
      return 'Prioritize developer platforms, software infrastructure, browser and runtime changes, backend tooling, cloud launches, databases, notable framework releases, and engineering announcements from major tech companies.';
    case 'science':
      return 'Prioritize surprising frontier science and applied research: astrophysics, quantum physics, neuroscience, biotech, medicine, climate science, materials, robotics, space science, semiconductors, and research that may reshape technology over the next decade.';
    default:
      return 'Prioritize timely, high-signal developments that matter in a professional technology and finance watch workflow.';
  }
}

function buildPrompt(source: Source, limit: number): string {
  const themeGuidance = getThemeGuidance(source.theme);
  return (
    `Search the web right now for this watch query: "${source.value}".\n\n` +
    `Context:\n` +
    `- Theme: ${source.theme}\n` +
    `- Source profile: ${source.name}\n` +
    `- Goal: find early, high-signal developments that are useful in a professional watch product.\n\n` +
    `Editorial guidance:\n` +
    `- ${themeGuidance}\n` +
    `- Prefer primary or high-credibility reporting when possible.\n` +
    `- Prefer concrete news, research papers, lab results, discoveries, launches, filings, partnerships, regulation, product updates, or engineering changes.\n` +
    `- Avoid generic explainers, tutorials, jobs, opinion pieces, listicles, evergreen content, and low-value recap posts.\n` +
    `- Avoid returning near-duplicate articles that all say the same thing.\n\n` +
    `Return exactly the ${limit} strongest and most recent news articles (published in the last 48 hours) as a valid JSON array:\n` +
    `[{"title":"...","url":"https://...","summary":"2-3 sentence summary in English","published_at":"2026-05-31T10:00:00Z"},...]\n\n` +
    `Rules:\n` +
    `- Only real articles published in the last 48 hours\n` +
    `- Real URLs only (no placeholders)\n` +
    `- Summaries must explain the specific signal, not just repeat the headline\n` +
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
  const { XAI_API_KEY } = await resolveSecrets(env);
  if (!XAI_API_KEY) {
    console.warn('[Grok] XAI_API_KEY non configurée — source ignorée');
    return [];
  }

  const limit = Math.min(source.limit_count ?? 10, 15);

  console.log(`[Grok] Fetch live : "${source.value.slice(0, 60)}" (limite ${limit})`);

  try {
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-4',
        input: [
          {
            role: 'user',
            content: buildPrompt(source, limit),
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
