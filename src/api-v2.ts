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
import { err, json } from './utils';

type Sql = NeonQueryFunction<false, false>;

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
      return getFeed(sql, url);
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

    return err('Route API v2 inconnue', 404);
  } catch (error) {
    console.error('[api-v2] Neon query failed', error);
    return err('Erreur de lecture Neon', 500);
  }
}

async function getFeed(sql: Sql, url: URL): Promise<Response> {
  const limit = parseLimit(url, 30, 100);
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
    LIMIT ${limit}
  `);

  const clusters = result.map((row) => ({
    ...normalizeCluster(row),
    preview_articles: asArray(row.preview_articles),
    analysis_preview: row.analysis_preview ?? null,
  }));

  return json({ clusters, count: clusters.length, source: 'neon' });
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
