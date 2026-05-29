import type { Env, Source, Article } from './types';
import { fetchRss } from './fetchers/rss';
import { fetchReddit } from './fetchers/reddit';
import { fetchYoutube, pickYoutubeKey } from './fetchers/youtube';
import { classifyAndStore } from './classifier';

const ARTICLE_TTL_DAYS = 7;

export async function runCron(env: Env): Promise<void> {
  console.log('[Cron] Démarrage du fetch de veille…');

  // 1. Charger les sources actives
  const { results: sources } = await env.DB.prepare(
    'SELECT * FROM sources WHERE is_active = 1'
  ).all<Source>();

  console.log(`[Cron] ${sources.length} sources actives`);

  // 2. Fetch en parallèle (max 10 à la fois pour éviter les timeouts)
  const chunks = chunkArray(sources, 10);
  const allArticles: Article[] = [];

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map((source) => fetchSource(source, env))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allArticles.push(...r.value);
      else console.warn('[Cron] Source échouée:', r.reason);
    }
  }

  console.log(`[Cron] ${allArticles.length} articles récupérés`);

  // 3. Upsert dans D1 par batch de 50
  const articleChunks = chunkArray(allArticles, 50);
  for (const batch of articleChunks) {
    const stmts = batch.map((a) =>
      env.DB.prepare(
        `INSERT INTO articles (hash, theme, title, source_name, url, content, published_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           content    = excluded.content`
      ).bind(a.hash, a.theme, a.title, a.source_name, a.url, a.content, a.published_at, a.fetched_at)
    );
    await env.DB.batch(stmts);
  }

  // 4. Classification Workers AI
  // - YouTube : tous les articles (thème source = 'youtube', contenu varié)
  // - Autres  : seulement les nouveaux articles sans classified_theme
  const youtubeArticles = allArticles.filter((a) => a.theme === 'youtube');
  const otherNew = allArticles.filter((a) => a.theme !== 'youtube');

  // YouTube en priorité (classification complète)
  if (youtubeArticles.length > 0) {
    console.log(`[Cron] Classification YouTube : ${youtubeArticles.length} articles`);
    await classifyAndStore(env, youtubeArticles);
  }

  // Autres articles : on classifie pour vérification croisée (utile pour détection hors-thème)
  if (otherNew.length > 0) {
    console.log(`[Cron] Classification autres sources : ${otherNew.length} articles`);
    await classifyAndStore(env, otherNew);
  }

  // 5. Nettoyer les articles trop vieux
  const cutoff = Date.now() - ARTICLE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const { meta } = await env.DB.prepare(
    'DELETE FROM articles WHERE fetched_at < ?'
  ).bind(cutoff).run();

  console.log(`[Cron] Nettoyage : ${meta.changes} articles supprimés`);
  console.log('[Cron] Terminé ✓');
}

/**
 * Fetche une seule source, upsert ses articles et les classifie.
 * Utilisé par POST /sources pour éviter d'attendre le prochain cron.
 */
export async function fetchAndStoreSource(source: Source, env: Env): Promise<void> {
  try {
    const articles = await fetchSource(source, env);
    if (!articles.length) return;

    const stmts = articles.map((a) =>
      env.DB.prepare(
        `INSERT INTO articles (hash, theme, title, source_name, url, content, published_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET fetched_at = excluded.fetched_at, content = excluded.content`
      ).bind(a.hash, a.theme, a.title, a.source_name, a.url, a.content, a.published_at, a.fetched_at)
    );
    await env.DB.batch(stmts);
    await classifyAndStore(env, articles);

    console.log(`[Source] ${source.name} : ${articles.length} articles fetchés et classifiés`);
  } catch (e) {
    console.warn(`[Source] Erreur fetch ${source.name}:`, e);
  }
}

async function fetchSource(source: Source, env: Env): Promise<Article[]> {
  switch (source.type) {
    case 'rss':
    case 'hackernews_rss':
    case 'arxiv':
      return fetchRss(source);

    case 'reddit_rss':
      return fetchReddit(source);

    case 'youtube_channel':
      return fetchYoutube(
        source,
        pickYoutubeKey(env.YOUTUBE_API_KEY_1, env.YOUTUBE_API_KEY_2, env.YOUTUBE_API_KEY_3),
      );

    case 'devto_tag':
      return fetchRss({
        ...source,
        value: `https://dev.to/feed/tag/${source.value}`,
      });

    default:
      console.warn(`[Cron] Type non géré : ${source.type}`);
      return [];
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
