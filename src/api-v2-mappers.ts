import type {
  AnalysisRow,
  ArticleDetailRow,
  ArticleIntelligenceRow,
  ArticleRow,
  ClusterRow,
  EntityRelationshipRow,
  EntityRow,
} from './api-v2-types';

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

export function normalizeArticleDetail(row: ArticleDetailRow): JsonRecord {
  return {
    ...normalizeArticle(row),
    full_text: row.full_text,
    status: row.status,
    pipeline_status: row.pipeline_status,
    extraction_status: row.extraction_status,
    embedding_status: row.embedding_status,
    clustering_status: row.clustering_status,
    analysis_status: row.analysis_status,
    llm_enrichment_status: row.llm_enrichment_status,
    llm_enriched_at: toIso(row.llm_enriched_at),
    llm_enrichment_model: row.llm_enrichment_model,
    extraction_method: row.extraction_method,
    extracted_at: toIso(row.extracted_at),
    embedded_at: toIso(row.embedded_at),
    embedding_model: row.embedding_model,
    embedding_dimensions: parseNumber(row.embedding_dimensions),
    internal_score: parseNumber(row.internal_score),
    audio_url: row.audio_url,
    audio_duration: parseNumber(row.audio_duration),
    created_at: toIso(row.created_at),
  };
}

export function normalizeArticleIntelligence(row: ArticleIntelligenceRow): JsonRecord {
  return {
    id: row.id,
    article_id: row.article_id,
    model_provider: row.model_provider,
    model_name: row.model_name,
    language: row.language,
    canonical_title: row.canonical_title,
    summary: row.summary,
    article_type: row.article_type,
    primary_domain: row.primary_domain,
    topic: row.topic,
    subtopics: asArray(row.subtopics),
    event_fingerprint: row.event_fingerprint,
    event_date: toIso(row.event_date),
    entities: asArray(row.entities),
    companies: asArray(row.companies),
    people: asArray(row.people),
    products: asArray(row.products),
    sectors: asArray(row.sectors),
    countries: asArray(row.countries),
    keywords: asArray(row.keywords),
    tags: asArray(row.tags),
    sentiment: row.sentiment,
    sentiment_score: parseNumber(row.sentiment_score),
    tech_impact: row.tech_impact,
    business_impact: row.business_impact,
    finance_impact: row.finance_impact,
    market_impact: row.market_impact,
    quality_score: parseNumber(row.quality_score),
    relevance_score: parseNumber(row.relevance_score),
    novelty_score: parseNumber(row.novelty_score),
    time_sensitivity: row.time_sensitivity,
    should_cluster: row.should_cluster,
    cluster_hint: row.cluster_hint,
    confidence: parseNumber(row.confidence),
    raw: row.raw ?? {},
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
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

export function normalizeEntityRelationship(row: EntityRelationshipRow): JsonRecord {
  return {
    id: row.id,
    source_entity_id: row.source_entity_id,
    target_entity_id: row.target_entity_id,
    relation_type: row.relation_type,
    strength_score: parseNumber(row.strength_score),
    evidence_count: parseNumber(row.evidence_count),
    evidence_cluster_ids: asArray(row.evidence_cluster_ids),
    evidence_article_ids: asArray(row.evidence_article_ids),
    evidence_summary: row.evidence_summary ?? {},
    first_seen_at: toIso(row.first_seen_at),
    last_seen_at: toIso(row.last_seen_at),
    updated_at: toIso(row.updated_at),
    related_entity: row.related_entity ?? null,
    evidence_clusters: asArray(row.evidence_clusters),
  };
}
