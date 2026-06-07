import { neon } from '@neondatabase/serverless';
import type { NeonQueryFunction } from '@neondatabase/serverless';

import type { Env } from './types';
import { err, json } from './utils';

type Sql = NeonQueryFunction<false, false>;

interface CountRow {
  label: string;
  n: number | string | null;
}

function asNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function rows<T>(query: Promise<unknown>): Promise<T[]> {
  return (await query) as T[];
}

async function getArticleStatus(sql: Sql) {
  const [summary] = await rows<{
    total: number | string;
    missing_full_text: number | string;
    missing_embedding: number | string;
    extraction_failed: number | string;
    embedding_failed: number | string;
    stale_discovered: number | string;
  }>(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE full_text IS NULL) AS missing_full_text,
      COUNT(*) FILTER (WHERE embedding IS NULL) AS missing_embedding,
      COUNT(*) FILTER (WHERE extraction_status = 'failed') AS extraction_failed,
      COUNT(*) FILTER (WHERE embedding_status = 'failed') AS embedding_failed,
      COUNT(*) FILTER (
        WHERE COALESCE(pipeline_status, status) IN ('discovered', 'new')
          AND fetched_at < NOW() - INTERVAL '24 hours'
      ) AS stale_discovered
    FROM articles
  `);

  const [
    pipelineStatus,
    extractionStatus,
    embeddingStatus,
    clusteringStatus,
    analysisStatus,
    recentErrors,
  ] = await Promise.all([
    rows<CountRow>(sql`
      SELECT COALESCE(pipeline_status, status, 'unknown') AS label, COUNT(*) AS n
      FROM articles
      GROUP BY 1
      ORDER BY n DESC
    `),
    rows<CountRow>(sql`
      SELECT COALESCE(extraction_status, 'unknown') AS label, COUNT(*) AS n
      FROM articles
      GROUP BY 1
      ORDER BY n DESC
    `),
    rows<CountRow>(sql`
      SELECT COALESCE(embedding_status, 'unknown') AS label, COUNT(*) AS n
      FROM articles
      GROUP BY 1
      ORDER BY n DESC
    `),
    rows<CountRow>(sql`
      SELECT COALESCE(clustering_status, 'unknown') AS label, COUNT(*) AS n
      FROM articles
      GROUP BY 1
      ORDER BY n DESC
    `),
    rows<CountRow>(sql`
      SELECT COALESCE(analysis_status, 'unknown') AS label, COUNT(*) AS n
      FROM articles
      GROUP BY 1
      ORDER BY n DESC
    `),
    rows(sql`
      SELECT id, title, source_name, pipeline_status, last_error, last_processed_at
      FROM articles
      WHERE last_error IS NOT NULL
      ORDER BY last_processed_at DESC NULLS LAST, fetched_at DESC
      LIMIT 10
    `),
  ]);

  const mapCounts = (items: CountRow[]) => items.map((item) => ({
    label: item.label,
    count: asNumber(item.n),
  }));

  return {
    total: asNumber(summary?.total),
    missing_full_text: asNumber(summary?.missing_full_text),
    missing_embedding: asNumber(summary?.missing_embedding),
    extraction_failed: asNumber(summary?.extraction_failed),
    embedding_failed: asNumber(summary?.embedding_failed),
    stale_discovered: asNumber(summary?.stale_discovered),
    pipeline_status: mapCounts(pipelineStatus),
    extraction_status: mapCounts(extractionStatus),
    embedding_status: mapCounts(embeddingStatus),
    clustering_status: mapCounts(clusteringStatus),
    analysis_status: mapCounts(analysisStatus),
    recent_errors: recentErrors,
  };
}

async function getClusterStatus(sql: Sql) {
  const [summary] = await rows<{
    total: number | string;
    active: number | string;
    multi_article: number | string;
    singleton: number | string;
    avg_article_count: number | string | null;
  }>(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status IN ('active', 'growing', 'peak')) AS active,
      COUNT(*) FILTER (WHERE article_count >= 2) AS multi_article,
      COUNT(*) FILTER (WHERE article_count = 1) AS singleton,
      AVG(article_count)::float AS avg_article_count
    FROM clusters
  `);

  return {
    total: asNumber(summary?.total),
    active: asNumber(summary?.active),
    multi_article: asNumber(summary?.multi_article),
    singleton: asNumber(summary?.singleton),
    avg_article_count: asNumber(summary?.avg_article_count),
  };
}

async function getPipelineRuns(sql: Sql) {
  const [summary] = await rows<{
    running: number | string;
    failed_24h: number | string;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'running') AS running,
      COUNT(*) FILTER (
        WHERE status = 'failed'
          AND started_at >= NOW() - INTERVAL '24 hours'
      ) AS failed_24h
    FROM pipeline_runs
  `);

  const latest = await rows(sql`
    SELECT id, pipeline_type, status, started_at, completed_at,
           duration_seconds, articles_fetched, articles_embedded,
           clusters_created, clusters_updated, analyses_generated, errors
    FROM pipeline_runs
    ORDER BY started_at DESC
    LIMIT 8
  `);

  return {
    running: asNumber(summary?.running),
    failed_24h: asNumber(summary?.failed_24h),
    latest,
  };
}

async function getPipelineJobs(sql: Sql) {
  try {
    const byStatus = await rows<CountRow>(sql`
      SELECT status AS label, COUNT(*) AS n
      FROM pipeline_jobs
      GROUP BY status
      ORDER BY n DESC
    `);
    const latestFailed = await rows(sql`
      SELECT id, run_id, job_type, target_type, target_id, attempts,
             error_message, updated_at, completed_at
      FROM pipeline_jobs
      WHERE status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 10
    `);

    return {
      ready: true,
      by_status: byStatus.map((item) => ({ label: item.label, count: asNumber(item.n) })),
      latest_failed: latestFailed,
    };
  } catch (error) {
    return {
      ready: false,
      by_status: [],
      latest_failed: [],
      error: String(error).slice(0, 300),
    };
  }
}

export async function getNeonAdminStatus(env: Env): Promise<Response> {
  if (!env.NEON_DATABASE_URL) {
    return err('NEON_DATABASE_URL non configuré', 503);
  }

  const sql = neon(env.NEON_DATABASE_URL);
  const generatedAt = new Date().toISOString();

  try {
    const [articles, clusters, pipeline_runs, jobs] = await Promise.all([
      getArticleStatus(sql),
      getClusterStatus(sql),
      getPipelineRuns(sql),
      getPipelineJobs(sql),
    ]);

    const ok = articles.embedding_failed === 0
      && articles.stale_discovered < 25
      && pipeline_runs.failed_24h === 0;

    return json({
      ok,
      generated_at: generatedAt,
      neon_configured: true,
      observability_ready: true,
      articles,
      clusters,
      pipeline_runs,
      jobs,
    });
  } catch (error) {
    return json({
      ok: false,
      generated_at: generatedAt,
      neon_configured: true,
      observability_ready: false,
      error: String(error).slice(0, 500),
    }, 200);
  }
}
