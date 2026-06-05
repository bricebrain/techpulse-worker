import type { Env } from './types';

const HF_EMBEDDING_MODEL = 'ibm-granite/granite-embedding-97m-multilingual-r2';
const WORKERS_AI_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const FRESH_UNCLASSIFIED_WINDOW_MS = 2 * 60 * 60 * 1000;
const ARTICLE_EMBED_BATCH_SIZE = 16;
const STORY_CLUSTER_THRESHOLD = 0.83;

interface ArticleEmbeddingRow {
  article_hash: string;
  model: string;
  embedding_json: string;
}

export interface SemanticSearchArticleResult {
  hash: string;
  theme: string;
  classified_theme: string | null;
  title: string;
  title_fr: string | null;
  source_name: string;
  url: string | null;
  content: string | null;
  summary_fr: string | null;
  published_at: number | null;
  semantic_score: number;
}

type ArticleSearchCandidate = Omit<SemanticSearchArticleResult, 'semantic_score'>;

export interface SemanticStoryCluster {
  id: string;
  title: string;
  snippet: string;
  theme: string;
  published_at: number | null;
  article_count: number;
  source_count: number;
  representative_hash: string;
  sources: string[];
  articles: Array<{
    hash: string;
    title: string;
    title_fr: string | null;
    source_name: string;
    theme: string;
    published_at: number | null;
    url: string | null;
  }>;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  const max = Math.min(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    dot += a[index]! * b[index]!;
    magnitudeA += a[index]! * a[index]!;
    magnitudeB += b[index]! * b[index]!;
  }

  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  return denominator === 0 ? 0 : dot / denominator;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildArticleSearchText(article: ArticleSearchCandidate): string {
  return [
    article.title_fr ?? article.title,
    article.summary_fr ?? article.content ?? '',
    article.source_name,
    article.classified_theme ?? article.theme,
  ]
    .join('. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dimension = vectors[0]?.length ?? 0;
  const sums = new Array<number>(dimension).fill(0);

  for (const vector of vectors) {
    for (let index = 0; index < dimension; index += 1) {
      sums[index] = (sums[index] ?? 0) + (vector[index] ?? 0);
    }
  }

  return sums.map((value) => value / vectors.length);
}

async function ensureEmbeddingTable(env: Env): Promise<void> {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS article_embeddings (
      article_hash TEXT PRIMARY KEY NOT NULL,
      model TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_article_embeddings_updated_at
    ON article_embeddings(updated_at);
  `);
}

async function embedWithHuggingFace(texts: string[], env: Env): Promise<number[][] | null> {
  if (!env.HF_TOKEN) return null;

  try {
    const res = await fetch(
      `https://router.huggingface.co/hf-inference/models/${HF_EMBEDDING_MODEL}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.HF_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: texts,
          normalize: true,
          truncate: true,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!res.ok) {
      console.warn(`[SemanticSearch] HF embeddings ${res.status}`);
      return null;
    }

    const data = await res.json() as number[][] | number[];
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return data as number[][];
    }
    if (Array.isArray(data) && typeof data[0] === 'number') {
      return [data as number[]];
    }
    return null;
  } catch (error) {
    console.warn('[SemanticSearch] HF embeddings error:', error);
    return null;
  }
}

async function embedWithWorkersAi(texts: string[], env: Env): Promise<number[][] | null> {
  try {
    const result = await (env.AI.run as Function)(WORKERS_AI_EMBEDDING_MODEL, { text: texts });
    return (result as { data?: number[][] }).data ?? null;
  } catch (error) {
    console.warn('[SemanticSearch] Workers AI embeddings error:', error);
    return null;
  }
}

async function embedTexts(texts: string[], env: Env): Promise<{ vectors: number[][] | null; provider: 'huggingface' | 'workers-ai' | null; model: string | null }> {
  if (texts.length === 0) return { vectors: [], provider: null, model: null };

  const hfVectors = await embedWithHuggingFace(texts, env);
  if (hfVectors && hfVectors.length === texts.length) {
    return { vectors: hfVectors, provider: 'huggingface', model: HF_EMBEDDING_MODEL };
  }

  const workersAiVectors = await embedWithWorkersAi(texts, env);
  if (workersAiVectors && workersAiVectors.length === texts.length) {
    return { vectors: workersAiVectors, provider: 'workers-ai', model: WORKERS_AI_EMBEDDING_MODEL };
  }

  return { vectors: null, provider: null, model: null };
}

async function loadStoredEmbeddings(hashes: string[], env: Env): Promise<Map<string, number[]>> {
  if (hashes.length === 0) return new Map();

  const rows: ArticleEmbeddingRow[] = [];
  for (const group of chunk(hashes, 50)) {
    const placeholders = group.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT article_hash, model, embedding_json
       FROM article_embeddings
       WHERE article_hash IN (${placeholders})`
    ).bind(...group).all<ArticleEmbeddingRow>();
    rows.push(...results);
  }

  return new Map(
    rows.flatMap((row) => {
      try {
        const vector = JSON.parse(row.embedding_json) as number[];
        if (!Array.isArray(vector) || vector.length === 0) return [];
        return [[row.article_hash, vector] as const];
      } catch {
        return [];
      }
    }),
  );
}

async function saveEmbeddings(items: Array<{ hash: string; embedding: number[]; model: string }>, env: Env): Promise<void> {
  if (items.length === 0) return;

  const now = Date.now();
  const statements = items.map((item) =>
    env.DB.prepare(
      `INSERT INTO article_embeddings (article_hash, model, embedding_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(article_hash) DO UPDATE SET
         model = excluded.model,
         embedding_json = excluded.embedding_json,
         updated_at = excluded.updated_at`
    ).bind(item.hash, item.model, JSON.stringify(item.embedding), now),
  );

  await env.DB.batch(statements);
}

async function ensureArticleEmbeddings(
  articles: ArticleSearchCandidate[],
  env: Env,
): Promise<{ embeddings: Map<string, number[]>; provider: 'huggingface' | 'workers-ai' | null; model: string | null }> {
  const hashes = articles.map((article) => article.hash);
  const stored = await loadStoredEmbeddings(hashes, env);
  const missing = articles.filter((article) => !stored.has(article.hash));

  if (missing.length === 0) {
    return { embeddings: stored, provider: null, model: null };
  }

  let lastProvider: 'huggingface' | 'workers-ai' | null = null;
  let lastModel: string | null = null;

  for (const batch of chunk(missing, ARTICLE_EMBED_BATCH_SIZE)) {
    const texts = batch.map(buildArticleSearchText);
    const embedded = await embedTexts(texts, env);
    if (!embedded.vectors || !embedded.model) continue;

    lastProvider = embedded.provider;
    lastModel = embedded.model;

    const itemsToSave = batch.map((article, index) => ({
      hash: article.hash,
      embedding: embedded.vectors![index]!,
      model: embedded.model!,
    }));

    for (const item of itemsToSave) {
      stored.set(item.hash, item.embedding);
    }

    await saveEmbeddings(itemsToSave, env);
  }

  return { embeddings: stored, provider: lastProvider, model: lastModel };
}

async function loadSemanticCandidates(
  env: Env,
  limit: number,
  windowMs = RECENT_WINDOW_MS,
): Promise<ArticleSearchCandidate[]> {
  const cutoff = Date.now() - windowMs;
  const freshCutoff = Date.now() - FRESH_UNCLASSIFIED_WINDOW_MS;

  const { results } = await env.DB.prepare(
    `SELECT hash, theme, classified_theme, title, title_fr, source_name, url, content, summary_fr, published_at
     FROM articles
     WHERE published_at > ?
       AND (classified_theme IS NOT NULL OR fetched_at > ?)
     ORDER BY published_at DESC, fetched_at DESC
     LIMIT ?`
  ).bind(cutoff, freshCutoff, limit).all<ArticleSearchCandidate>();

  return results;
}

export async function semanticSearchArticles(
  query: string,
  env: Env,
  limit = 20,
): Promise<{ articles: SemanticSearchArticleResult[]; provider: 'huggingface' | 'workers-ai' | null; model: string | null }> {
  await ensureEmbeddingTable(env);

  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2) {
    return { articles: [], provider: null, model: null };
  }

  const candidates = await loadSemanticCandidates(env, Math.max(limit * 6, 120));
  if (candidates.length === 0) {
    return { articles: [], provider: null, model: null };
  }

  const queryEmbedding = await embedTexts([normalizedQuery], env);
  if (!queryEmbedding.vectors?.[0]) {
    return { articles: [], provider: queryEmbedding.provider, model: queryEmbedding.model };
  }

  const prepared = await ensureArticleEmbeddings(candidates, env);
  const queryVector = queryEmbedding.vectors[0];
  const provider = queryEmbedding.provider ?? prepared.provider;
  const model = queryEmbedding.model ?? prepared.model;

  const scored = candidates
    .map((article) => {
      const embedding = prepared.embeddings.get(article.hash);
      if (!embedding) return null;

      const score = cosine(queryVector, embedding);
      return {
        ...article,
        semantic_score: Number(score.toFixed(6)),
      };
    })
    .filter((article): article is SemanticSearchArticleResult => Boolean(article))
    .sort((left, right) => {
      if (right.semantic_score !== left.semantic_score) {
        return right.semantic_score - left.semantic_score;
      }
      return (right.published_at ?? 0) - (left.published_at ?? 0);
    })
    .slice(0, limit);

  return { articles: scored, provider, model };
}

export async function buildSemanticStoryClusters(
  env: Env,
  options?: { limit?: number; hours?: number; maxArticlesPerStory?: number },
): Promise<{ stories: SemanticStoryCluster[]; provider: 'huggingface' | 'workers-ai' | null; model: string | null }> {
  await ensureEmbeddingTable(env);

  const hours = Math.max(6, Math.min(options?.hours ?? 72, 24 * 14));
  const limit = Math.max(3, Math.min(options?.limit ?? 8, 20));
  const maxArticlesPerStory = Math.max(2, Math.min(options?.maxArticlesPerStory ?? 5, 8));

  const candidates = await loadSemanticCandidates(
    env,
    Math.max(limit * maxArticlesPerStory * 3, 120),
    hours * 60 * 60 * 1000,
  );
  if (candidates.length === 0) {
    return { stories: [], provider: null, model: null };
  }

  const prepared = await ensureArticleEmbeddings(candidates, env);
  const clusters: Array<{
    centroid: number[];
    items: Array<{ article: ArticleSearchCandidate; embedding: number[] }>;
  }> = [];

  const sortedCandidates = [...candidates].sort((left, right) => (right.published_at ?? 0) - (left.published_at ?? 0));

  for (const article of sortedCandidates) {
    const embedding = prepared.embeddings.get(article.hash);
    if (!embedding) continue;

    let bestClusterIndex = -1;
    let bestScore = -1;

    for (let index = 0; index < clusters.length; index += 1) {
      const score = cosine(embedding, clusters[index]!.centroid);
      if (score >= STORY_CLUSTER_THRESHOLD && score > bestScore) {
        bestClusterIndex = index;
        bestScore = score;
      }
    }

    if (bestClusterIndex === -1) {
      clusters.push({
        centroid: embedding,
        items: [{ article, embedding }],
      });
      continue;
    }

    const cluster = clusters[bestClusterIndex]!;
    cluster.items.push({ article, embedding });
    cluster.centroid = averageVectors(cluster.items.map((item) => item.embedding));
  }

  const stories = clusters
    .filter((cluster) => cluster.items.length > 0)
    .map((cluster, index) => {
      const items = cluster.items
        .sort((left, right) => (right.article.published_at ?? 0) - (left.article.published_at ?? 0))
        .slice(0, maxArticlesPerStory);
      const lead = items[0]!.article;
      const sources = Array.from(new Set(items.map((item) => item.article.source_name)));

      return {
        id: `story_${lead.hash}_${index}`,
        title: lead.title_fr ?? lead.title,
        snippet: (lead.summary_fr ?? lead.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
        theme: lead.classified_theme ?? lead.theme,
        published_at: lead.published_at ?? null,
        article_count: cluster.items.length,
        source_count: sources.length,
        representative_hash: lead.hash,
        sources,
        articles: items.map(({ article }) => ({
          hash: article.hash,
          title: article.title,
          title_fr: article.title_fr,
          source_name: article.source_name,
          theme: article.classified_theme ?? article.theme,
          published_at: article.published_at ?? null,
          url: article.url ?? null,
        })),
      } satisfies SemanticStoryCluster;
    })
    .sort((left, right) => {
      if (right.article_count !== left.article_count) return right.article_count - left.article_count;
      return (right.published_at ?? 0) - (left.published_at ?? 0);
    })
    .slice(0, limit);

  return {
    stories,
    provider: prepared.provider,
    model: prepared.model,
  };
}
