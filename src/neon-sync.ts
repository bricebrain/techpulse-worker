/**
 * Database sync — mirrors articles from D1 to PostgreSQL (Neon).
 *
 * Uses @neondatabase/serverless (HTTP-based, works in Workers).
 *
 * Setup:
 *   wrangler secret put DATABASE_URL  (or NEON_DATABASE_URL)
 */

import { neon } from '@neondatabase/serverless';
import type { Article, Env } from './types';

function generateId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function mapSourceType(workerTheme: string): string {
  const map: Record<string, string> = {
    'rss': 'rss',
    'hackernews_rss': 'hackernews',
    'reddit_rss': 'reddit',
    'youtube_channel': 'youtube',
    'youtube': 'youtube',
    'arxiv': 'arxiv',
    'grok_live': 'grok',
    'devto_tag': 'rss',
    'general': 'rss',
    'business': 'rss',
    'finance': 'rss',
    'ai': 'rss',
  };
  return map[workerTheme] || 'rss';
}

/**
 * Sync a batch of articles to Neon in a SINGLE transaction (1 HTTP call).
 */
export async function syncToNeon(
  articles: Article[],
  _sourceType: string,
  env: Env,
): Promise<number> {
  const connStr = env.DATABASE_URL ?? env.NEON_DATABASE_URL;
  if (!connStr || articles.length === 0) {
    return 0;
  }

  const valid = articles.filter((a) => a.url && a.url.length > 0);
  if (valid.length === 0) return 0;

  const sql = neon(connStr, { arrayMode: false, fullResults: false });

  try {
    // Build all insert statements for a single transaction
    const txStatements = valid.map((article) => {
      const id = generateId();
      const sourceType = mapSourceType(article.theme || 'general');
      const description = (article.content || '').slice(0, 500);
      const publishedAt = article.published_at
        ? new Date(article.published_at).toISOString()
        : null;

      return sql`
        INSERT INTO articles (id, title, url, source_name, source_type, description, published_at, fetched_at, status)
        VALUES (${id}, ${article.title}, ${article.url!}, ${article.source_name}, ${sourceType}, ${description}, ${publishedAt}::timestamptz, NOW(), 'new')
        ON CONFLICT (url) DO NOTHING
      `;
    });

    await sql.transaction(txStatements);

    console.log(`[DB] Synced ${valid.length} articles in 1 transaction`);
    return valid.length;
  } catch (e) {
    console.warn(`[DB] Batch sync failed: ${e}`);
    return 0;
  }
}
