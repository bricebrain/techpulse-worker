export interface Env {
  DB: D1Database;
  AI: Ai;
  // Secrets (définis via `wrangler secret put`)
  YOUTUBE_API_KEY_1?: string;
  YOUTUBE_API_KEY_2?: string;
  YOUTUBE_API_KEY_3?: string;
  YOUTUBE_SEARCH_KEY_1?: string;
  YOUTUBE_SEARCH_KEY_2?: string;
  YOUTUBE_SEARCH_KEY_3?: string;
  OPENAI_API_KEY?: string;
  GROQ_API_KEY_1?: string;
  GROQ_API_KEY_2?: string;
  GROQ_TTS_KEY_1?: string;
  GROQ_TTS_KEY_2?: string;
  OPENROUTER_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  // Clé pour sécuriser les routes d'écriture depuis l'app
  API_SECRET?: string;
}

export interface Source {
  id: string;
  name: string;
  theme: string;
  type: 'rss' | 'hackernews_rss' | 'reddit_rss' | 'devto_tag' | 'youtube_channel' | 'arxiv';
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
