import type { Env } from './types';
import { err, json } from './utils';

type ArticleFeedbackSentiment = 'interesting' | 'neutral' | 'not_interesting';

const VALID_SENTIMENTS = new Set<ArticleFeedbackSentiment>([
  'interesting',
  'neutral',
  'not_interesting',
]);

async function ensureArticleFeedbackTable(env: Env): Promise<void> {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS article_feedback (
      article_hash TEXT PRIMARY KEY,
      source_name  TEXT NOT NULL,
      theme        TEXT,
      title        TEXT NOT NULL,
      sentiment    TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_article_feedback_sentiment ON article_feedback(sentiment);
    CREATE INDEX IF NOT EXISTS idx_article_feedback_theme ON article_feedback(theme);
    CREATE INDEX IF NOT EXISTS idx_article_feedback_updated_at ON article_feedback(updated_at);
  `);
}

function cleanText(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
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
