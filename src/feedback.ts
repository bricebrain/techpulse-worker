import type { Env } from './types';
import { err, json } from './utils';

type ArticleFeedbackSentiment = 'interesting' | 'neutral' | 'not_interesting';

export interface ArticleFeedbackRow {
  article_hash: string;
  source_name: string;
  theme: string | null;
  title: string;
  sentiment: ArticleFeedbackSentiment;
  updated_at: string;
}

export interface FeedbackPreferenceProfile {
  total: number;
  interesting_count: number;
  neutral_count: number;
  not_interesting_count: number;
  preferred_sources: string[];
  disliked_sources: string[];
  preferred_terms: string[];
  disliked_terms: string[];
  latest_feedback: ArticleFeedbackRow[];
}

const VALID_SENTIMENTS = new Set<ArticleFeedbackSentiment>([
  'interesting',
  'neutral',
  'not_interesting',
]);

export async function ensureArticleFeedbackTable(env: Env): Promise<void> {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS article_feedback (article_hash TEXT PRIMARY KEY, source_name TEXT NOT NULL, theme TEXT, title TEXT NOT NULL, sentiment TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_article_feedback_sentiment ON article_feedback(sentiment)',
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_article_feedback_theme ON article_feedback(theme)',
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_article_feedback_updated_at ON article_feedback(updated_at)',
  ).run();
}

function cleanText(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

const FEEDBACK_STOPWORDS = new Set([
  'about', 'after', 'avec', 'been', 'chez', 'dans', 'depuis', 'does', 'dont', 'from', 'have',
  'into', 'just', 'leur', 'mais', 'more', 'news', 'nous', 'pour', 'sans', 'sera', 'some',
  'such', 'sur', 'that', 'their', 'them', 'this', 'tout', 'very', 'what', 'with', 'will',
  'vous', 'your', 'les', 'des', 'une', 'the', 'and', 'for', 'openai', 'tech',
]);

function normalizeSourceKey(source: string): string {
  return source
    .split('·')[0]
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function extractFeedbackTerms(title: string): string[] {
  const normalized = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');

  return Array.from(new Set(
    normalized
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !FEEDBACK_STOPWORDS.has(word)),
  )).slice(0, 8);
}

function pickKeys(scoreMap: Map<string, number>, minScore: number, direction: 'positive' | 'negative'): string[] {
  return Array.from(scoreMap.entries())
    .filter(([, score]) => direction === 'positive' ? score >= minScore : score <= -minScore)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([key]) => key)
    .slice(0, 12);
}

function emptyFeedbackPreferenceProfile(): FeedbackPreferenceProfile {
  return {
    total: 0,
    interesting_count: 0,
    neutral_count: 0,
    not_interesting_count: 0,
    preferred_sources: [],
    disliked_sources: [],
    preferred_terms: [],
    disliked_terms: [],
    latest_feedback: [],
  };
}

function buildFeedbackPreferenceProfile(results: ArticleFeedbackRow[]): FeedbackPreferenceProfile {
  const sourceScores = new Map<string, number>();
  const termScores = new Map<string, number>();
  let interestingCount = 0;
  let neutralCount = 0;
  let notInterestingCount = 0;

  for (const item of results) {
    if (item.sentiment === 'interesting') interestingCount += 1;
    if (item.sentiment === 'neutral') neutralCount += 1;
    if (item.sentiment === 'not_interesting') notInterestingCount += 1;
    if (item.sentiment === 'neutral') continue;

    const direction = item.sentiment === 'interesting' ? 1 : -1;
    const sourceKey = normalizeSourceKey(item.source_name);
    sourceScores.set(sourceKey, (sourceScores.get(sourceKey) ?? 0) + direction);

    for (const term of extractFeedbackTerms(item.title)) {
      termScores.set(term, (termScores.get(term) ?? 0) + direction);
    }
  }

  return {
    total: results.length,
    interesting_count: interestingCount,
    neutral_count: neutralCount,
    not_interesting_count: notInterestingCount,
    preferred_sources: pickKeys(sourceScores, 2, 'positive'),
    disliked_sources: pickKeys(sourceScores, 1, 'negative'),
    preferred_terms: pickKeys(termScores, 2, 'positive'),
    disliked_terms: pickKeys(termScores, 2, 'negative'),
    latest_feedback: results.slice(0, 10),
  };
}

export async function getArticleFeedbackPreferenceProfile(env: Env): Promise<FeedbackPreferenceProfile> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT article_hash, source_name, theme, title, sentiment, updated_at
       FROM article_feedback
       ORDER BY updated_at DESC
       LIMIT 500`,
    ).all<ArticleFeedbackRow>();
    return buildFeedbackPreferenceProfile(results);
  } catch (error) {
    console.warn('[feedback] Preference profile unavailable', error);
    return emptyFeedbackPreferenceProfile();
  }
}

export function scorePreferenceAdjustment(input: {
  sourceNames: string[];
  title: string;
  summary?: string | null;
  profile: FeedbackPreferenceProfile;
}): { delta: number; reasons: string[] } {
  let delta = 0;
  const reasons: string[] = [];
  const sourceKeys = new Set(input.sourceNames.map(normalizeSourceKey).filter(Boolean));
  const searchable = `${input.title} ${input.summary ?? ''}`.toLowerCase();

  for (const source of sourceKeys) {
    if (input.profile.preferred_sources.includes(source)) {
      delta += 8;
      reasons.push(`source:${source}:up`);
    }
    if (input.profile.disliked_sources.includes(source)) {
      delta -= 14;
      reasons.push(`source:${source}:down`);
    }
  }

  for (const term of input.profile.preferred_terms) {
    if (searchable.includes(term)) {
      delta += 4;
      reasons.push(`term:${term}:up`);
    }
  }

  for (const term of input.profile.disliked_terms) {
    if (searchable.includes(term)) {
      delta -= 7;
      reasons.push(`term:${term}:down`);
    }
  }

  return {
    delta: Math.max(-35, Math.min(20, delta)),
    reasons: reasons.slice(0, 6),
  };
}

export async function recordArticleFeedback(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{
    articleHash?: string;
    source?: string;
    theme?: string | null;
    title?: string;
    sentiment?: ArticleFeedbackSentiment;
  }>().catch(() => null);

  const articleHash = cleanText(body?.articleHash, 160);
  const sourceName = cleanText(body?.source, 160);
  const theme = cleanText(body?.theme, 80) || null;
  const title = cleanText(body?.title, 400);
  const sentiment = body?.sentiment;

  if (!articleHash || !sourceName || !title) {
    return err('Payload feedback incomplet', 400);
  }
  if (!sentiment || !VALID_SENTIMENTS.has(sentiment)) {
    return err('Sentiment feedback invalide', 400);
  }

  await ensureArticleFeedbackTable(env);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO article_feedback (
      article_hash, source_name, theme, title, sentiment, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(article_hash) DO UPDATE SET
      source_name = excluded.source_name,
      theme = excluded.theme,
      title = excluded.title,
      sentiment = excluded.sentiment,
      updated_at = excluded.updated_at`,
  ).bind(articleHash, sourceName, theme, title, sentiment, now, now).run();

  return json({ ok: true, article_hash: articleHash, sentiment });
}

export async function getArticleFeedbackStats(env: Env): Promise<Response> {
  await ensureArticleFeedbackTable(env);

  const [summary, byTheme, recent] = await Promise.all([
    env.DB.prepare(
      `SELECT sentiment, COUNT(*) AS count
       FROM article_feedback
       GROUP BY sentiment
       ORDER BY count DESC`,
    ).all<{ sentiment: ArticleFeedbackSentiment; count: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(theme, 'unknown') AS theme, sentiment, COUNT(*) AS count
       FROM article_feedback
       GROUP BY theme, sentiment
       ORDER BY count DESC
       LIMIT 30`,
    ).all<{ theme: string; sentiment: ArticleFeedbackSentiment; count: number }>(),
    env.DB.prepare(
      `SELECT article_hash, source_name, theme, title, sentiment, updated_at
       FROM article_feedback
       ORDER BY updated_at DESC
       LIMIT 20`,
    ).all(),
  ]);

  return json({
    summary: summary.results,
    by_theme: byTheme.results,
    recent: recent.results,
  });
}
