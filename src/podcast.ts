/**
 * Génération automatique de podcasts côté serveur.
 *
 * Deux formats :
 *   1. TechBrief quotidien (vulgarisé) — 3 articles, ~7-9 min
 *      Segments : intro → (headline + context + explanation + impact + transition) × 3 → outro
 *
 *   2. Deep Dive hebdomadaire (vendredi) — 1 sujet, ~14-16 min
 *      Segments : intro → large_context → explanation → analogie → analysis → impact → future → conclusion
 *
 * Flux commun :
 *   1. Fetch des meilleurs articles D1
 *   2. Script JSON via Groq (llama-3.3-70b)
 *   3. TTS segment par segment via OpenAI gpt-4o-mini-tts, fallback Edge-TTS
 *   4. Upload MP3 dans R2  →  podcasts/{id}/{i}.mp3
 *   5. Sauvegarde métadonnées + segments_json dans D1
 *   6. Nettoyage des podcasts > 7 jours
 */

import type { Env } from './types';
import { resolveSecrets } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SegmentType =
  | 'intro' | 'headline' | 'context' | 'explanation' | 'impact'
  | 'transition' | 'outro'
  | 'large_context' | 'analogie' | 'analysis' | 'future' | 'conclusion';

export type PodcastFormat = 'daily' | 'deep_dive';

export interface PodcastSegment {
  id: string;
  type: SegmentType;
  speaker: 'host' | 'analyst';
  text: string;
}

interface PodcastScript {
  title: string;
  segments: PodcastSegment[];
}

export interface PodcastGenerationResult {
  status: 'generated' | 'skipped' | 'failed';
  reason?: string;
  podcastId?: string | null;
  title?: string;
}

interface DbArticle {
  title: string;
  source_name: string;
  content: string | null;
  published_at: number | null;
}

// ─── Config voix ──────────────────────────────────────────────────────────────

const VOICES: Record<'host' | 'analyst', { voice: string; instructions: string }> = {
  host: {
    voice: 'alloy',
    instructions:
      'Voix sèche, enregistrement studio sans réverbération ni écho. Débit naturel et fluide, ton chaleureux et direct. Pas d\'effets acoustiques.',
  },
  analyst: {
    voice: 'onyx',
    instructions:
      'Voix sèche, enregistrement studio sans réverbération ni écho. Débit posé et précis, ton informatif et clair. Pas d\'effets acoustiques.',
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePodcastId(): string {
  return `pod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function todayFr(): string {
  return new Date().toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris',
  });
}

// ─── Fetch articles ───────────────────────────────────────────────────────────

async function fetchTopArticles(env: Env, limit: number, hoursBack: number): Promise<DbArticle[]> {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT title, source_name, content, published_at
     FROM articles
     WHERE published_at > ?
     ORDER BY published_at DESC
     LIMIT ?`,
  ).bind(cutoff, limit).all<DbArticle>();
  return results;
}

// ─── Parse script JSON généré par Groq ───────────────────────────────────────

const VALID_TYPES = new Set<string>([
  'intro', 'headline', 'context', 'explanation', 'impact',
  'transition', 'outro',
  'large_context', 'analogie', 'analysis', 'future', 'conclusion',
]);

const PODCAST_LOCK_KEY = 'podcast_generation';
const PODCAST_LOCK_TTL_MS = 45 * 60 * 1000;

async function ensureRuntimeLocksTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS runtime_locks (
      key        TEXT PRIMARY KEY,
      owner      TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_runtime_locks_expires_at ON runtime_locks(expires_at)',
  ).run();
}

async function acquireRuntimeLock(
  env: Env,
  key: string,
  ttlMs: number,
): Promise<{ acquired: boolean; owner: string; expiresAt: number }> {
  await ensureRuntimeLocksTable(env);

  const now = Date.now();
  const owner = `${key}_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = now + ttlMs;
  const updatedAt = new Date(now).toISOString();

  await env.DB.prepare(
    `INSERT INTO runtime_locks (key, owner, expires_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       owner = excluded.owner,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at
     WHERE runtime_locks.expires_at < ?`,
  ).bind(key, owner, expiresAt, updatedAt, now).run();

  const current = await env.DB.prepare(
    'SELECT owner, expires_at FROM runtime_locks WHERE key = ?',
  ).bind(key).first<{ owner: string; expires_at: number }>();

  return {
    acquired: current?.owner === owner,
    owner,
    expiresAt: current?.expires_at ?? expiresAt,
  };
}

async function releaseRuntimeLock(env: Env, key: string, owner: string): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM runtime_locks WHERE key = ? AND owner = ?',
  ).bind(key, owner).run();
}

function sanitizeForFrenchTts(value: string): string {
  return value
    .replace(/^\s*(bonjour|bonsoir|salut)\b[^.!?]*[.!?]\s*/i, '')
    .replace(/^\s*(bienvenue|merci d['’]avoir écouté|merci de nous avoir écoutés)\b[^.!?]*[.!?]\s*/i, '')
    .replace(/\bIA\b/g, 'intelligence artificielle')
    .replace(/\bAI\b/g, 'intelligence artificielle')
    .replace(/\bLLM\b/g, 'modèle de langage')
    .replace(/\bGPU\b/g, 'processeur graphique')
    .replace(/\bCPU\b/g, 'processeur')
    .replace(/\bAPI\b/g, 'A P I')
    .replace(/\bIPO\b/g, 'entrée en bourse')
    .replace(/\bCEO\b/g, 'dirigeant')
    .replace(/\bB2B\b/g, 'business to business')
    .replace(/\bB2C\b/g, 'business to consumer')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseScript(raw: string, fallbackTitle: string): PodcastScript | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      title?: string;
      segments?: Array<{ type?: string; speaker?: string; text?: string }>;
    };
    const segs = parsed.segments;
    if (!Array.isArray(segs) || segs.length < 3) return null;

    const segments: PodcastSegment[] = segs
      .filter((s) => typeof s.text === 'string' && s.text.trim().length > 10)
      .map((s, i) => ({
        id: `seg_${i}`,
        type: (VALID_TYPES.has(s.type ?? '') ? s.type : 'analysis') as SegmentType,
        speaker: 'host',
        text: sanitizeForFrenchTts(s.text ?? ''),
      }));

    if (segments.length < 3) return null;

    return {
      title: typeof parsed.title === 'string' && parsed.title.trim()
        ? parsed.title.trim()
        : fallbackTitle,
      segments,
    };
  } catch {
    return null;
  }
}

// ─── Helper LLM : DeepSeek → Gemini → OpenRouter ────────────────────────────
// DeepSeek en 1er : non partagé avec le proxy app → quota dédié podcast.

interface LLMMessage { role: 'system' | 'user'; content: string }

async function callLLM(
  env: Env,
  messages: LLMMessage[],
  maxTokens: number,
  temperature: number,
  label: string,
): Promise<string | null> {
  const { XAI_API_KEY, GROQ_API_KEY_1, GROQ_API_KEY_2, DEEPSEEK_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY } = await resolveSecrets(env);

  // 1. xAI Grok (grok-4.3) — puissant, parfait pour les scripts longs
  // Utilise /v1/chat/completions (API OpenAI-compatible, pas Responses API)
  if (XAI_API_KEY) {
    try {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${XAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'grok-4.20-0309-non-reasoning', // non-reasoning : rapide pour les longs scripts JSON
          max_tokens: maxTokens,
          temperature,
          messages,
        }),
        signal: AbortSignal.timeout(90_000), // scripts longs → timeout généreux
      });
      if (res.ok) {
        const d = await res.json<{ choices?: { message?: { content?: string } }[] }>();
        const text = d?.choices?.[0]?.message?.content ?? '';
        if (text) { console.log(`[${label}] LLM xAI Grok-4.3 ✓`); return text; }
      } else if (res.status === 429) {
        console.warn(`[${label}] xAI Grok 429 → fallback Groq`);
      } else {
        const errTxt = await res.text().catch(() => '');
        console.warn(`[${label}] xAI Grok ${res.status}: ${errTxt.slice(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[${label}] xAI Grok exception:`, e);
    }
  }

  // 2. Groq — rapide, quota élevé, quota isolé du proxy app
  const groqKey = GROQ_API_KEY_1 || GROQ_API_KEY_2;
  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: maxTokens,
          temperature,
          messages,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const d = await res.json<{ choices?: { message?: { content?: string } }[] }>();
        const text = d?.choices?.[0]?.message?.content ?? '';
        if (text) { console.log(`[${label}] LLM Groq ✓`); return text; }
      } else if (res.status === 429) {
        console.warn(`[${label}] Groq 429 → fallback DeepSeek`);
      } else {
        console.warn(`[${label}] Groq ${res.status}`);
      }
    } catch (e) {
      console.warn(`[${label}] Groq exception:`, e);
    }
  }

  // 2. DeepSeek-V3 — bon pour les longues sorties
  if (DEEPSEEK_API_KEY) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: maxTokens,
          temperature,
          messages,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const d = await res.json<{ choices?: { message?: { content?: string } }[] }>();
        const text = d?.choices?.[0]?.message?.content ?? '';
        if (text) { console.log(`[${label}] LLM DeepSeek ✓`); return text; }
      } else if (res.status === 429) {
        console.warn(`[${label}] DeepSeek 429 → fallback Gemini`);
      } else {
        console.warn(`[${label}] DeepSeek ${res.status}`);
      }
    } catch (e) {
      console.warn(`[${label}] DeepSeek exception:`, e);
    }
  }

  // 3. Gemini Flash (API OpenAI-compatible de Google)
  if (GEMINI_API_KEY) {
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${GEMINI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-2.0-flash',
            max_tokens: maxTokens,
            temperature,
            messages,
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (res.ok) {
        const d = await res.json<{ choices?: { message?: { content?: string } }[] }>();
        const text = d?.choices?.[0]?.message?.content ?? '';
        if (text) { console.log(`[${label}] LLM Gemini Flash ✓`); return text; }
      } else if (res.status === 429) {
        console.warn(`[${label}] Gemini 429 → fallback OpenRouter`);
      } else {
        const errTxt = await res.text().catch(() => '');
        console.warn(`[${label}] Gemini ${res.status}: ${errTxt.slice(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[${label}] Gemini exception:`, e);
    }
  }

  // 4. OpenRouter (modèle gratuit llama-3.3-70b)
  if (OPENROUTER_API_KEY) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://techpulse-worker.bricebrain.workers.dev',
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.3-70b-instruct:free',
          max_tokens: maxTokens,
          temperature,
          messages,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const d = await res.json<{ choices?: { message?: { content?: string } }[] }>();
        const text = d?.choices?.[0]?.message?.content ?? '';
        if (text) { console.log(`[${label}] LLM OpenRouter ✓`); return text; }
      } else {
        const errTxt = await res.text().catch(() => '');
        console.warn(`[${label}] OpenRouter ${res.status}: ${errTxt.slice(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[${label}] OpenRouter exception:`, e);
    }
  }

  console.warn(`[${label}] Tous les LLMs ont échoué (Groq+DeepSeek+Gemini+OpenRouter)`);
  return null;
}

// ─── Script quotidien vulgarisé (3 articles, ~7-9 min) ───────────────────────

async function generateDailyScript(
  articles: DbArticle[],
  env: Env,
): Promise<PodcastScript | null> {
  const { GROQ_API_KEY_1, GROQ_API_KEY_2, DEEPSEEK_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY } = await resolveSecrets(env);
  if (!GROQ_API_KEY_1 && !GROQ_API_KEY_2 && !DEEPSEEK_API_KEY && !GEMINI_API_KEY && !OPENROUTER_API_KEY) {
    console.warn('[Podcast/daily] Aucun LLM disponible (Groq/DeepSeek/Gemini/OpenRouter)');
    return null;
  }

  const top = articles.slice(0, 3);
  const articleList = top
    .map(
      (a, i) =>
        `Article ${i + 1}: "${a.title}" (${a.source_name})\nRésumé: ${(a.content ?? '').slice(0, 400).trim()}`,
    )
    .join('\n\n');

  // Construire dynamiquement les blocs de segments pour chaque article
  const articleBlocks = top.map((_, i) => {
    const notLast = i < top.length - 1;
    return (
      `    {"type":"headline","speaker":"host","text":"Titre oral en 18-24 mots pour l'article ${i + 1}. Direct, précis, sans effet radio."},\n` +
      `    {"type":"context","speaker":"host","text":"Contexte en 85-105 mots. Expliquer le décor, les acteurs et le problème. Phrases courtes."},\n` +
      `    {"type":"explanation","speaker":"host","text":"Explication en 80-95 mots. Dire ce que cela change concrètement. Une analogie maximum."},\n` +
      `    {"type":"impact","speaker":"host","text":"Impact en 65-80 mots. Pourquoi suivre ce signal, qui est touché, quel risque ou opportunité."}` +
      (notLast ? `,\n    {"type":"transition","speaker":"host","text":"Transition sobre en 12-18 mots vers le sujet suivant. Pas de formule de radio."}` : '')
    );
  }).join(',\n');

  const prompt =
    `Voici ${top.length} articles tech du jour :\n\n${articleList}\n\n` +
    `Génère une note audio TechPulse en français (~7-9 minutes) au format JSON EXACT :\n\n` +
    `{\n  "title": "TechBrief — ${todayFr()}",\n  "segments": [\n` +
    `    {"type":"intro","speaker":"host","text":"Ouverture directe en 45-55 mots. Entrer immédiatement dans les 3 signaux. Interdit de dire bonjour, bienvenue, aujourd'hui au programme, merci."},\n` +
    `${articleBlocks},\n` +
    `    {"type":"outro","speaker":"host","text":"Conclusion en 35-45 mots. Récapitulatif net des trois signaux. Pas de remerciement, pas d'appel à revenir."}\n` +
    `  ]\n}\n\n` +
    `RÈGLES :\n` +
    `- Un seul narrateur. Toujours speaker="host". Ne jamais utiliser "analyst".\n` +
    `- Ton premium, sobre, analytique. Pas d'animateur radio, pas d'humour forcé.\n` +
    `- Interdit : "bonjour", "bienvenue", "merci d'avoir écouté", "on se retrouve", "installez-vous".\n` +
    `- Écrire pour une synthèse vocale française : phrases de 8 à 18 mots, ponctuation claire, peu d'anglicismes.\n` +
    `- Déplier les acronymes : intelligence artificielle, processeur graphique, modèle de langage.\n` +
    `- Aucun markdown, JSON pur, texte naturel et fluide à l'oral.`;

  const raw = await callLLM(
    env,
    [
      {
        role: 'system',
        content:
          'Tu es un éditeur audio TechPulse. Tu écris une note de veille premium, concise, pédagogique, sans ton radio. Tu réponds UNIQUEMENT en JSON valide.',
      },
      { role: 'user', content: prompt },
    ],
    3500,
    0.75,
    'Podcast/daily',
  );
  if (!raw) return null;
  return parseScript(raw, `TechBrief — ${todayFr()}`);
}

// ─── Script Deep Dive hebdomadaire (1 sujet, ~14-16 min) ─────────────────────

async function generateDeepDiveScript(
  articles: DbArticle[],
  env: Env,
): Promise<PodcastScript | null> {
  const { GROQ_API_KEY_1, GROQ_API_KEY_2, DEEPSEEK_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY } = await resolveSecrets(env);
  if (!GROQ_API_KEY_1 && !GROQ_API_KEY_2 && !DEEPSEEK_API_KEY && !GEMINI_API_KEY && !OPENROUTER_API_KEY) {
    console.warn('[Podcast/deep_dive] Aucun LLM disponible (Groq/DeepSeek/Gemini/OpenRouter)');
    return null;
  }

  // Sujet principal : article avec le plus de contenu disponible
  const article = [...articles].sort((a, b) =>
    (b.content?.length ?? 0) - (a.content?.length ?? 0),
  )[0]!;
  const content = (article.content ?? '').slice(0, 600).trim();
  const shortTitle = article.title.slice(0, 55);

  const prompt =
    `Sujet du Deep Dive : "${article.title}" (${article.source_name})\n` +
    (content ? `Contenu disponible : ${content}\n` : '') +
    `\nGénère une analyse audio Deep Dive en français (~14-16 minutes) au format JSON EXACT :\n\n` +
    `{\n  "title": "🔬 Deep Dive : ${shortTitle}",\n  "segments": [\n` +
    `    {"type":"intro","speaker":"host","text":"Ouverture en 70-85 mots. Poser immédiatement la question centrale. Pas de salutations."},\n` +
    `    {"type":"large_context","speaker":"host","text":"Contexte et fondamentaux en 250-280 mots. Origine du sujet, acteurs, vocabulaire utile. Phrases courtes."},\n` +
    `    {"type":"explanation","speaker":"host","text":"Explication progressive en 220-250 mots. Comment cela fonctionne, étape par étape, sans jargon inutile."},\n` +
    `    {"type":"analogie","speaker":"host","text":"Analogie du quotidien en 150-180 mots. Commencer par 'Imaginez que...' ou 'C'est comme si...'."},\n` +
    `    {"type":"analysis","speaker":"host","text":"Analyse approfondie en 260-300 mots. Mécanismes clés, chiffres, tensions, limites."},\n` +
    `    {"type":"impact","speaker":"host","text":"Impacts sectoriels en 210-240 mots. Qui gagne, qui perd, effets économiques et sociaux."},\n` +
    `    {"type":"future","speaker":"host","text":"Perspectives en 190-220 mots. Scénarios à 3 ans, risques, signaux faibles à suivre."},\n` +
    `    {"type":"conclusion","speaker":"host","text":"Synthèse en 70-85 mots. Trois points à retenir. Pas de remerciement ni formule de fin radio."}\n` +
    `  ]\n}\n\n` +
    `RÈGLES ABSOLUES :\n` +
    `- Un seul narrateur. Toujours speaker="host". Ne jamais utiliser "analyst".\n` +
    `- Pédagogie par couches : chaque segment construit sur le précédent.\n` +
    `- Style premium : clair, dense, posé. Pas d'accueil, pas de conclusion bavarde.\n` +
    `- Écrire pour une synthèse vocale française : phrases de 8 à 18 mots, ponctuation claire.\n` +
    `- Déplier les acronymes et chiffres complexes pour la voix.\n` +
    `- Aucun markdown, JSON pur, texte naturel et fluide à l'oral.`;

  const raw = await callLLM(
    env,
    [
      {
        role: 'system',
        content:
          'Tu es un analyste TechPulse senior. Tu écris une analyse audio premium, claire et pédagogique, sans ton radio. Tu réponds UNIQUEMENT en JSON valide.',
      },
      { role: 'user', content: prompt },
    ],
    5000,
    0.8,
    'Podcast/deep_dive',
  );
  if (!raw) return null;
  return parseScript(raw, `🔬 Deep Dive — ${todayFr()}`);
}

// ─── TTS segment par segment ──────────────────────────────────────────────────
// Priorité : OpenAI gpt-4o-mini-tts → FastAPI Edge-TTS (Render)
// (Kokoro/RunPod retiré : qualité française insuffisante.)

async function synthesizeViaFastApi(
  segment: PodcastSegment,
  env: Env,
): Promise<ArrayBuffer | null> {
  const baseUrl = (env.REDDIT_PROXY_URL ?? '').replace(/\/$/, '');
  if (!baseUrl || !env.REDDIT_PROXY_SECRET) return null;

  try {
    const res = await fetch(`${baseUrl}/api/v1/tts/podcast-segment`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.REDDIT_PROXY_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: segment.text,
        voice: segment.speaker, // "host" | "analyst" → mappé dans edge_provider.py
        provider: 'edge_tts',
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(150_000), // 150s : warm-up Render free tier (60-120s cold start)
    });

    if (!res.ok) {
      console.warn(`[Podcast] FastAPI TTS ${segment.id} → ${res.status}`);
      return null;
    }
    return res.arrayBuffer();
  } catch (e) {
    console.warn(`[Podcast] FastAPI TTS exception ${segment.id}:`, e);
    return null;
  }
}

async function synthesizeViaOpenAI(
  segment: PodcastSegment,
  env: Env,
): Promise<ArrayBuffer | null> {
  const { OPENAI_API_KEY } = await resolveSecrets(env);
  if (!OPENAI_API_KEY) return null;

  const config = VOICES[segment.speaker];
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: config.voice,
        input: segment.text,
        instructions: config.instructions,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn(`[Podcast] OpenAI TTS ${segment.id} → ${res.status}`);
      return null;
    }
    return res.arrayBuffer();
  } catch (e) {
    console.warn(`[Podcast] OpenAI TTS exception ${segment.id}:`, e);
    return null;
  }
}

async function synthesizeSegment(
  segment: PodcastSegment,
  env: Env,
): Promise<{ buffer: ArrayBuffer; ext: 'mp3' | 'aac' } | null> {
  // Principal : OpenAI gpt-4o-mini-tts (bon français, voix + instructions de ton).
  const oaiAudio = await synthesizeViaOpenAI(segment, env);
  if (oaiAudio) {
    console.log(`[Podcast] Segment ${segment.id} → OpenAI gpt-4o-mini-tts ✓`);
    return { buffer: oaiAudio, ext: 'mp3' };
  }

  // Fallback : Edge-TTS via FastAPI (Render).
  console.warn(`[Podcast] Fallback Edge-TTS pour ${segment.id}`);
  const edgeAudio = await synthesizeViaFastApi(segment, env);
  if (edgeAudio) {
    console.log(`[Podcast] Segment ${segment.id} → Edge-TTS ✓`);
    return { buffer: edgeAudio, ext: 'mp3' };
  }

  return null;
}

// ─── Upload R2 + sauvegarde D1 ────────────────────────────────────────────────

async function uploadAndSave(
  script: PodcastScript,
  format: PodcastFormat,
  env: Env,
): Promise<string | null> {
  const id = makePodcastId();
  const generatedAt = Date.now();
  let uploaded = 0;

  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i]!;
    const result = await synthesizeSegment(seg, env);
    if (!result) continue;

    const { buffer, ext } = result;
    const contentType = ext === 'mp3' ? 'audio/mpeg' : 'audio/aac';
    await env.PODCASTS!.put(`podcasts/${id}/${i}.${ext}`, buffer, {
      httpMetadata: { contentType },
    });
    uploaded++;
    console.log(
      `[Podcast/${format}] Segment ${i + 1}/${script.segments.length} OK — ${ext.toUpperCase()} (${Math.round(buffer.byteLength / 1024)}KB)`,
    );
  }

  if (uploaded < Math.ceil(script.segments.length * 0.5)) {
    console.warn(
      `[Podcast/${format}] Trop peu de segments audio (${uploaded}/${script.segments.length}) — non sauvegardé`,
    );
    return null;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO podcast_feed (id, title, theme, format, generated_at, segment_count, segments_json, is_ready, created_at)
     VALUES (?, ?, 'general', ?, ?, ?, ?, 1, ?)`,
  ).bind(
    id,
    script.title,
    format,
    generatedAt,
    script.segments.length,
    JSON.stringify(script.segments),
    now,
  ).run();

  console.log(
    `[Podcast/${format}] ✓ Sauvegardé : ${id} (${uploaded}/${script.segments.length} segments)`,
  );
  return id;
}

// ─── Nettoyage des podcasts > 7 jours ────────────────────────────────────────

async function cleanupOldPodcasts(env: Env): Promise<void> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const { results: old } = await env.DB.prepare(
    'SELECT id, segment_count FROM podcast_feed WHERE generated_at < ?',
  ).bind(cutoff).all<{ id: string; segment_count: number }>();

  for (const pod of old) {
    // Supprimer toutes les extensions possibles (wav / aac / mp3)
    const exts = ['wav', 'aac', 'mp3'];
    const keys = exts.flatMap((ext) =>
      Array.from({ length: pod.segment_count }, (_, i) => `podcasts/${pod.id}/${i}.${ext}`),
    );
    if (keys.length > 0) await env.PODCASTS?.delete(keys);
    await env.DB.prepare('DELETE FROM podcast_feed WHERE id = ?').bind(pod.id).run();
  }

  if (old.length > 0) {
    console.log(`[Podcast] ${old.length} ancien(s) nettoyé(s)`);
  }
}

// ─── Push notification ────────────────────────────────────────────────────────

async function notifyPodcastReady(env: Env, title: string, format: 'daily' | 'deep_dive'): Promise<void> {
  if (!env.DB) return;
  const { results: devices } = await env.DB.prepare('SELECT token FROM devices').all<{ token: string }>();
  if (!devices.length) return;

  const isDeepDive = format === 'deep_dive';
  const messages = devices.map((d) => ({
    to: d.token,
    title: isDeepDive ? '🔬 Deep Dive disponible' : '🎙 TechBrief du jour',
    body: title,
    data: { type: 'podcast', format },
    channelId: 'alerts',
  }));

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => console.warn('[Push/Podcast] Erreur:', e));

  console.log(`[Push/Podcast] ${messages.length} notification(s) envoyée(s) : "${title}"`);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * TechBrief quotidien vulgarisé — ~7-9 min, 3 articles.
 * Cron : 0 6 * * * (chaque jour à 6h UTC)
 */
export async function generateDailyPodcast(env: Env): Promise<PodcastGenerationResult> {
  console.log('[Podcast] Démarrage TechBrief quotidien…');

  const lock = await acquireRuntimeLock(env, PODCAST_LOCK_KEY, PODCAST_LOCK_TTL_MS);
  if (!lock.acquired) {
    const waitMin = Math.max(1, Math.ceil((lock.expiresAt - Date.now()) / 60000));
    console.warn(`[Podcast] Génération déjà en cours — TechBrief ignoré (expiration dans ~${waitMin} min)`);
    return { status: 'skipped', reason: 'podcast_generation_already_running' };
  }

  try {
    if (!env.PODCASTS) {
      console.warn('[Podcast] R2 bucket PODCASTS non configuré — abandon');
      return { status: 'failed', reason: 'missing_r2_bucket' };
    }

    const { OPENAI_API_KEY: openaiKeyDaily } = await resolveSecrets(env);
    const hasRunPod = !!(env.RUNPOD_API_KEY && env.RUNPOD_AI_ENDPOINT_ID);
    const hasFastApi = !!(env.REDDIT_PROXY_URL && env.REDDIT_PROXY_SECRET);
    const hasOpenAI = !!openaiKeyDaily;
    if (!hasRunPod && !hasFastApi && !hasOpenAI) {
      console.warn('[Podcast] Aucun provider TTS disponible (RunPod/FastAPI/OpenAI) — abandon');
      return { status: 'failed', reason: 'missing_tts_provider' };
    }
    console.log(`[Podcast] TTS providers disponibles : ${[hasRunPod && 'RunPod-Kokoro', hasFastApi && 'Edge-TTS', hasOpenAI && 'OpenAI'].filter(Boolean).join(', ')}`);

    // Warm-up Render en parallèle : on pinge le vrai endpoint TTS (pas juste "/")
    // pour forcer le chargement complet d'edge-tts avant les segments réels.
    // Free tier cold start = 60-120s ; le LLM prend ~20-40s → on part en même temps.
    if (hasFastApi) {
      const warmupUrl = (env.REDDIT_PROXY_URL ?? '').replace(/\/$/, '');
      fetch(`${warmupUrl}/api/v1/tts/podcast-segment`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.REDDIT_PROXY_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Bonjour.', voice: 'host', provider: 'edge_tts', response_format: 'mp3' }),
        signal: AbortSignal.timeout(120_000),
      })
        .then((r) => console.log(`[Podcast] FastAPI warm-up TTS ✓ (${r.status})`))
        .catch(() => console.warn('[Podcast] FastAPI warm-up TTS timeout — fallback OpenAI probable'));
    }

    const articles = await fetchTopArticles(env, 20, 24);
    if (articles.length < 3) {
      console.log(`[Podcast] Seulement ${articles.length} articles frais — TechBrief annulé`);
      return { status: 'skipped', reason: 'not_enough_fresh_articles' };
    }
    console.log(`[Podcast/daily] ${articles.length} articles disponibles`);

    const script = await generateDailyScript(articles, env);
    if (!script) {
      console.warn('[Podcast/daily] Échec génération script');
      return { status: 'failed', reason: 'script_generation_failed' };
    }
    console.log(`[Podcast/daily] Script OK : "${script.title}" (${script.segments.length} segments)`);

    const podcastId = await uploadAndSave(script, 'daily', env);
    if (!podcastId) {
      return { status: 'failed', reason: 'audio_upload_failed' };
    }
    await notifyPodcastReady(env, script.title, 'daily');
    await cleanupOldPodcasts(env);
    return { status: 'generated', podcastId, title: script.title };
  } finally {
    await releaseRuntimeLock(env, PODCAST_LOCK_KEY, lock.owner)
      .catch((error) => console.warn('[Podcast] Impossible de libérer le verrou:', error));
  }
}

/**
 * Deep Dive hebdomadaire pédagogique — ~14-16 min, 1 sujet approfondi.
 * Cron : 0 6 * * 5 (vendredi à 6h UTC)
 */
export async function generateDeepDivePodcast(env: Env): Promise<PodcastGenerationResult> {
  console.log('[Podcast] Démarrage Deep Dive hebdomadaire…');

  const lock = await acquireRuntimeLock(env, PODCAST_LOCK_KEY, PODCAST_LOCK_TTL_MS);
  if (!lock.acquired) {
    const waitMin = Math.max(1, Math.ceil((lock.expiresAt - Date.now()) / 60000));
    console.warn(`[Podcast] Génération déjà en cours — Deep Dive ignoré (expiration dans ~${waitMin} min)`);
    return { status: 'skipped', reason: 'podcast_generation_already_running' };
  }

  try {
    if (!env.PODCASTS) {
      console.warn('[Podcast] R2 bucket PODCASTS non configuré — abandon');
      return { status: 'failed', reason: 'missing_r2_bucket' };
    }

    const { OPENAI_API_KEY: openaiKeyDeepDive } = await resolveSecrets(env);
    const hasRunPod = !!(env.RUNPOD_API_KEY && env.RUNPOD_AI_ENDPOINT_ID);
    const hasFastApi = !!(env.REDDIT_PROXY_URL && env.REDDIT_PROXY_SECRET);
    const hasOpenAI = !!openaiKeyDeepDive;
    if (!hasRunPod && !hasFastApi && !hasOpenAI) {
      console.warn('[Podcast] Aucun provider TTS disponible — abandon');
      return { status: 'failed', reason: 'missing_tts_provider' };
    }

    // Warm-up Render : pinger le vrai endpoint TTS pour forcer le chargement d'edge-tts
    if (hasFastApi) {
      const warmupUrl = (env.REDDIT_PROXY_URL ?? '').replace(/\/$/, '');
      fetch(`${warmupUrl}/api/v1/tts/podcast-segment`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.REDDIT_PROXY_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Bonjour.', voice: 'host', provider: 'edge_tts', response_format: 'mp3' }),
        signal: AbortSignal.timeout(120_000),
      })
        .then((r) => console.log(`[Podcast/deep_dive] FastAPI warm-up TTS ✓ (${r.status})`))
        .catch(() => console.warn('[Podcast/deep_dive] FastAPI warm-up TTS timeout'));
    }

    // Articles de la semaine pour choisir le sujet le plus riche
    const articles = await fetchTopArticles(env, 50, 7 * 24);
    if (articles.length < 1) {
      console.log('[Podcast] Aucun article cette semaine — Deep Dive annulé');
      return { status: 'skipped', reason: 'not_enough_fresh_articles' };
    }
    console.log(`[Podcast/deep_dive] ${articles.length} articles candidats`);

    const script = await generateDeepDiveScript(articles, env);
    if (!script) {
      console.warn('[Podcast/deep_dive] Échec génération script');
      return { status: 'failed', reason: 'script_generation_failed' };
    }
    console.log(`[Podcast/deep_dive] Script OK : "${script.title}" (${script.segments.length} segments)`);

    const podcastId = await uploadAndSave(script, 'deep_dive', env);
    if (!podcastId) {
      return { status: 'failed', reason: 'audio_upload_failed' };
    }
    await notifyPodcastReady(env, script.title, 'deep_dive');
    // Le cleanup est fait par generateDailyPodcast — pas besoin de le doubler le vendredi
    return { status: 'generated', podcastId, title: script.title };
  } finally {
    await releaseRuntimeLock(env, PODCAST_LOCK_KEY, lock.owner)
      .catch((error) => console.warn('[Podcast] Impossible de libérer le verrou:', error));
  }
}
