export interface ClusterRow {
  id: string;
  title: string | null;
  summary: string | null;
  main_theme: string | null;
  status: string | null;
  importance_score: number | string | null;
  growth_score: number | string | null;
  novelty_score: number | string | null;
  source_diversity: number | string | null;
  article_count: number | string | null;
  first_seen_at: string | Date | null;
  last_updated_at: string | Date | null;
  created_at: string | Date | null;
  score?: number | string | null;
}

export interface FeedClusterRow extends ClusterRow {
  preview_articles: unknown;
  analysis_preview: unknown;
}

export interface ArticleRow {
  id: string;
  title: string;
  description: string | null;
  source_name: string;
  source_type: string;
  author: string | null;
  url: string | null;
  image_url: string | null;
  language: string | null;
  category: string | null;
  sentiment: string | null;
  external_score: number | string | null;
  comments_count: number | string | null;
  published_at: string | Date | null;
  fetched_at: string | Date | null;
  role: string | null;
  similarity_score: number | string | null;
}

export interface AnalysisRow {
  id: string;
  target_type: string;
  target_id: string;
  model_provider: string | null;
  model_name: string | null;
  analysis_type: string | null;
  content: unknown;
  tokens_used: number | string | null;
  cost_estimate: number | string | null;
  created_at: string | Date | null;
}

export interface EntityRow {
  id: string;
  name: string;
  normalized_name: string;
  type: string;
  description: string | null;
  mentions_count: number | string | null;
  trend_score: number | string | null;
  first_seen_at: string | Date | null;
  last_seen_at: string | Date | null;
  latest_growth_rate: number | string | null;
  seven_day_mentions: number | string | null;
  seven_day_sources: number | string | null;
}

export interface TimelineEventRow {
  id: string;
  title: string;
  description: string | null;
  event_date: string | Date | null;
  importance: number | string | null;
  source_article_id: string | null;
}
