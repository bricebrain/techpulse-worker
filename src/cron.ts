import type { Env, Source, Article } from './types';
import { fetchRss } from './fetchers/rss';
import { fetchReddit } from './fetchers/reddit';
import { fetchYoutube, pickYoutubeKey } from './fetchers/youtube';
import { classifyAndStore } from './classifier';

const ARTICLE_TTL_DAYS = 7;

// ─── Déduplication par similarité de titre ───────────────────────────────────
// Jaccard sur les mots significatifs : si ≥ 45 % des mots se recoupent
// → même sujet traité par une autre source → on ignore.

const STOPWORDS = new Set([
  // Anglais
  'the','a','an','in','on','at','to','for','of','and','or','is','are','was',
  'were','it','its','with','from','by','about','that','this','new','first',
  'how','why','what','when','where','will','can','has','have','been','after',
  'into','up','out','as','be','but','not','so','do','did','get','got','they',
  'we','our','you','he','she','his','her','their','more','just','over','than',
  'now','all','one','two','three','could','would','should','which','while',
  // Français
  'le','la','les','un','une','des','du','de','en','et','est','que','qui',
  'il','elle','ils','elles','dans','sur','pour','par','avec','au','aux',
  'ce','cette','ces','je','me','ma','mon','mes','se','son','sa','ses','lui',
  'leur','leurs','ne','pas','plus','très','bien','tout','tous','toute',
  'après','avant','même','aussi','comme','mais','ou','donc','car','si',
]);

const DEDUP_THRESHOLD = 0.45;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

function titleToWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Filtre les doublons near-sémantiques d'un lot d'articles.
 * `existingTitles` = titres déjà en base (dernières 24h).
 * Retourne les articles uniques + le nombre de doublons éliminés.
 */
function deduplicateArticles(
  articles: Article[],
  existingTitles: string[],
): { unique: Article[]; skipped: number } {
  const seen: Set<string>[] = existingTitles.map(titleToWords);
  const unique: Article[] = [];
  let skipped = 0;

  for (const article of articles) {
    const words = titleToWords(article.title);
    const isDup = seen.some((s) => jaccard(words, s) >= DEDUP_THRESHOLD);
    if (isDup) {
      skipped++;
      console.log(`[Dédup] Ignoré (doublon) : "${article.title.slice(0, 70)}"`);
    } else {
      unique.push(article);
      seen.push(words);
    }
  }

  return { unique, skipped };
}

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

  // 3. Déduplication : on compare les titres avec les articles des 24 dernières heures
  const dedupCutoff = Date.now() - DEDUP_WINDOW_MS;
  const { results: recentTitles } = await env.DB.prepare(
    'SELECT title FROM articles WHERE fetched_at > ?'
  ).bind(dedupCutoff).all<{ title: string }>();

  const { unique: articlesToStore, skipped } = deduplicateArticles(
    allArticles,
    recentTitles.map((r) => r.title),
  );
  console.log(`[Cron] Dédup : ${allArticles.length} → ${articlesToStore.length} articles (${skipped} doublons éliminés)`);

  // 4. Upsert dans D1 par batch de 50
  const articleChunks = chunkArray(articlesToStore, 50);
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

  // 5. Classification Workers AI
  // - YouTube : tous les articles (thème source = 'youtube', contenu varié)
  // - Autres  : seulement les nouveaux articles sans classified_theme
  const youtubeArticles = articlesToStore.filter((a) => a.theme === 'youtube');
  const otherNew = articlesToStore.filter((a) => a.theme !== 'youtube');

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

  // 6. Nettoyer les articles trop vieux
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
      return fetchReddit(source, env);

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
