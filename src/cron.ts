import type { Env, Source, Article } from './types';
import { fetchRss } from './fetchers/rss';
import { fetchReddit } from './fetchers/reddit';
import { fetchYoutube, pickYoutubeKey } from './fetchers/youtube';
import { classifyAndStore } from './classifier';

const ARTICLE_TTL_DAYS = 7;

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

// ─── Traduction française + résumé narratif (Gemini Flash batch) ─────────────

interface FrenchContent { title_fr: string; summary_fr: string }

function buildTranslationPrompt(articles: { hash: string; title: string; content: string | null }[]): string {
  const input = articles.map((a) => ({
    hash: a.hash,
    title: a.title,
    excerpt: (a.content ?? '').slice(0, 200),
  }));
  return `Tu es journaliste tech francophone. Pour chaque article JSON ci-dessous, génère :
- "title_fr" : titre traduit en français, concis et fidèle
- "summary_fr" : exactement 3 phrases narratives en français, style commentateur radio matinal, sans bullet, sans markdown, sans guillemets autour des phrases

Articles : ${JSON.stringify(input)}

Réponds UNIQUEMENT avec un tableau JSON valide (aucun texte avant ou après) :
[{"hash":"...","title_fr":"...","summary_fr":"..."},...]`;
}

function parseFrenchResults(text: string): Array<{ hash: string; title_fr: string; summary_fr: string }> {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return (JSON.parse(match[0]) as Array<{ hash?: string; title_fr?: string; summary_fr?: string }>)
      .filter((i): i is { hash: string; title_fr: string; summary_fr: string } =>
        Boolean(i.hash && i.title_fr && i.summary_fr));
  } catch { return []; }
}

/** Appel Gemini Flash 2.0 (primaire) */
async function callGemini(prompt: string, apiKey: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
        }),
        signal: controller.signal,
      },
    ).finally(() => clearTimeout(timer));
    if (!res.ok) { console.warn(`[FR] Gemini ${res.status}`); return null; }
    const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch (e) { console.warn('[FR] Gemini error:', e); return null; }
}

/** Fallback DeepSeek (OpenAI-compatible) quand Gemini est en 429/quota */
async function callDeepSeek(prompt: string, apiKey: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) { console.warn(`[FR] DeepSeek ${res.status}`); return null; }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    return data?.choices?.[0]?.message?.content ?? null;
  } catch (e) { console.warn('[FR] DeepSeek error:', e); return null; }
}

async function generateFrenchBatch(
  articles: { hash: string; title: string; content: string | null }[],
  env: Env,
): Promise<Map<string, FrenchContent>> {
  const results = new Map<string, FrenchContent>();
  if (!articles.length) return results;

  const prompt = buildTranslationPrompt(articles);

  // Primaire : Gemini Flash 2.0
  let text: string | null = null;
  if (env.GEMINI_API_KEY) {
    text = await callGemini(prompt, env.GEMINI_API_KEY);
  }

  // Fallback : DeepSeek (quota indépendant de Gemini)
  if (!text && env.DEEPSEEK_API_KEY) {
    console.log('[FR] Gemini indispo → fallback DeepSeek');
    text = await callDeepSeek(prompt, env.DEEPSEEK_API_KEY);
  }

  if (!text) { console.warn('[FR] Aucun provider disponible'); return results; }

  const parsed = parseFrenchResults(text);
  if (!parsed.length) { console.warn('[FR] Réponse non parsable:', text.slice(0, 200)); return results; }

  for (const item of parsed) {
    results.set(item.hash, { title_fr: item.title_fr, summary_fr: item.summary_fr });
  }
  console.log(`[FR] ${results.size}/${articles.length} articles traduits`);
  return results;
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
    'SELECT * FROM sources WHERE is_active = 1'
  ).all<Source>();

  // 2. Fetch parallèle par chunks de 10
  const chunks = chunkArray(sources, 10);
  const allArticles: Article[] = [];
  for (const chunk of chunks) {
    const results = await Promise.allSettled(chunk.map((s) => fetchSource(s, env)));
    for (const r of results) {
      if (r.status === 'fulfilled') allArticles.push(...r.value);
      else console.warn('[Cron/Fetch] Source échouée:', r.reason);
    }
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

async function dispatchPushAlerts(newArticles: Article[], env: Env): Promise<void> {
  const { results: devices } = await env.DB.prepare(
    'SELECT token, keywords FROM devices'
  ).all<{ token: string; keywords: string }>();

  if (!devices.length) return;

  interface PushMessage { to: string; title: string; body: string; data: Record<string, string>; channelId: string }
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

  // Expo Push API — gratuit, gère iOS (APNs) + Android (FCM) automatiquement
  const batches = chunkArray(messages, 100);
  for (const batch of batches) {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => console.warn('[Push] Erreur envoi:', e));
  }

  console.log(`[Push] ${messages.length} notifications envoyées`);
}

/**
 * Cron enrichissement — toutes les 2h.
 * Traduction FR (Gemini Flash) + classification (Workers AI).
 * Les opérations coûteuses sont ici, pas dans le fetch rapide.
 */
export async function runCronEnrich(env: Env): Promise<void> {
  console.log('[Cron/Enrich] Démarrage…');

  // 1. Traduction française + résumé narratif
  if (env.GEMINI_API_KEY) {
    // LIMIT 20 = 2 appels Gemini (batch=10) par run → reste sous les rate limits
    // Les articles restants sont traduits lors des prochains runs (toutes les 2h)
    const { results: untranslated } = await env.DB.prepare(
      `SELECT hash, title, content FROM articles WHERE title_fr IS NULL ORDER BY fetched_at DESC LIMIT 20`,
    ).all<{ hash: string; title: string; content: string | null }>();

    if (untranslated.length > 0) {
      console.log(`[Cron/Enrich] Traduction FR : ${untranslated.length} articles`);
      const FR_BATCH = 10; // batch réduit pour respecter les rate limits Gemini
      let totalUpdated = 0;
      for (let i = 0; i < untranslated.length; i += FR_BATCH) {
        if (i > 0) await new Promise((r) => setTimeout(r, 4_000)); // 4s entre batches
        const frMap = await generateFrenchBatch(untranslated.slice(i, i + FR_BATCH), env);
        if (frMap.size > 0) {
          const stmts = Array.from(frMap.entries()).map(([hash, fr]) =>
            env.DB.prepare('UPDATE articles SET title_fr = ?, summary_fr = ? WHERE hash = ?')
              .bind(fr.title_fr, fr.summary_fr, hash),
          );
          await env.DB.batch(stmts);
          totalUpdated += frMap.size;
        }
      }
      console.log(`[Cron/Enrich] ${totalUpdated}/${untranslated.length} traduits (FR)`);
    }
  }

  // 2. Classification Workers AI (articles récents sans classified_theme)
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
