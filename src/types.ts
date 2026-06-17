/** Secret issu du Cloudflare Secrets Store — accès async via .get() */
interface SecretsStoreSecret {
  get(): Promise<string>;
}

type SecretBinding = string | SecretsStoreSecret | undefined;

/** Clés API résolues (plain strings) pour passer aux helpers */
export interface ResolvedSecrets {
  OPENAI_API_KEY: string;
  OPENROUTER_API_KEY: string;
  GEMINI_API_KEY: string;
  GROQ_API_KEY_1: string;
  GROQ_API_KEY_2: string;
  DEEPSEEK_API_KEY: string;
  XAI_API_KEY: string;
}

/**
 * Résout toutes les clés du Secrets Store en parallèle.
 * À appeler une seule fois en tête de chaque handler/cron qui en a besoin.
 */
let resolvedSecretsCache: Promise<ResolvedSecrets> | null = null;

export async function resolveSecrets(env: Env): Promise<ResolvedSecrets> {
  if (resolvedSecretsCache) return resolvedSecretsCache;

  resolvedSecretsCache = resolveSecretsOnce(env).catch((error) => {
    resolvedSecretsCache = null;
    throw error;
  });
  return resolvedSecretsCache;
}

async function resolveSecretsOnce(env: Env): Promise<ResolvedSecrets> {
  const [openai, openrouter, gemini, groq1, groq2, deepseek, xai] = await Promise.all([
    readSecret(env.OPENAI_API_KEY, 'OPENAI_API_KEY'),
    readSecret(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY'),
    readSecret(env.GEMINI_API_KEY, 'GEMINI_API_KEY'),
    readSecret(env.GROQ_API_KEY_1, 'GROQ_API_KEY_1'),
    readSecret(env.GROQ_API_KEY_2, 'GROQ_API_KEY_2'),
    readSecret(env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY'),
    readSecret(env.XAI_API_KEY, 'XAI_API_KEY'),
  ]);
  return {
    OPENAI_API_KEY: openai,
    OPENROUTER_API_KEY: openrouter,
    GEMINI_API_KEY: gemini,
    GROQ_API_KEY_1: groq1,
    GROQ_API_KEY_2: groq2,
    DEEPSEEK_API_KEY: deepseek,
    XAI_API_KEY: xai,
  };
}

async function readSecret(binding: SecretBinding, name: string): Promise<string> {
  if (!binding) return '';
  if (typeof binding === 'string') return binding;
  if (typeof binding.get !== 'function') return '';
  try {
    return await binding.get();
  } catch (error) {
    console.warn(`[Secrets] ${name} indisponible: ${String(error)}`);
    return '';
  }
}

export interface Env {
  DB: D1Database;
  AI: Ai;
  // Cloudflare Secrets Store — partagés entre workers (accès async via .get())
  OPENAI_API_KEY?: SecretBinding;
  OPENROUTER_API_KEY?: SecretBinding;
  GEMINI_API_KEY?: SecretBinding;
  GROQ_API_KEY_1?: SecretBinding;
  GROQ_API_KEY_2?: SecretBinding;
  DEEPSEEK_API_KEY?: SecretBinding;
  XAI_API_KEY?: SecretBinding;
  // Secrets spécifiques TechPulse (wrangler secret put)
  YOUTUBE_API_KEY_1?: string;
  YOUTUBE_API_KEY_2?: string;
  YOUTUBE_API_KEY_3?: string;
  YOUTUBE_SEARCH_KEY_1?: string;
  YOUTUBE_SEARCH_KEY_2?: string;
  YOUTUBE_SEARCH_KEY_3?: string;
  GROQ_TTS_KEY_1?: string;
  GROQ_TTS_KEY_2?: string;
  API_SECRET?: string;
  HF_TOKEN?: string;
  REDDIT_PROXY_URL?: string;
  REDDIT_PROXY_SECRET?: string;
  RUNPOD_API_KEY?: string;
  RUNPOD_AI_ENDPOINT_ID?: string;
  NEON_DATABASE_URL?: string;
  PODCASTS?: R2Bucket;
}

export interface Source {
  id: string;
  name: string;
  theme: string;
  type: 'rss' | 'hackernews_rss' | 'reddit_rss' | 'devto_tag' | 'youtube_channel' | 'arxiv' | 'grok_live';
  value: string;
  limit_count: number;
  is_active: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface Article {
  hash: string;
  theme: string;
  title: string;
  source_name: string;
  url: string | null;
  content: string | null;
  published_at: number | null;
  fetched_at: number;
}
