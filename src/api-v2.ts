import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

type Sql = NeonQueryFunction<false, false>;
import {
  asArray,
  normalizeAnalysis,
  normalizeArticle,
  normalizeArticleDetail,
  normalizeArticleIntelligence,
  normalizeCluster,
  normalizeEntity,
  parseNumber,
  toIso,
} from './api-v2-mappers';
import type {
  AnalysisRow,
  ArticleDetailRow,
  ArticleIntelligenceRow,
  ArticleRow,
  ClusterRow,
  EntityRow,
  FeedClusterRow,
  TimelineEventRow,
} from './api-v2-types';
import type { Env } from './types';
import { getArticleFeedbackPreferenceProfile, scorePreferenceAdjustment } from './feedback';
import { err, json } from './utils';

type PersonalizedFeedCluster = Record<string, unknown> & {
  score: number;
  last_updated_at?: unknown;
};

function ageHours(value: unknown): number {
  if (typeof value !== 'string') return Infinity;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return Infinity;
  return Math.max(0, (Date.now() - timestamp) / 3_600_000);
}

function scoreFreshnessAdjustment(input: {
  firstSeenAt: unknown;
  lastUpdatedAt: unknown;
  growthScore: number;
  noveltyScore: number;
  articleCount: number;
}): { delta: number; label: 'fresh' | 'developing' | 'fatigue' | 'stale'; reasons: string[] } {
  const topicAge = ageHours(input.firstSeenAt);
  const updateAge = ageHours(input.lastUpdatedAt);
  const reasons: string[] = [];
  let delta = 0;

  if (topicAge <= 36) {
    return { delta: 10, label: 'fresh', reasons: ['fresh_topic'] };
  }

  if (topicAge > 48) {
    delta -= 10;
    reasons.push('older_than_48h');
  }
  if (topicAge > 96) {
    delta -= 18;
    reasons.push('older_than_4d');
  }
  if (topicAge > 168) {
    delta -= 22;
    reasons.push('older_than_7d');
  }
  if (input.articleCount >= 8 && topicAge > 96) {
    delta -= 10;
    reasons.push('large_recurrent_story');
  }
  if (input.noveltyScore < 4 && topicAge > 72) {
    delta -= 10;
    reasons.push('low_novelty');
  }

  const isStillMoving = updateAge <= 18 && input.growthScore >= 12;
  if (isStillMoving) {
    delta += Math.min(18, Math.abs(delta) * 0.5);
    reasons.push('still_moving');
  }

  const label = topicAge > 168
    ? 'stale'
    : delta <= -20
      ? 'fatigue'
      : 'developing';

  return {
    delta: Math.max(-55, Math.min(12, Math.round(delta))),
    label,
    reasons,
  };
}

function capScoreByFreshness(score: number, freshnessLabel: 'fresh' | 'developing' | 'fatigue' | 'stale'): number {
  if (freshnessLabel === 'stale') return Math.min(score, 82);
  if (freshnessLabel === 'fatigue') return Math.min(score, 104);
  return score;
}

function capScoreByTopicSaturation(score: number, adjustment: number): number {
  if (adjustment <= -32) return Math.min(score, 116);
  if (adjustment <= -20) return Math.min(score, 124);
  return score;
}

function topicBucket(cluster: PersonalizedFeedCluster): string {
  const title = typeof cluster.title === 'string' ? cluster.title.toLowerCase() : '';
  const summary = typeof cluster.summary === 'string' ? cluster.summary.toLowerCase() : '';
  const text = `${title} ${summary}`;
  if (/\b(spacex|elon|tesla|xai|starship)\b/.test(text)) return 'musk-space';
  if (/\b(openai|anthropic|claude|chatgpt|gpt-)\b/.test(text)) return 'frontier-ai';
  if (/\b(iran|oil|opec|israel|middle east)\b/.test(text)) return 'geopolitics-energy';
  if (/\b(android|google|wear os)\b/.test(text)) return 'google-android';
  if (/\b(nvidia|gpu|semiconductor|chip|qualcomm|tsmc)\b/.test(text)) return 'chips';
  return typeof cluster.main_theme === 'string' ? cluster.main_theme : 'general';
}

// ─── MMR (Maximal Marginal Relevance) + quotas par domaine ───────────────────
// Implémente la stratégie décrite dans vison.txt :
// 1. Sélection itérative qui maximise λ×pertinence − (1−λ)×similarité_max
// 2. Quotas par domaine (éviter qu'un domaine domine)
// 3. 2e passe souple pour combler les slots restants

const MMR_LAMBDA = 0.7; // 70% pertinence, 30% diversité
const DOMAIN_QUOTA = 4; // max 4 clusters par domaine dans le feed
const PROTECTED_WINDOW = 8; // fenêtre initiale stricte

function clusterKeywords(cluster: PersonalizedFeedCluster): Set<string> {
  const text = [
    typeof cluster.title === 'string' ? cluster.title : '',
    typeof cluster.summary === 'string' ? cluster.summary : '',
    typeof cluster.main_theme === 'string' ? cluster.main_theme : '',
  ].join(' ').toLowerCase();

  // Extraire les mots significatifs (≥4 chars, sans stopwords)
  const stop = new Set(['the', 'this', 'that', 'with', 'from', 'have', 'they', 'will',
    'about', 'after', 'into', 'your', 'their', 'what', 'when', 'where',
    'more', 'than', 'only', 'also', 'been', 'were', 'some', 'very',
    'pour', 'avec', 'dans', 'pour', 'sont', 'une', 'des', 'les', 'sur']);

  return new Set(
    text.match(/[a-zà-ÿ]{4,}/g)?.filter((w) => !stop.has(w)) ?? [],
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function clusterDomain(cluster: PersonalizedFeedCluster): string {
  return topicBucket(cluster);
}

/**
 * MMR : sélection itérative qui équilibre pertinence et diversité.
 * À chaque étape, on choisit le cluster qui maximise :
 *   λ × score_normalisé − (1−λ) × similarité_max_avec_les_sélectionnés
 */
function selectWithMMR(
  candidates: PersonalizedFeedCluster[],
  limit: number,
): PersonalizedFeedCluster[] {
  if (candidates.length <= limit) return candidates;

  // Normaliser les scores sur [0, 1]
  const scores = candidates.map((c) => parseNumber(c.score));
  const maxScore = Math.max(...scores, 1);
  const minScore = Math.min(...scores, 0);
  const scoreRange = maxScore - minScore || 1;

  // Précalculer les keywords pour chaque cluster
  const keywords = candidates.map((c) => clusterKeywords(c));

  const selected: number[] = [];
  const selectedKeywords: Set<string>[] = [];
  const domainCounts: Record<string, number> = {};
  const deferred: number[] = [];

  while (selected.length < limit && (selected.length + deferred.length < candidates.length)) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      if (selected.includes(i)) continue;

      const domain = clusterDomain(candidates[i]!);

      // Quota par domaine : skip si déjà atteint dans la fenêtre protégée
      if (selected.length < PROTECTED_WINDOW && (domainCounts[domain] ?? 0) >= DOMAIN_QUOTA) {
        if (!deferred.includes(i)) deferred.push(i);
        continue;
      }

      // Pertinence normalisée [0, 1]
      const relevance = (scores[i]! - minScore) / scoreRange;

      // Similarité max avec les clusters déjà sélectionnés
      let maxSim = 0;
      for (const sk of selectedKeywords) {
        const sim = jaccardSimilarity(keywords[i]!, sk);
        if (sim > maxSim) maxSim = sim;
      }

      // Score MMR
      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;

      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      // Tous les candidats restants sont deferred (quota atteint)
      // 2e passe souple : relâcher les quotas pour combler
      for (const i of deferred) {
        if (selected.length >= limit) break;
        const domain = clusterDomain(candidates[i]!);
        if ((domainCounts[domain] ?? 0) >= DOMAIN_QUOTA + 2) continue; // limite absolue
        selected.push(i);
        selectedKeywords.push(keywords[i]!);
        domainCounts[domain] = (domainCounts[domain] ?? 0) + 1;
      }
      break;
    }

    selected.push(bestIdx);
    selectedKeywords.push(keywords[bestIdx]!);
    domainCounts[clusterDomain(candidates[bestIdx]!)] =
      (domainCounts[clusterDomain(candidates[bestIdx]!)] ?? 0) + 1;
  }

  return selected.map((i) => candidates[i]!);
}

function applyTopicSaturation(clusters: PersonalizedFeedCluster[]): PersonalizedFeedCluster[] {
  const bucketCounts = clusters.reduce<Record<string, number>>((counts, cluster) => {
    const bucket = topicBucket(cluster);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    return counts;
  }, {});

  const seenByBucket: Record<string, number> = {};
  return clusters.map((cluster) => {
    const bucket = topicBucket(cluster);
    const count = bucketCounts[bucket] ?? 0;
    const seen = seenByBucket[bucket] ?? 0;
    seenByBucket[bucket] = seen + 1;

    let delta = 0;
    const reasons: string[] = [];
    if (bucket !== 'general' && count >= 4) {
      delta -= Math.min(36, 24 + (count - 4) * 4);
      reasons.push('topic_saturated');
    }
    if (bucket !== 'general' && seen >= 1) {
      delta -= Math.min(30, seen * 12);
      reasons.push('duplicate_topic_in_feed');
    }

    const adjustedScore = capScoreByTopicSaturation(cluster.score + delta, delta);
    const priorFreshnessReasons = Array.isArray(cluster.freshness_reasons)
      ? cluster.freshness_reasons.filter((reason): reason is string => typeof reason === 'string')
      : [];

    return {
      ...cluster,
      score: adjustedScore,
      topic_bucket: bucket,
      topic_saturation_adjustment: delta,
      topic_saturation_count: count,
      freshness_reasons: [...priorFreshnessReasons, ...reasons],
      freshness_label: delta <= -20 && cluster.freshness_label === 'fresh' ? 'developing' : cluster.freshness_label,
    };
  });
}

function getSql(env: Env): Sql | Response {
  const dbUrl = env.DATABASE_URL ?? env.NEON_DATABASE_URL;
  if (!dbUrl) {
    return err('DATABASE_URL non configuré', 503);
  }
  return neon(dbUrl, { arrayMode: false, fullResults: false });
}

async function rows<T>(query: Promise<unknown>): Promise<T[]> {
  return (await query) as T[];
}

function parseLimit(url: URL, defaultValue: number, max: number): number {
  const raw = Number(url.searchParams.get('limit') ?? defaultValue);
  if (!Number.isFinite(raw)) return defaultValue;
  return Math.max(1, Math.min(Math.trunc(raw), max));
}

// ─── D1 Cache (réduit le data transfer Neon) ──────────────────────────────────

const ONE_MIN = 60;
const CACHE_FEED_TTL = 120 * ONE_MIN;      // Les clusters évoluent toutes les 2-6h (pipeline tourne 3x/j) — était 10min, cause majeure d'egress Neon
const CACHE_PREFERENCES_TTL = 10 * ONE_MIN; // Les préférences changent avec les feedbacks
const CACHE_ENTITIES_TTL = 60 * ONE_MIN;    // Les entités changent lentement
const CACHE_SIGNALS_TTL = 30 * ONE_MIN;     // Les signaux émergent rapidement
const CACHE_PODCAST_CANDIDATES_TTL = 15 * ONE_MIN; // Doit rester frais pour proposer les bons sujets
const CACHE_PODCAST_MOMENTS_TTL = 120 * ONE_MIN; // Contenu podcast stable
const CACHE_CONCEPTS_TTL = 120 * ONE_MIN;   // Concepts dynamiques, changent lentement
const CACHE_PREDICTIONS_TTL = 60 * ONE_MIN; // Prédictions, pas urgent
const CACHE_SEARCH_TTL = 5 * ONE_MIN;       // Dépend de la query utilisateur
const CACHE_SERENDIPITY_TTL = 120 * ONE_MIN;// Contenu scientifique stable
const CACHE_CLUSTER_TTL = 30 * ONE_MIN;     // Détail cluster, change modérément
const CACHE_ARTICLE_TTL = 60 * ONE_MIN;     // Détail article, change très peu

const CACHE_TTL: Record<string, number> = {
  '/api/v2/feed': CACHE_FEED_TTL,
  '/api/v2/preferences': CACHE_PREFERENCES_TTL,
  '/api/v2/entities': CACHE_ENTITIES_TTL,
  '/api/v2/signals': CACHE_SIGNALS_TTL,
  '/api/v2/podcast-candidates': CACHE_PODCAST_CANDIDATES_TTL,
  '/api/v2/podcast-moments': CACHE_PODCAST_MOMENTS_TTL,
  '/api/v2/concepts': CACHE_CONCEPTS_TTL,
  '/api/v2/predictions': CACHE_PREDICTIONS_TTL,
  '/api/v2/search': CACHE_SEARCH_TTL,
  '/api/v2/serendipity': CACHE_SERENDIPITY_TTL,
  '/api/v2/cluster/': CACHE_CLUSTER_TTL,
  '/api/v2/article/': CACHE_ARTICLE_TTL,
};

function getCacheTtl(path: string): number {
  // Routes avec préfixe (cluster/, article/, entity/)
  for (const [prefix, ttl] of Object.entries(CACHE_TTL)) {
    if (prefix.endsWith('/') && path.startsWith(prefix)) return ttl;
  }
  return CACHE_TTL[path] ?? 300;
}

function getCacheKey(path: string): string {
  // Pour les routes avec query params, inclure les params principaux dans la clé
  return path.replace(/[^a-zA-Z0-9/_-]/g, '_').slice(0, 200);
}

async function getCachedResponse(env: Env, cacheKey: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT value FROM api_cache WHERE key = ? AND expires_at > ?'
    ).bind(cacheKey, Date.now()).first<{ value: string }>();

    // Nettoyage opportun : supprimer les entrées expirées (~1 fois sur 100)
    if (Math.random() < 0.01) {
      try {
        await env.DB.prepare('DELETE FROM api_cache WHERE expires_at < ?').bind(Date.now()).run();
      } catch { /* best-effort */ }
    }

    return row?.value ?? null;
  } catch {
    // Table n'existe pas encore — créer silencieusement
    try {
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER, created_at INTEGER)'
      ).run();
    } catch { /* ignore */ }
    return null;
  }
}

async function setCachedResponse(env: Env, cacheKey: string, value: string, ttlSec: number): Promise<void> {
  try {
    const expiresAt = Date.now() + ttlSec * 1000;
    await env.DB.prepare(
      'INSERT OR REPLACE INTO api_cache (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).bind(cacheKey, value, expiresAt, Date.now()).run();
  } catch { /* best-effort */ }
}

export async function handleApiV2(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!path.startsWith('/api/v2/')) return null;
  if (req.method !== 'GET') return err('Méthode non autorisée', 405);

  // ─── Vérifier le cache D1 ───
  const cacheKey = getCacheKey(path + url.search);
  const ttl = getCacheTtl(path);

  if (ttl > 0) {
    const cached = await getCachedResponse(env, cacheKey);
    if (cached) {
      // Retourner la réponse cachée avec un header pour le debug
      return new Response(cached, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
        },
      });
    }
  }

  // ─── Pas de cache → lire Neon ───
  const sqlOrResponse = getSql(env);
  if (sqlOrResponse instanceof Response) return sqlOrResponse;
  const sql = sqlOrResponse;

  try {
    let response: Response;

    if (path === '/api/v2/feed') {
      response = await getFeed(sql, env, url);
    } else if (path === '/api/v2/preferences') {
      response = await getPreferences(env);
    } else if (path.startsWith('/api/v2/cluster/')) {
      const id = decodeURIComponent(path.slice('/api/v2/cluster/'.length)).trim();
      if (!id) return err('ID cluster requis');
      response = await getClusterDetail(sql, id);
    } else if (path.startsWith('/api/v2/article/')) {
      const id = decodeURIComponent(path.slice('/api/v2/article/'.length)).trim();
      if (!id) return err('ID article requis');
      response = await getArticleDetail(sql, id);
    } else if (path === '/api/v2/entities') {
      response = await getEntities(sql, url);
    } else if (path === '/api/v2/signals') {
      response = await getSignals(sql, url);
    } else if (path === '/api/v2/podcast-candidates') {
      response = await getPodcastCandidates(sql, url);
    } else if (path === '/api/v2/podcast-moments') {
      response = await getPodcastMoments(sql, url);
    } else if (path === '/api/v2/concepts') {
      response = await getConcepts(sql, url);
    } else if (path === '/api/v2/predictions') {
      response = await getPredictions(sql, url);
    } else if (path === '/api/v2/search') {
      response = await searchNeon(sql, url);
    } else if (path === '/api/v2/serendipity') {
      response = await getSerendipity(sql, env, url);
    } else {
      return err('Route API v2 inconnue', 404);
    }

    // ─── Cacher la réponse si elle est OK ───
    if (response.ok && ttl > 0) {
      try {
        const text = await response.clone().text();
        if (text.length < 500_000) { // Ne pas cacher les très grosses réponses (>500KB)
          await setCachedResponse(env, cacheKey, text, ttl);
        }
      } catch { /* best-effort */ }
    }

    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[api-v2] Database query failed:', msg);
    return err(`Erreur de lecture base de données: ${msg.slice(0, 200)}`, 500);
  }
}

function getPreviewArticleSources(previewArticles: unknown[]): string[] {
  return previewArticles
    .map((article) => {
      if (!article || typeof article !== 'object') return '';
      const source = (article as { source_name?: unknown }).source_name;
      return typeof source === 'string' ? source : '';
    })
    .filter(Boolean);
}

function getPreviewArticleIds(previewArticles: unknown[]): string[] {
  return previewArticles
    .map((article) => {
      if (!article || typeof article !== 'object') return '';
      const id = (article as { id?: unknown }).id;
      return typeof id === 'string' ? id : '';
    })
    .filter(Boolean);
}

async function getPreferences(env: Env): Promise<Response> {
  const profile = await getArticleFeedbackPreferenceProfile(env);
  return json({
    profile,
    source: 'd1',
  });
}

async function getFeed(sql: Sql, env: Env, url: URL): Promise<Response> {
  const limit = parseLimit(url, 30, 100);
  // Capped at 100 (was 240): candidates are re-ranked in JS (preference + freshness
  // adjustments) then sliced to `limit` — fetching 240 full rows to keep ~30 was most
  // of this endpoint's Neon egress. 100 still gives the re-ranker plenty of headroom.
  const candidateLimit = Math.min(100, Math.max(limit * 5, 80));
  const preferenceProfile = await getArticleFeedbackPreferenceProfile(env);
  const result = await rows<FeedClusterRow>(sql`
    SELECT c.id, c.title, c.summary, c.main_theme, c.status,
           c.importance_score, c.growth_score, c.novelty_score,
           (
             SELECT COUNT(DISTINCT a.source_name)
             FROM cluster_articles ca
             JOIN articles a ON a.id = ca.article_id
             WHERE ca.cluster_id = c.id
           ) AS source_diversity,
           c.article_count,
           c.first_seen_at, c.last_updated_at, c.created_at,
           (
             c.importance_score
             + LEAST(c.growth_score, 20) * 2
             + c.novelty_score * 2
             + CASE WHEN c.article_count >= 2 THEN 20 ELSE -15 END
           ) AS score,
           -- Feed cards only ever read preview_articles[0].{category,image_url} (see
           -- HomeClusterCard/ExplorerClusterCard) — fetch just that 1 article, trimmed columns,
           -- instead of 3 full article rows (title_fr/description/url/sentiment were unused here).
           COALESCE((
             SELECT jsonb_agg(article_preview ORDER BY article_preview.published_at DESC NULLS LAST)
              FROM (
                SELECT a.id, a.title, a.source_name, a.image_url, a.category, a.published_at
               FROM cluster_articles ca
               JOIN articles a ON a.id = ca.article_id
               WHERE ca.cluster_id = c.id
               ORDER BY (ca.role = 'primary') DESC, a.published_at DESC NULLS LAST
               LIMIT 1
             ) AS article_preview
           ), '[]'::jsonb) AS preview_articles,
           -- Feed cards only read {summary,key_takeaways[0],risk_level} (see HomeClusterCard/
           -- ExplorerClusterCard) — extract just those keys instead of the full analysis JSON
           -- (pedagogical_analysis, risks, opportunities, timeline_events, counter_analysis, ...),
           -- which is only needed on the cluster DETAIL screen (separate cached endpoint).
           (
             SELECT jsonb_build_object(
               'summary', aa.content->'summary',
               'key_takeaways', aa.content->'key_takeaways',
               'risk_level', aa.content->'risk_level'
             )
             FROM ai_analyses aa
             WHERE aa.target_type = 'cluster' AND aa.target_id = c.id
             ORDER BY aa.created_at DESC
             LIMIT 1
           ) AS analysis_preview
    FROM clusters c
    WHERE c.status IN ('active', 'growing', 'peak')
      AND NOT EXISTS (
        SELECT 1
        FROM cluster_articles ca_scope
        JOIN articles a_scope ON a_scope.id = ca_scope.article_id
        WHERE ca_scope.cluster_id = c.id
          AND CONCAT_WS(' ', c.title, a_scope.title, a_scope.description) ~* '(grand theft auto|final fantasy|video games?|summer game fest|multiplayer sequel|remake trilogy|entertainment/games)'
      )
      AND (
        c.article_count >= 2
        OR (
          (c.importance_score >= 8 OR c.growth_score >= 10)
          AND EXISTS (
            SELECT 1
            FROM cluster_articles ca
            JOIN articles a ON a.id = ca.article_id
            WHERE ca.cluster_id = c.id
              AND (
                CONCAT_WS(' ', c.title, a.title, a.description) ~* '(^|[^[:alnum:]_])(ai|ipo)([^[:alnum:]_]|$)'
                OR CONCAT_WS(' ', c.title, a.title, a.description) ~* '(artificial intelligence|data centers?|spacex|openai|microsoft|nvidia|alphabet|google|anthropic|cloud|cyber|security|hack|semiconductor|chip|nuclear|regulat|finance|market|trade|compute|rocket|satellite|payments?|fintech)'
              )
              AND CONCAT_WS(' ', c.title, a.title, a.description) !~* '(grand theft auto|final fantasy|video games?|summer game fest|multiplayer sequel|remake trilogy)'
              AND (
                LOWER(COALESCE(a.source_name, '')) <> 'hacker news'
                OR COALESCE(a.external_score, 0) >= 10
                OR COALESCE(a.comments_count, 0) >= 5
              )
          )
        )
        OR EXISTS (
          SELECT 1 FROM ai_analyses aa
          WHERE aa.target_type = 'cluster' AND aa.target_id = c.id
        )
      )
    ORDER BY score DESC, c.last_updated_at DESC NULLS LAST
    LIMIT ${candidateLimit}
  `);

  const mappedClusters: PersonalizedFeedCluster[] = result.map((row) => {
      const normalized = normalizeCluster(row);
      const previewArticles = asArray(row.preview_articles);
      const preference = scorePreferenceAdjustment({
        sourceNames: getPreviewArticleSources(previewArticles),
        articleIds: getPreviewArticleIds(previewArticles),
        clusterId: typeof normalized.id === 'string' ? normalized.id : '',
        title: typeof normalized.title === 'string' ? normalized.title : '',
        summary: typeof normalized.summary === 'string' ? normalized.summary : null,
        profile: preferenceProfile,
      });
      const baseScore = parseNumber(row.score);
      const freshness = scoreFreshnessAdjustment({
        firstSeenAt: normalized.first_seen_at,
        lastUpdatedAt: normalized.last_updated_at,
        growthScore: parseNumber(normalized.growth_score),
        noveltyScore: parseNumber(normalized.novelty_score),
        articleCount: parseNumber(normalized.article_count),
      });

      const adjustedScore = baseScore + preference.delta + freshness.delta;

      return {
        ...normalized,
        score: capScoreByFreshness(adjustedScore, freshness.label),
        base_score: baseScore,
        preference_adjustment: preference.delta,
        preference_reasons: preference.reasons,
        freshness_adjustment: freshness.delta,
        freshness_label: freshness.label,
        freshness_reasons: freshness.reasons,
        preview_articles: previewArticles,
        analysis_preview: row.analysis_preview ?? null,
      };
    });

  const scoredClusters: PersonalizedFeedCluster[] = applyTopicSaturation(mappedClusters)
    .sort((left: PersonalizedFeedCluster, right: PersonalizedFeedCluster) => {
      const byScore = parseNumber(right.score) - parseNumber(left.score);
      if (byScore !== 0) return byScore;
      const leftDate = typeof left.last_updated_at === 'string' ? Date.parse(left.last_updated_at) : 0;
      const rightDate = typeof right.last_updated_at === 'string' ? Date.parse(right.last_updated_at) : 0;
      return rightDate - leftDate;
    });
  const clusters = selectWithMMR(scoredClusters, limit);

  return json({
    clusters,
    count: clusters.length,
    source: 'neon',
    personalization: {
      enabled: preferenceProfile.total > 0,
      feedback_count: preferenceProfile.total,
    },
  });
}

async function getClusterDetail(sql: Sql, clusterId: string): Promise<Response> {
  const [cluster] = await rows<ClusterRow>(sql`
    SELECT c.id, c.title, c.summary, c.main_theme, c.status,
           c.importance_score, c.growth_score, c.novelty_score,
           (
             SELECT COUNT(DISTINCT a.source_name)
             FROM cluster_articles ca
             JOIN articles a ON a.id = ca.article_id
             WHERE ca.cluster_id = c.id
           ) AS source_diversity,
           c.article_count,
           c.first_seen_at, c.last_updated_at, c.created_at,
           (
             c.importance_score
             + LEAST(c.growth_score, 20) * 2
             + c.novelty_score * 2
             + CASE WHEN c.article_count >= 2 THEN 20 ELSE -15 END
           ) AS score
    FROM clusters c
    WHERE c.id = ${clusterId}
    LIMIT 1
  `);

  if (!cluster) return err('Cluster introuvable', 404);

  const [articles, analyses, entities, timeline] = await Promise.all([
     rows<ArticleRow>(sql`
      SELECT a.id, a.title, a.description, a.source_name, a.source_type,
             a.author, a.url, a.image_url, a.language, a.category, a.sentiment,
             a.external_score, a.comments_count, a.published_at, a.fetched_at,
             ca.role, ca.similarity_score
      FROM articles a
      JOIN cluster_articles ca ON ca.article_id = a.id
      WHERE ca.cluster_id = ${clusterId}
      ORDER BY (ca.role = 'primary') DESC, ca.similarity_score DESC NULLS LAST,
               a.published_at DESC NULLS LAST
    `),
    rows<AnalysisRow>(sql`
      SELECT id, target_type, target_id, model_provider, model_name,
             analysis_type, content, tokens_used, cost_estimate, created_at
      FROM ai_analyses
      WHERE target_type = 'cluster' AND target_id = ${clusterId}
      ORDER BY created_at DESC
      LIMIT 5
    `),
    rows<EntityRow>(sql`
      SELECT e.id, e.name, e.normalized_name, e.type, e.description,
             e.mentions_count, e.trend_score, e.first_seen_at, e.last_seen_at,
             0 AS latest_growth_rate, 0 AS seven_day_mentions, 0 AS seven_day_sources
      FROM entities e
      JOIN article_entities ae ON ae.entity_id = e.id
      JOIN cluster_articles ca ON ca.article_id = ae.article_id
      WHERE ca.cluster_id = ${clusterId}
      GROUP BY e.id
      ORDER BY e.trend_score DESC, e.mentions_count DESC
      LIMIT 30
    `),
    rows<TimelineEventRow>(sql`
      SELECT id, title, description, event_date, importance, source_article_id
      FROM timeline_events
      WHERE cluster_id = ${clusterId}
      ORDER BY event_date DESC NULLS LAST, importance DESC
      LIMIT 20
    `),
  ]);

  return json({
    cluster: normalizeCluster(cluster),
    articles: articles.map(normalizeArticle),
    analyses: analyses.map(normalizeAnalysis),
    latest_analysis: analyses[0] ? normalizeAnalysis(analyses[0]) : null,
    entities: entities.map(normalizeEntity),
    timeline: timeline.map((event) => ({
      id: event.id,
      title: event.title,
      description: event.description,
      event_date: toIso(event.event_date),
      importance: parseNumber(event.importance),
      source_article_id: event.source_article_id,
    })),
    source: 'neon',
  });
}

async function getArticleDetail(sql: Sql, articleId: string): Promise<Response> {
  const [article] = await rows<ArticleDetailRow>(sql`
    SELECT a.id, a.title, a.description, a.full_text, a.source_name, a.source_type,
           a.author, a.url, a.image_url, a.language, a.category, a.sentiment,
           a.external_score, a.comments_count, a.published_at, a.fetched_at,
           a.status, a.pipeline_status, a.extraction_status, a.embedding_status,
           a.clustering_status, a.analysis_status, a.llm_enrichment_status,
           a.llm_enriched_at, a.llm_enrichment_model, a.extraction_method,
           a.extracted_at, a.embedded_at, a.embedding_model, a.embedding_dimensions,
           a.internal_score, a.created_at,
           a.audio_url, a.audio_duration,
           NULL::text AS role, NULL::float AS similarity_score
    FROM articles a
    WHERE a.id = ${articleId}
    LIMIT 1
  `);

  if (!article) return err('Article introuvable', 404);

  const [intelligence, clusters, entities] = await Promise.all([
    rows<ArticleIntelligenceRow>(sql`
      SELECT id, article_id, model_provider, model_name, language,
             canonical_title, summary, article_type, primary_domain, topic,
             subtopics, event_fingerprint, event_date, entities, companies,
             people, products, sectors, countries, keywords, tags, sentiment,
             sentiment_score, tech_impact, business_impact, finance_impact,
             market_impact, quality_score, relevance_score, novelty_score,
             time_sensitivity, should_cluster, cluster_hint, confidence, raw,
             created_at, updated_at
      FROM article_intelligence
      WHERE article_id = ${articleId}
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `),
    rows<ClusterRow>(sql`
      SELECT c.id, c.title, c.summary, c.main_theme, c.status,
             c.importance_score, c.growth_score, c.novelty_score,
             (
               SELECT COUNT(DISTINCT a.source_name)
               FROM cluster_articles ca2
               JOIN articles a ON a.id = ca2.article_id
               WHERE ca2.cluster_id = c.id
             ) AS source_diversity,
             c.article_count,
             c.first_seen_at, c.last_updated_at, c.created_at,
             (
               c.importance_score
               + LEAST(c.growth_score, 20) * 2
               + c.novelty_score * 2
               + CASE WHEN c.article_count >= 2 THEN 20 ELSE -15 END
             ) AS score
      FROM clusters c
      JOIN cluster_articles ca ON ca.cluster_id = c.id
      WHERE ca.article_id = ${articleId}
      ORDER BY ca.similarity_score DESC NULLS LAST, c.importance_score DESC
      LIMIT 5
    `),
    rows<EntityRow>(sql`
      SELECT e.id, e.name, e.normalized_name, e.type, e.description,
             e.mentions_count, e.trend_score, e.first_seen_at, e.last_seen_at,
             0 AS latest_growth_rate, 0 AS seven_day_mentions, 0 AS seven_day_sources
      FROM entities e
      JOIN article_entities ae ON ae.entity_id = e.id
      WHERE ae.article_id = ${articleId}
      GROUP BY e.id
      ORDER BY e.trend_score DESC, e.mentions_count DESC
      LIMIT 30
    `),
  ]);

  // Podcast moments (if this article is a podcast with extracted moments)
  const podcastMoments = article.source_type === 'podcast'
    ? await rows<AnalysisRow>(sql`
        SELECT id, target_type, target_id, model_provider, model_name,
               analysis_type, content, tokens_used, cost_estimate, created_at
        FROM ai_analyses
        WHERE target_type = 'article'
          AND target_id = ${articleId}
          AND analysis_type = 'podcast_moments'
        ORDER BY created_at DESC
        LIMIT 1
      `)
    : [];

  return json({
    article: normalizeArticleDetail(article),
    intelligence: intelligence[0] ? normalizeArticleIntelligence(intelligence[0]) : null,
    clusters: clusters.map(normalizeCluster),
    entities: entities.map(normalizeEntity),
    podcast_moments: podcastMoments[0] ? normalizeAnalysis(podcastMoments[0]) : null,
    source: 'neon',
  });
}

async function getEntities(sql: Sql, url: URL): Promise<Response> {
  const limit = parseLimit(url, 40, 100);
  const result = await rows<EntityRow>(sql`
    SELECT e.id, e.name, e.normalized_name, e.type, e.description,
           e.mentions_count, e.trend_score, e.first_seen_at, e.last_seen_at,
           COALESCE(MAX(ts.growth_rate), 0) AS latest_growth_rate,
           COALESCE(SUM(ts.mention_count), 0) AS seven_day_mentions,
           COALESCE(SUM(ts.source_count), 0) AS seven_day_sources
    FROM entities e
    LEFT JOIN trend_snapshots ts ON ts.entity_id = e.id
      AND ts.snapshot_date >= CURRENT_DATE - INTERVAL '7 days'
    WHERE e.normalized_name NOT IN (
      'ai', 'us', 'u.s.', 'u. s.', 'uk', 'reuters', 'bloomberg',
      'bloomberg tech', 'bloomberg technology', 'hacker news',
      'techcrunch', 'the verge', 'ars technica', 'cnbc',
      'ed ludlow', 'caroline hyde', 'youtube', 'san francisco'
    )
    GROUP BY e.id
    ORDER BY e.trend_score DESC, e.mentions_count DESC, e.last_seen_at DESC NULLS LAST
    LIMIT ${limit}
  `);

  const entities = result.map(normalizeEntity);
  return json({ entities, count: entities.length, source: 'neon' });
}

interface PodcastCandidateRow {
  id: string;
  title: string;
  summary: string | null;
  main_theme: string | null;
  importance_score: number | string;
  growth_score: number | string;
  novelty_score: number | string;
  article_count: number | string;
  score: number | string;
}

interface PodcastSerendipityCandidateRow {
  id: string;
  title_choc: string;
  enigme: string | null;
  domain: string | null;
}

async function getPodcastCandidates(sql: Sql, url: URL): Promise<Response> {
  const limit = parseLimit(url, 5, 10);
  const clusterLimit = Math.ceil(limit * 0.7);
  const scienceLimit = Math.max(1, limit - clusterLimit);

  const [clusterRows, serendipityRows] = await Promise.all([
    rows<PodcastCandidateRow>(sql`
      SELECT c.id, c.title, c.summary, c.main_theme,
             c.importance_score, c.growth_score, c.novelty_score, c.article_count,
             (
               c.importance_score
               + LEAST(c.growth_score, 20) * 2
               + c.novelty_score * 2
               + CASE WHEN c.article_count >= 2 THEN 20 ELSE -15 END
             ) AS score
      FROM clusters c
      WHERE c.status IN ('active', 'growing', 'peak')
        AND c.article_count >= 2
        AND NOT EXISTS (
          SELECT 1 FROM podcasts p
          WHERE p.created_at > NOW() - INTERVAL '48 hours'
            AND p.cluster_ids @> to_jsonb(c.id::text)
        )
      ORDER BY score DESC
      LIMIT ${clusterLimit}
    `),
    rows<PodcastSerendipityCandidateRow>(sql`
      SELECT sc.id, sc.title_choc, sc.enigme, sc.domain
      FROM serendipity_cards sc
      WHERE sc.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM podcasts p
          WHERE p.created_at > NOW() - INTERVAL '48 hours'
            AND p.cluster_ids @> to_jsonb(sc.id::text)
        )
      ORDER BY sc.created_at DESC
      LIMIT ${scienceLimit}
    `),
  ]);

  const clusterCandidates = clusterRows.map((row) => ({
    type: 'cluster' as const,
    id: row.id,
    title: row.title,
    summary: row.summary,
    main_theme: row.main_theme,
    score: parseNumber(row.score),
  }));

  const serendipityCandidates = serendipityRows.map((row) => ({
    type: 'serendipity' as const,
    id: row.id,
    title: row.title_choc,
    summary: row.enigme,
    main_theme: row.domain,
    score: null,
  }));

  const candidates = [...clusterCandidates, ...serendipityCandidates];
  return json({ candidates, count: candidates.length, source: 'neon' });
}

async function getSignals(sql: Sql, url: URL): Promise<Response> {
  const limit = parseLimit(url, 10, 50);
  const maxMentions = Math.max(1, Math.min(Number(url.searchParams.get('max_mentions') ?? 15), 100));
  const minSources = Math.max(1, Math.min(Number(url.searchParams.get('min_sources') ?? 2), 10));
  const minGrowth = Math.max(0, Math.min(Number(url.searchParams.get('min_growth') ?? 10), 500));

  const [clusters, weakSignalAnalyses] = await Promise.all([
    rows<ClusterRow>(sql`
      SELECT c.id, c.title, c.summary, c.main_theme, c.status,
             c.importance_score, c.growth_score, c.novelty_score,
             (
               SELECT COUNT(DISTINCT a.source_name)
               FROM cluster_articles ca
               JOIN articles a ON a.id = ca.article_id
               WHERE ca.cluster_id = c.id
             ) AS source_diversity,
             c.article_count,
             c.first_seen_at, c.last_updated_at, c.created_at,
             (
               c.importance_score
               + LEAST(c.growth_score, 20) * 2
               + c.novelty_score * 2
               + CASE WHEN c.article_count >= 2 THEN 20 ELSE -15 END
             ) AS score
      FROM clusters c
      WHERE c.status IN ('active', 'growing')
        AND c.article_count <= ${maxMentions}
        AND (
          SELECT COUNT(DISTINCT a.source_name)
          FROM cluster_articles ca
          JOIN articles a ON a.id = ca.article_id
          WHERE ca.cluster_id = c.id
        ) >= ${minSources}
        AND c.growth_score >= ${minGrowth}
        AND c.first_seen_at > NOW() - INTERVAL '72 hours'
      ORDER BY c.growth_score DESC, c.novelty_score DESC, c.importance_score DESC
      LIMIT ${limit}
    `),
    rows<AnalysisRow>(sql`
      SELECT id, target_type, target_id, model_provider, model_name,
             analysis_type, content, tokens_used, cost_estimate, created_at
      FROM ai_analyses
      WHERE target_type = 'daily_digest'
        AND target_id = 'weak_signals'
        AND analysis_type = 'weak_signal'
      ORDER BY created_at DESC
      LIMIT 1
    `),
  ]);

  return json({
    signals: clusters.map(normalizeCluster),
    latest_llm_digest: weakSignalAnalyses[0] ? normalizeAnalysis(weakSignalAnalyses[0]) : null,
    count: clusters.length,
    source: 'neon',
  });
}

interface SerendipityRow {
  id: string;
  arxiv_id: string | null;
  source_url: string | null;
  domain: string | null;
  arxiv_category: string | null;
  title_choc: string;
  enigme: string | null;
  personnage: string | null;
  concept: string | null;
  so_what: string | null;
  paper_title: string | null;
  authors: unknown;
  published_at: string | Date | null;
  created_at: string | Date | null;
}

interface ScienceSerendipityArticleRow {
  hash: string;
  title: string;
  title_fr: string | null;
  source_name: string;
  url: string | null;
  content: string | null;
  summary_fr: string | null;
  published_at: number | null;
  fetched_at: number;
}

function normalizeSerendipityCard(c: SerendipityRow): Record<string, unknown> {
  return {
    ...c,
    authors: Array.isArray(c.authors) ? c.authors : [],
    published_at: toIso(c.published_at),
    created_at: toIso(c.created_at),
  };
}

function isScientificSerendipityCard(card: SerendipityRow): boolean {
  const text = [
    card.domain,
    card.title_choc,
    card.enigme,
    card.concept,
    card.so_what,
    card.paper_title,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/\b(ipo|nasdaq|oil|pétrole|petrole|détroit d'ormuz|detroit d'ormuz|venture|startup valuation|marché|market)\b/i.test(text)) {
    return false;
  }

  return /\b(science|physique|physics|quantum|quantique|astro|space|espace|cosmolog|neuro|biology|biologie|bio|medicine|médecine|medical|crispr|gene|protein|chem|chimie|materials|matériaux|climate|climat|earth|terre|robotique|robotics|fusion|ocean|océan|cell|genom|fongique|fungal)\b/i.test(text);
}

function extractBriefSection(summary: string | null, label: string): string | null {
  if (!summary) return null;
  const pattern = new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\n[A-ZÀ-Ÿ][^\\n:]{1,48}\\s*:|$)`, 'i');
  const match = summary.match(pattern);
  const text = match?.[1]?.replace(/\s+/g, ' ').trim();
  return text && text.length >= 20 ? text.slice(0, 900) : null;
}

function sourceDomain(sourceName: string): string {
  const name = sourceName.trim();
  if (/arxiv/i.test(name)) return 'preprint';
  if (/nature|science|cell|lancet|nejm|plos/i.test(name)) return 'revue';
  if (/quanta|science news|ars|conversation|cosmos|discover/i.test(name)) return 'décryptage';
  if (/nasa|esa|mit|our world in data|hal/i.test(name)) return 'institution';
  if (/grok/i.test(name)) return 'exploration web';
  return 'science';
}

function serendipityScore(article: ScienceSerendipityArticleRow): number {
  const text = `${article.title} ${article.title_fr ?? ''} ${article.summary_fr ?? ''}`.toLowerCase();
  let score = 0;
  if (article.summary_fr && article.summary_fr.length >= 700) score += 28;
  if (/mécanisme|mechanism|concepts|pont transverse|niveau expert/i.test(article.summary_fr ?? '')) score += 18;
  if (/surprising|unexpected|unusual|strange|mystery|quantum|black hole|neuroscience|crispr|protein|fusion|exoplanet|robotic|materials|climate|genome|cell/i.test(text)) score += 18;
  if (/quanta|science news|nature|science|cell|lancet|nasa|biorxiv|medrxiv|chemrxiv|eartharxiv|hal|cochrane|grok/i.test(article.source_name)) score += 16;
  if (/seminar|symposium|webinar|activities|take place|#shorts?/i.test(article.title)) score -= 60;
  return score;
}

function scienceArticleToSerendipityCard(article: ScienceSerendipityArticleRow): Record<string, unknown> {
  const summary = article.summary_fr ?? '';
  const simple = extractBriefSection(summary, 'Niveau simple');
  const mechanism = extractBriefSection(summary, 'Mécanisme') ?? extractBriefSection(summary, 'Niveau intermédiaire');
  const soWhat = extractBriefSection(summary, 'Pourquoi ça compte') ?? extractBriefSection(summary, 'Pont transverse');
  const concepts = extractBriefSection(summary, 'Concepts');
  const tldr = extractBriefSection(summary, 'TL;DR');
  const title = article.title_fr?.trim() || article.title;

  return {
    id: `science-${article.hash}`,
    arxiv_id: null,
    source_url: article.url,
    domain: sourceDomain(article.source_name),
    arxiv_category: null,
    title_choc: title,
    enigme: simple ?? tldr ?? article.content?.replace(/\s+/g, ' ').trim().slice(0, 280) ?? null,
    personnage: article.source_name,
    concept: mechanism ?? concepts,
    so_what: soWhat,
    paper_title: article.title,
    authors: [],
    published_at: article.published_at ? new Date(article.published_at).toISOString() : null,
    created_at: new Date(article.fetched_at).toISOString(),
    source_name: article.source_name,
    mode: 'science_brief_fallback',
  };
}

async function getScienceSerendipityFallback(env: Env, limit: number): Promise<Record<string, unknown>[]> {
  const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT hash, title, title_fr, source_name, url, content, summary_fr, published_at, fetched_at
     FROM articles
     WHERE theme = 'science'
       AND fetched_at > ?
       AND summary_fr IS NOT NULL
       AND LENGTH(summary_fr) >= 420
       AND title NOT LIKE '%Seminar%'
       AND title NOT LIKE '%Symposium%'
       AND title NOT LIKE '%Activities%'
       AND title NOT LIKE '%Take Place%'
       AND title NOT LIKE '%#shorts%'
       AND title NOT LIKE '%#short%'
     ORDER BY fetched_at DESC
     LIMIT 80`,
  ).bind(cutoff).all<ScienceSerendipityArticleRow>();

  const seenDomains = new Set<string>();
  const selected: ScienceSerendipityArticleRow[] = [];
  const deferred: ScienceSerendipityArticleRow[] = [];
  const ranked = results
    .map((article) => ({ article, score: serendipityScore(article) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.article.fetched_at - a.article.fetched_at);

  for (const { article } of ranked) {
    const domain = sourceDomain(article.source_name);
    if (seenDomains.has(domain)) {
      deferred.push(article);
      continue;
    }
    selected.push(article);
    seenDomains.add(domain);
    if (selected.length >= limit) break;
  }

  return [...selected, ...deferred].slice(0, limit).map(scienceArticleToSerendipityCard);
}

async function getSerendipity(sql: Sql, env: Env, url: URL): Promise<Response> {
  const limit = parseLimit(url, 12, 30);
  const cards = await rows<SerendipityRow>(sql`
      SELECT id, arxiv_id, source_url, domain, arxiv_category,
             title_choc, enigme, personnage, concept, so_what,
             paper_title, authors, published_at, created_at
      FROM serendipity_cards
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `).catch(() => []);

  if (cards.length > 0) {
    const scienceCards = cards.filter(isScientificSerendipityCard).map(normalizeSerendipityCard);
    const fallbackCards = await getScienceSerendipityFallback(env, limit);
    const fallbackIds = new Set(fallbackCards.map((card) => card.id));
    const mergedCards = [
      ...fallbackCards,
      ...scienceCards.filter((card) => !fallbackIds.has(card.id)),
    ].slice(0, limit);
    if (mergedCards.length > 0) {
      return json({
        cards: mergedCards,
        count: mergedCards.length,
        source: fallbackCards.length ? 'mixed' : 'neon',
        mode: fallbackCards.length ? 'science_mixed' : 'serendipity_cards',
      });
    }

    return json({
      cards: [],
      count: 0,
      source: 'neon',
      mode: 'empty_science_filter',
    });
  }

  const fallbackCards = await getScienceSerendipityFallback(env, limit);
  if (fallbackCards.length > 0) {
    return json({
      cards: fallbackCards,
      count: fallbackCards.length,
      source: 'd1',
      mode: 'science_brief_fallback',
    });
  }

  return json({
    cards: [],
    count: 0,
    source: 'neon',
    mode: 'empty',
  });
}

// ─── Concepts dynamiques (Phase E — Comprendre l'IA) ──────────────────────────

interface ConceptRow {
  concept: string;
  explanation: string | null;
  domain: string | null;
  source_article_id: string;
  source_title: string;
  source_name: string;
  source_type: string;
  article_url: string | null;
  created_at: string | Date;
}

// ─── Recherche sémantique/full-text dans Neon ─────────────────────────────────

async function searchNeon(sql: Sql, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < 2) return json({ results: { clusters: [], articles: [], entities: [] }, count: 0, query: q, source: 'neon' });

  const limit = parseLimit(url, 20, 50);
  const ilikePattern = '%' + q + '%';

  // Recherche full-text sur les clusters
  const clusters = await rows<ClusterRow>(sql`
    SELECT c.id, c.title, c.summary, c.main_theme, c.status,
           c.importance_score, c.growth_score, c.novelty_score,
           c.article_count, c.first_seen_at, c.last_updated_at
    FROM clusters c
    WHERE c.status IN ('active', 'growing', 'peak')
      AND (
        c.title ILIKE ${ilikePattern}
        OR c.summary ILIKE ${ilikePattern}
        OR c.main_theme ILIKE ${ilikePattern}
      )
    ORDER BY c.importance_score DESC, c.last_updated_at DESC
    LIMIT ${limit}
  `);

  // Recherche sur les articles
  const articles = await rows<ArticleRow>(sql`
    SELECT a.id, a.title, a.description, a.source_name, a.source_type,
           a.url, a.image_url, a.published_at
    FROM articles a
    WHERE a.title ILIKE ${ilikePattern}
       OR a.description ILIKE ${ilikePattern}
    ORDER BY a.published_at DESC NULLS LAST
    LIMIT ${limit}
  `);

  // Recherche sur les entités
  const entities = await rows<EntityRow>(sql`
    SELECT e.id, e.name, e.type, e.description,
           e.mentions_count, e.trend_score
    FROM entities e
    WHERE e.name ILIKE ${ilikePattern}
       OR e.description ILIKE ${ilikePattern}
    ORDER BY e.trend_score DESC, e.mentions_count DESC
    LIMIT ${Math.min(limit, 10)}
  `);

  return json({
    results: {
      clusters: clusters.map((c) => normalizeCluster(c)),
      articles: articles.map(normalizeArticle),
      entities: entities.map(normalizeEntity),
    },
    count: clusters.length + articles.length + entities.length,
    query: q,
    source: 'neon',
  });
}

// ─── Prédictions (suivi dans le temps) ────────────────────────────────────────

async function getPredictions(sql: Sql, url: URL): Promise<Response> {
  const limit = parseLimit(url, 20, 100);
  const status = url.searchParams.get('status')?.trim() || null;
  const domain = url.searchParams.get('domain')?.trim().toLowerCase() || null;
  const sinceDays = Math.max(1, Math.min(Number(url.searchParams.get('since_days') ?? '30'), 365));

  const result = await rows(sql`
    SELECT id, prediction, horizon, confidence, source_type, source_id,
           source_title, source_name, speaker, domain, status,
           resolved_at, resolution_notes, created_at, updated_at
    FROM predictions
    ${status ? sql`WHERE status = ${status}` : sql``}
    ${domain ? (status ? sql`AND domain = ${domain}` : sql`WHERE domain = ${domain}`) : sql``}
    AND created_at > NOW() - (${sinceDays} || ' days')::interval
    ORDER BY
      CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT ${limit}
  `);

  return json({
    predictions: result,
    count: result.length,
    source: 'neon',
  });
}

async function getConcepts(sql: Sql, url: URL): Promise<Response> {
  const limit = parseLimit(url, 30, 100);
  const sinceHours = Math.max(1, Math.min(Number(url.searchParams.get('since_hours') ?? '168'), 720));
  const domain = url.searchParams.get('domain')?.trim().toLowerCase() || null;

  // Source 1 : concepts extraits des podcasts (ai_analyses podcast_moments → content.concepts_explained)
  const podcastConcepts = await sql`
    SELECT
      je.concept AS concept,
      je.explanation AS explanation,
      je.domain AS domain,
      a.id AS source_article_id,
      a.title AS source_title,
      a.source_name AS source_name,
      a.source_type AS source_type,
      a.url AS article_url,
      aa.created_at AS created_at
    FROM ai_analyses aa
    JOIN articles a ON a.id = aa.target_id
    JOIN LATERAL jsonb_array_elements(aa.content->'concepts_explained') AS je ON true
    WHERE aa.target_type = 'article'
      AND aa.analysis_type = 'podcast_moments'
      AND a.source_type = 'podcast'
      AND aa.created_at > NOW() - (${sinceHours} || ' hours')::interval
  ` as ConceptRow[];

  // Source 2 : entités de type 'concept' extraites par article_intelligence
  const articleConcepts = await sql`
    SELECT
      ent.name AS concept,
      NULL::text AS explanation,
      ai.primary_domain AS domain,
      a.id AS source_article_id,
      a.title AS source_title,
      a.source_name AS source_name,
      a.source_type AS source_type,
      a.url AS article_url,
      ai.updated_at AS created_at
    FROM article_intelligence ai
    JOIN articles a ON a.id = ai.article_id
    JOIN LATERAL jsonb_array_elements(ai.entities) AS ent ON true
    WHERE ent->>'type' = 'concept'
      AND ent->>'role' = 'main'
      AND ai.updated_at > NOW() - (${sinceHours} || ' hours')::interval
  ` as ConceptRow[];

  // Fusion + dédoublonnage par nom normalisé
  const allConcepts = [...podcastConcepts, ...articleConcepts];
  const byKey = new Map<string, ConceptRow>();

  for (const row of allConcepts) {
    const key = (row.concept || '').toLowerCase().trim().slice(0, 80);
    if (!key) continue;

    // Filtrer par domaine si demandé
    if (domain && (row.domain || '').toLowerCase() !== domain) continue;

    const existing = byKey.get(key);
    // Garder la version avec une explication (podcast) plutôt que sans (article)
    if (!existing || (!existing.explanation && row.explanation)) {
      byKey.set(key, row);
    }
  }

  // Trier par récence puis limiter
  const concepts = Array.from(byKey.values())
    .sort((a, b) => {
      const ta = a.created_at instanceof Date ? a.created_at.getTime() : Date.parse(String(a.created_at));
      const tb = b.created_at instanceof Date ? b.created_at.getTime() : Date.parse(String(b.created_at));
      return tb - ta;
    })
    .slice(0, limit);

  return json({
    concepts: concepts.map((row) => ({
      concept: row.concept,
      explanation: row.explanation,
      domain: row.domain,
      source: {
        article_id: row.source_article_id,
        title: row.source_title,
        source_name: row.source_name,
        source_type: row.source_type,
        url: row.article_url,
      },
      created_at: toIso(row.created_at),
    })),
    count: concepts.length,
    source: 'neon',
  });
}

// ─── Podcast moments (Phase E) ────────────────────────────────────────────────

async function getPodcastMoments(sql: Sql, url: URL): Promise<Response> {
  const limit = parseLimit(url, 10, 50);
  const sinceHours = Math.max(1, Math.min(Number(url.searchParams.get('since_hours') ?? '72'), 168));

  const moments = await rows<AnalysisRow>(sql`
    SELECT aa.id, aa.target_id, aa.content, aa.created_at,
           a.title AS article_title, a.source_name, a.url AS article_url,
           a.audio_url, a.audio_duration, a.image_url
    FROM ai_analyses aa
    JOIN articles a ON a.id = aa.target_id
    WHERE aa.target_type = 'article'
      AND aa.analysis_type = 'podcast_moments'
      AND a.source_type = 'podcast'
      AND aa.created_at > NOW() - (${sinceHours} || ' hours')::interval
    ORDER BY aa.created_at DESC
    LIMIT ${limit}
  `);

  const mapped = moments.map((row) => ({
    ...normalizeAnalysis(row),
    article: {
      id: row.target_id,
      title: (row as { article_title?: string }).article_title ?? null,
      source_name: (row as { source_name?: string }).source_name ?? null,
      url: (row as { article_url?: string }).article_url ?? null,
      audio_url: (row as { audio_url?: string | null }).audio_url ?? null,
      audio_duration: parseNumber((row as { audio_duration?: string | number | null }).audio_duration),
      image_url: (row as { image_url?: string | null }).image_url ?? null,
    },
  }));

  return json({
    moments: mapped,
    count: mapped.length,
    source: 'neon',
  });
}
