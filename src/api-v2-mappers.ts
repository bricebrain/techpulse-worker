import type { AnalysisRow, ArticleRow, ClusterRow, EntityRow } from './api-v2-types';

type JsonRecord = Record<string, unknown>;

export function parseNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeCluster(row: ClusterRow): JsonRecord {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    main_theme: row.main_theme,
    status: row.status,
    importance_score: parseNumber(row.importance_score),
    growth_score: parseNumber(row.growth_score),
    novelty_score: parseNumber(row.novelty_score),
    source_diversity: parseNumber(row.source_diversity),
    article_count: parseNumber(row.article_count),
    score: parseNumber(row.score),
    first_seen_at: toIso(row.first_seen_at),
    last_updated_at: toIso(row.last_updated_at),
    created_at: toIso(row.created_at),
  };
}

export function normalizeArticle(row: ArticleRow): JsonRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    source_name: row.source_name,
    source_type: row.source_type,
    author: row.author,
    url: row.url,
    image_url: row.image_url,
    language: row.language,
    category: row.category,
    sentiment: row.sentiment,
    external_score: parseNumber(row.external_score),
    comments_count: parseNumber(row.comments_count),
    published_at: toIso(row.published_at),
    fetched_at: toIso(row.fetched_at),
    cluster_role: row.role,
    similarity_score: parseNumber(row.similarity_score),
  };
}

export function normalizeAnalysis(row: AnalysisRow): JsonRecord {
  return {
    id: row.id,
    target_type: row.target_type,
    target_id: row.target_id,
    model_provider: row.model_provider,
    model_name: row.model_name,
    analysis_type: row.analysis_type,
    content: row.content,
    tokens_used: parseNumber(row.tokens_used),
    cost_estimate: parseNumber(row.cost_estimate),
    created_at: toIso(row.created_at),
  };
}

export function normalizeEntity(row: EntityRow): JsonRecord {
  return {
    id: row.id,
    name: row.name,
    normalized_name: row.normalized_name,
    type: row.type,
    description: row.description,
    mentions_count: parseNumber(row.mentions_count),
    trend_score: parseNumber(row.trend_score),
    latest_growth_rate: parseNumber(row.latest_growth_rate),
    seven_day_mentions: parseNumber(row.seven_day_mentions),
    seven_day_sources: parseNumber(row.seven_day_sources),
    first_seen_at: toIso(row.first_seen_at),
    last_seen_at: toIso(row.last_seen_at),
  };
}
