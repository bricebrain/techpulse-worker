import { neon } from '@neondatabase/serverless';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import {
  asArray,
  normalizeAnalysis,
  normalizeArticle,
  normalizeArticleDetail,
  normalizeArticleIntelligence,
  normalizeCluster,
  normalizeEntity,
  normalizeEntityRelationship,
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
  EntityRelationshipRow,
  FeedClusterRow,
  TimelineEventRow,
} from './api-v2-types';
import type { Env } from './types';
import { getArticleFeedbackPreferenceProfile, scorePreferenceAdjustment } from './feedback';
import { err, json } from './utils';

type Sql = NeonQueryFunction<false, false>;
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

function diversifyTopClusters(clusters: PersonalizedFeedCluster[], limit: number): PersonalizedFeedCluster[] {
  const selected: PersonalizedFeedCluster[] = [];
  const deferred: PersonalizedFeedCluster[] = [];
  const buckets = new Set<string>();
  const protectedWindow = Math.min(limit, 8);

  for (const cluster of clusters) {
    const bucket = topicBucket(cluster);
    if (selected.length < protectedWindow && buckets.has(bucket)) {
      deferred.push(cluster);
      continue;
    }
    selected.push(cluster);
    buckets.add(bucket);
  }

  return [...selected, ...deferred].slice(0, limit);
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
  if (!env.NEON_DATABASE_URL) {
    return err('NEON_DATABASE_URL non configuré', 503);
  }
  return neon(env.NEON_DATABASE_URL);
}

async function rows<T>(query: Promise<unknown>): Promise<T[]> {
  return (await query) as T[];
}

function parseLimit(url: URL, defaultValue: number, max: number): number {
  const raw = Number(url.searchParams.get('limit') ?? defaultValue);
  if (!Number.isFinite(raw)) return defaultValue;
  return Math.max(1, Math.min(Math.trunc(raw), max));
}

export async function handleApiV2(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!path.startsWith('/api/v2/')) return null;
  if (req.method !== 'GET') return err('Méthode non autorisée', 405);

  const sqlOrResponse = getSql(env);
  if (sqlOrResponse instanceof Response) return sqlOrResponse;
  const sql = sqlOrResponse;

  try {
    if (path === '/api/v2/feed') {
      return getFeed(sql, env, url);
    }

    if (path === '/api/v2/preferences') {
      return getPreferences(env);
    }

    if (path.startsWith('/api/v2/cluster/')) {
      const id = decodeURIComponent(path.slice('/api/v2/cluster/'.length)).trim();
      if (!id) return err('ID cluster requis');
      return getClusterDetail(sql, id);
    }

    if (path.startsWith('/api/v2/article/')) {
      const id = decodeURIComponent(path.slice('/api/v2/article/'.length)).trim();
      if (!id) return err('ID article requis');
      return getArticleDetail(sql, id);
    }

    if (path.startsWith('/api/v2/entity/') && path.endsWith('/graph')) {
      const rawId = path.slice('/api/v2/entity/'.length, -'/graph'.length);
      const id = decodeURIComponent(rawId).trim();
      if (!id) return err('ID entité requis');
      return getEntityGraph(sql, id, url);
    }

    if (path === '/api/v2/entities') {
      return getEntities(sql, url);
    }

    if (path === '/api/v2/signals') {
      return getSignals(sql, url);
    }

    if (path === '/api/v2/serendipity') {
      return getSerendipity(sql, env, url);
    }

    return err('Route API v2 inconnue', 404);
  } catch (error) {
    console.error('[api-v2] Neon query failed', error);
    return err('Erreur de lecture Neon', 500);
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
  const candidateLimit = Math.min(240, Math.max(limit * 5, 80));
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
           COALESCE((
             SELECT jsonb_agg(article_preview ORDER BY article_preview.published_at DESC NULLS LAST)
             FROM (
               SELECT a.id, a.title, a.description, a.source_name, a.source_type,
                      a.url, a.image_url, a.category, a.sentiment, a.published_at,
                      ca.role, ca.similarity_score
               FROM cluster_articles ca
               JOIN articles a ON a.id = ca.article_id
               WHERE ca.cluster_id = c.id
               ORDER BY (ca.role = 'primary') DESC, a.published_at DESC NULLS LAST
               LIMIT 3
             ) AS article_preview
           ), '[]'::jsonb) AS preview_articles,
           (
             SELECT aa.content
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
  const clusters = diversifyTopClusters(scoredClusters, limit);

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

  return json({
    article: normalizeArticleDetail(article),
    intelligence: intelligence[0] ? normalizeArticleIntelligence(intelligence[0]) : null,
    clusters: clusters.map(normalizeCluster),
    entities: entities.map(normalizeEntity),
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

async function getEntityGraph(sql: Sql, entityId: string, url: URL): Promise<Response> {
  const limit = parseLimit(url, 24, 60);
  const [entity] = await rows<EntityRow>(sql`
    SELECT e.id, e.name, e.normalized_name, e.type, e.description,
           e.mentions_count, e.trend_score, e.first_seen_at, e.last_seen_at,
           COALESCE(MAX(ts.growth_rate), 0) AS latest_growth_rate,
           COALESCE(SUM(ts.mention_count), 0) AS seven_day_mentions,
           COALESCE(SUM(ts.source_count), 0) AS seven_day_sources
    FROM entities e
    LEFT JOIN trend_snapshots ts ON ts.entity_id = e.id
      AND ts.snapshot_date >= CURRENT_DATE - INTERVAL '7 days'
    WHERE e.id = ${entityId}
    GROUP BY e.id
    LIMIT 1
  `);

  if (!entity) return err('Entité introuvable', 404);

  const [relationshipTable] = await rows<{ exists: boolean }>(sql`
    SELECT to_regclass('public.entity_relationships') IS NOT NULL AS exists
  `);

  if (!relationshipTable?.exists) {
    return json({
      entity: normalizeEntity(entity),
      relationships: [],
      count: 0,
      source: 'neon',
      warning: 'entity_relationships table missing',
    });
  }

  const relationships = await rows<EntityRelationshipRow>(sql`
    SELECT
      er.id,
      er.source_entity_id,
      er.target_entity_id,
      er.relation_type,
      er.strength_score,
      er.evidence_count,
      er.evidence_cluster_ids,
      er.evidence_article_ids,
      er.evidence_summary,
      er.first_seen_at,
      er.last_seen_at,
      er.updated_at,
      JSONB_BUILD_OBJECT(
        'id', related.id,
        'name', related.name,
        'normalized_name', related.normalized_name,
        'type', related.type,
        'description', related.description,
        'mentions_count', related.mentions_count,
        'trend_score', related.trend_score,
        'latest_growth_rate', COALESCE(related_ts.latest_growth_rate, 0),
        'seven_day_mentions', COALESCE(related_ts.seven_day_mentions, 0),
        'seven_day_sources', COALESCE(related_ts.seven_day_sources, 0),
        'first_seen_at', related.first_seen_at,
        'last_seen_at', related.last_seen_at
      ) AS related_entity,
      COALESCE((
        SELECT JSONB_AGG(cluster_payload ORDER BY cluster_payload->>'last_updated_at' DESC NULLS LAST)
        FROM (
          SELECT JSONB_BUILD_OBJECT(
            'id', c.id,
            'title', c.title,
            'summary', c.summary,
            'main_theme', c.main_theme,
            'status', c.status,
            'importance_score', c.importance_score,
            'growth_score', c.growth_score,
            'novelty_score', c.novelty_score,
            'source_diversity', c.source_diversity,
            'article_count', c.article_count,
            'score', (
              c.importance_score
              + LEAST(c.growth_score, 20) * 2
              + c.novelty_score * 2
              + CASE WHEN c.article_count >= 2 THEN 20 ELSE -15 END
            ),
            'first_seen_at', c.first_seen_at,
            'last_updated_at', c.last_updated_at,
            'created_at', c.created_at
          ) AS cluster_payload
          FROM clusters c
          WHERE c.id IN (
            SELECT JSONB_ARRAY_ELEMENTS_TEXT(er.evidence_cluster_ids)
          )
          ORDER BY c.last_updated_at DESC NULLS LAST
          LIMIT 5
        ) evidence
      ), '[]'::jsonb) AS evidence_clusters
    FROM entity_relationships er
    JOIN entities related
      ON related.id = CASE
        WHEN er.source_entity_id = ${entityId} THEN er.target_entity_id
        ELSE er.source_entity_id
      END
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(MAX(ts.growth_rate), 0) AS latest_growth_rate,
        COALESCE(SUM(ts.mention_count), 0) AS seven_day_mentions,
        COALESCE(SUM(ts.source_count), 0) AS seven_day_sources
      FROM trend_snapshots ts
      WHERE ts.entity_id = related.id
        AND ts.snapshot_date >= CURRENT_DATE - INTERVAL '7 days'
    ) related_ts ON TRUE
    WHERE er.source_entity_id = ${entityId}
       OR er.target_entity_id = ${entityId}
    ORDER BY er.strength_score DESC, er.evidence_count DESC, er.last_seen_at DESC NULLS LAST
    LIMIT ${limit}
  `);

  return json({
    entity: normalizeEntity(entity),
    relationships: relationships.map(normalizeEntityRelationship),
    count: relationships.length,
    source: 'neon',
  });
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
