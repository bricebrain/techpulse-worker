import type { Env, Source, Article } from './types';
import { fetchRss } from './fetchers/rss';
import { fetchReddit } from './fetchers/reddit';
import { fetchYoutube, pickYoutubeKey } from './fetchers/youtube';
import { fetchGrokLive } from './fetchers/grok';
// Neon sync removed — handled by GitHub Actions ingest pipeline
// which reads from Worker API and writes to Neon directly.
import { classifyAndStore } from './classifier';

const ARTICLE_TTL_DAYS = 7;
const MAX_SOURCES_PER_FETCH_CRON = 28;

// ─── Déduplication sémantique (Workers AI) + fallback Jaccard ────────────────
// Embeddings @cf/baai/bge-base-en-v1.5 → cosine ≥ 0.88 = même histoire.
// Fallback sur Jaccard (mots significatifs ≥ 45 %) si l'API AI échoue.

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
 * Fallback Jaccard : filtre les doublons par overlap de mots significatifs.
 * Utilisé si l'API embeddings est indisponible.
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
      console.log(`[Dédup/Jaccard] Ignoré : "${article.title.slice(0, 70)}"`);
    } else {
      unique.push(article);
      seen.push(words);
    }
  }

  return { unique, skipped };
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    ma  += a[i]! * a[i]!;
    mb  += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom === 0 ? 0 : dot / denom;
}

async function getEmbeddingsBatch(texts: string[], env: Env): Promise<number[][] | null> {
  try {
    const result = await (env.AI.run as Function)('@cf/baai/bge-base-en-v1.5', { text: texts });
    return (result as { data: number[][] }).data;
  } catch (e) {
    console.warn('[Dédup] Erreur embeddings batch:', e);
    return null;
  }
}

/**
 * Déduplication sémantique via Workers AI embeddings.
 * Cosine ≥ 0.88 = même histoire couverte par plusieurs sources → ignoré.
 * Fallback automatique sur Jaccard si l'API AI échoue.
 */
async function deduplicateWithEmbeddings(
  newArticles: Article[],
  existingTitles: string[],
  env: Env,
): Promise<{ unique: Article[]; skipped: number }> {
  if (newArticles.length === 0) return { unique: [], skipped: 0 };

  const THRESHOLD = 0.88;
  const BATCH_SIZE = 100;
  const MAX_EXISTING = 150; // cap pour ne pas exploser les coûts

  const recentExisting = existingTitles.slice(0, MAX_EXISTING);
  const newTitles = newArticles.map((a) => a.title);

  // Embeddings des titres existants (par batches)
  const existingEmbs: number[][] = [];
  for (let i = 0; i < recentExisting.length; i += BATCH_SIZE) {
    const batch = recentExisting.slice(i, i + BATCH_SIZE);
    const embs = await getEmbeddingsBatch(batch, env);
    if (embs === null) {
      console.warn('[Dédup] Fallback Jaccard (erreur embeddings existants)');
      return deduplicateArticles(newArticles, existingTitles);
    }
    existingEmbs.push(...embs);
  }

  // Embeddings des nouveaux articles (par batches)
  const newEmbs: number[][] = [];
  for (let i = 0; i < newTitles.length; i += BATCH_SIZE) {
    const batch = newTitles.slice(i, i + BATCH_SIZE);
    const embs = await getEmbeddingsBatch(batch, env);
    if (embs === null) {
      console.warn('[Dédup] Fallback Jaccard (erreur embeddings nouveaux)');
      return deduplicateArticles(newArticles, existingTitles);
    }
    newEmbs.push(...embs);
  }

  // Comparaison : chaque nouvel article vs existants + nouveaux déjà acceptés
  const keptEmbs: number[][] = [...existingEmbs];
  const unique: Article[] = [];
  let skipped = 0;

  for (let i = 0; i < newArticles.length; i++) {
    const emb = newEmbs[i]!;
    const isDup = keptEmbs.some((e) => cosine(emb, e) >= THRESHOLD);
    if (isDup) {
      skipped++;
      console.log(`[Dédup/AI] Doublon sémantique : "${newArticles[i]!.title.slice(0, 70)}"`);
    } else {
      unique.push(newArticles[i]!);
      keptEmbs.push(emb);
    }
  }

  return { unique, skipped };
}

/**
 * Cron rapide — toutes les 30 min.
 * Fetch + dédup sémantique + upsert D1 + nettoyage TTL.
 * Pas de Gemini, pas de classification → coût quasi nul.
 */
export async function runCronFetch(env: Env): Promise<void> {
  console.log('[Cron/Fetch] Démarrage…');

  // 1. Sources actives
  const { results: sources } = await env.DB.prepare(
    `SELECT * FROM sources
     WHERE is_active = 1
     ORDER BY datetime(COALESCE(updated_at, created_at)) ASC, name ASC
     LIMIT ?`
  ).bind(MAX_SOURCES_PER_FETCH_CRON).all<Source>();

  console.log(`[Cron/Fetch] Sources sélectionnées : ${sources.length}/${MAX_SOURCES_PER_FETCH_CRON}`);

  // 2. Fetch parallèle par chunks de 10
  const chunks = chunkArray(sources, 10);
  const allArticles: Article[] = [];
  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (source) => ({ source, articles: await fetchSource(source, env) })),
    );
    const fetchedAt = new Date().toISOString();
    const sourceUpdates: D1PreparedStatement[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        allArticles.push(...r.value.articles);
        sourceUpdates.push(
          env.DB.prepare('UPDATE sources SET updated_at = ? WHERE id = ?').bind(fetchedAt, r.value.source.id),
        );
      } else {
        console.warn('[Cron/Fetch] Source échouée:', r.reason);
      }
    }
    if (sourceUpdates.length > 0) await env.DB.batch(sourceUpdates);
  }
  console.log(`[Cron/Fetch] ${allArticles.length} articles récupérés`);

  // 3. Déduplication sémantique (Workers AI — gratuit)
  const dedupCutoff = Date.now() - DEDUP_WINDOW_MS;
  const { results: recentTitles } = await env.DB.prepare(
    'SELECT title FROM articles WHERE fetched_at > ? ORDER BY fetched_at DESC LIMIT 150'
  ).bind(dedupCutoff).all<{ title: string }>();

  const { unique: articlesToStore, skipped } = await deduplicateWithEmbeddings(
    allArticles,
    recentTitles.map((r) => r.title),
    env,
  );
  console.log(`[Cron/Fetch] Dédup : ${allArticles.length} → ${articlesToStore.length} (${skipped} doublons)`);

  // 4. Upsert D1
  const articleChunks = chunkArray(articlesToStore, 50);
  for (const batch of articleChunks) {
    const stmts = batch.map((a) =>
      env.DB.prepare(
        `INSERT INTO articles (hash, theme, title, source_name, url, content, published_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET fetched_at = excluded.fetched_at, content = excluded.content`
      ).bind(a.hash, a.theme, a.title, a.source_name, a.url, a.content, a.published_at, a.fetched_at)
    );
    await env.DB.batch(stmts);
  }

  // 5. Notifications push pour les alertes par mots-clés
  if (articlesToStore.length > 0) {
    await dispatchPushAlerts(articlesToStore, env);
  }

  // 6. Nettoyage TTL
  const cutoff = Date.now() - ARTICLE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const { meta } = await env.DB.prepare('DELETE FROM articles WHERE fetched_at < ?').bind(cutoff).run();

  console.log(`[Cron/Fetch] Nettoyage : ${meta.changes} supprimés. Terminé ✓`);
}

// ─── Dispatch push notifications ─────────────────────────────────────────────

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  channelId: string;
}

async function sendExpoPushMessages(messages: PushMessage[]): Promise<unknown[]> {
  if (!messages.length) return [];

  const batches = chunkArray(messages, 100);
  const responses: unknown[] = [];

  for (const batch of batches) {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000),
      });

      const body = await res.json().catch(() => null);
      responses.push({
        ok: res.ok,
        status: res.status,
        body,
      });
    } catch (e) {
      console.warn('[Push] Erreur envoi:', e);
      responses.push({
        ok: false,
        status: 0,
        error: e instanceof Error ? e.message : 'unknown_error',
      });
    }
  }

  return responses;
}

export async function sendTestPushAlert(
  token: string,
  input?: {
    title?: string;
    body?: string;
    data?: Record<string, string>;
  },
): Promise<unknown[]> {
  const message: PushMessage = {
    to: token,
    title: input?.title?.trim() || 'TechPulse test',
    body: input?.body?.trim() || 'Notification de test envoyée depuis le Worker.',
    data: input?.data ?? { theme: 'ai', hash: 'push-test' },
    channelId: 'alerts',
  };

  return sendExpoPushMessages([message]);
}

async function dispatchPushAlerts(newArticles: Article[], env: Env): Promise<void> {
  const { results: devices } = await env.DB.prepare(
    'SELECT token, keywords FROM devices'
  ).all<{ token: string; keywords: string }>();

  if (!devices.length) return;

  const messages: PushMessage[] = [];

  for (const device of devices) {
    let keywords: string[] = [];
    try { keywords = JSON.parse(device.keywords); } catch { continue; }
    if (!keywords.length) continue;

    // Un seul article par device par run (le premier qui matche)
    for (const article of newArticles) {
      const haystack = `${article.title} ${article.content ?? ''}`.toLowerCase();
      const matched = keywords.find((kw) => haystack.includes(kw));
      if (matched) {
        messages.push({
          to: device.token,
          title: `🔔 ${matched.charAt(0).toUpperCase() + matched.slice(1)}`,
          body: article.title,
          data: { hash: article.hash, theme: article.theme },
          channelId: 'alerts',
        });
        break; // une notif max par device par cron
      }
    }
  }

  if (!messages.length) return;

  await sendExpoPushMessages(messages);
  console.log(`[Push] ${messages.length} notifications envoyées`);
}

/**
 * Cron enrichissement — toutes les 2h.
 * Classification et enrichissements légers côté feed.
 * Les analyses profondes restent à la demande côté app.
 */
export async function runCronEnrich(env: Env): Promise<void> {
  console.log('[Cron/Enrich] Démarrage…');

  // 1. Classification Workers AI (articles récents sans classified_theme)
  const recent = Date.now() - 2 * 60 * 60 * 1000; // fenêtre 2h (aligne sur le cron)
  const { results: toClassify } = await env.DB.prepare(
    `SELECT hash, theme, title, source_name, url, content, published_at, fetched_at
     FROM articles WHERE classified_theme IS NULL AND fetched_at > ?`
  ).bind(recent).all<Article>();

  if (toClassify.length > 0) {
    console.log(`[Cron/Enrich] Classification : ${toClassify.length} articles`);
    const youtube = toClassify.filter((a) => a.theme === 'youtube');
    const others  = toClassify.filter((a) => a.theme !== 'youtube');
    if (youtube.length > 0) await classifyAndStore(env, youtube);
    if (others.length  > 0) await classifyAndStore(env, others);
  }

  console.log('[Cron/Enrich] Terminé ✓');
}

/** @deprecated Utiliser runCronFetch + runCronEnrich séparément */
export async function runCron(env: Env): Promise<void> {
  await runCronFetch(env);
  await runCronEnrich(env);
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

    case 'grok_live':
      return fetchGrokLive(source, env);

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
