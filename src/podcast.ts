/**
 * Génération automatique de podcasts côté serveur.
 *
 * Deux formats :
 *   1. TechBrief quotidien (vulgarisé) — 3 articles, ~10-12 min
 *      Segments : intro → (headline + context + explanation + impact + transition) × 3 → outro
 *
 *   2. Deep Dive hebdomadaire (vendredi) — 1 sujet, ~18-20 min
 *      Segments : intro → large_context → explanation → analogie → analysis → impact → future → conclusion
 *
 * Flux commun :
 *   1. Fetch des meilleurs articles D1
 *   2. Script JSON via Groq (llama-3.3-70b)
 *   3. TTS segment par segment via OpenAI gpt-4o-mini-tts
 *   4. Upload MP3 dans R2  →  podcasts/{id}/{i}.mp3
 *   5. Sauvegarde métadonnées + segments_json dans D1
 *   6. Nettoyage des podcasts > 7 jours
 */

import type { Env } from './types';

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
        speaker: (s.speaker === 'analyst' ? 'analyst' : 'host') as PodcastSegment['speaker'],
        text: (s.text ?? '').trim(),
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
  // 1. DeepSeek-V3 — quota isolé (pas utilisé par le proxy app)
  if (env.DEEPSEEK_API_KEY) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
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

  // 2. Gemini Flash (API OpenAI-compatible de Google)
  if (env.GEMINI_API_KEY) {
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.GEMINI_API_KEY}`, 'Content-Type': 'application/json' },
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
  if (env.OPENROUTER_API_KEY) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
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

  console.warn(`[${label}] Tous les LLMs ont échoué (DeepSeek+Gemini+OpenRouter)`);
  return null;
}

// ─── Script quotidien vulgarisé (3 articles, ~10-12 min) ─────────────────────

async function generateDailyScript(
  articles: DbArticle[],
  env: Env,
): Promise<PodcastScript | null> {
  if (!env.DEEPSEEK_API_KEY && !env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
    console.warn('[Podcast/daily] Aucun LLM disponible (DeepSeek/Gemini/OpenRouter)');
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
      `    {"type":"headline","speaker":"host","text":"Annonce en 25-30 mots de l'article ${i + 1}, formulation percutante"},\n` +
      `    {"type":"context","speaker":"analyst","text":"Contexte en 130-140 mots : ce que l'auditeur doit savoir en fond pour comprendre, 'Pour bien comprendre il faut savoir que...'"},\n` +
      `    {"type":"explanation","speaker":"host","text":"Explication en 110-120 mots : ce que ça signifie concrètement, 'En clair, ça veut dire que...', 'Concrètement pour vous...'"},\n` +
      `    {"type":"impact","speaker":"analyst","text":"Impact en 90-100 mots : pourquoi c'est important, qui est concerné, quelles conséquences pratiques"}` +
      (notLast ? `,\n    {"type":"transition","speaker":"host","text":"Transition fluide en 25-30 mots vers le sujet suivant"}` : '')
    );
  }).join(',\n');

  const prompt =
    `Voici ${top.length} articles tech du jour :\n\n${articleList}\n\n` +
    `Génère un podcast de vulgarisation tech en français (~10-12 minutes) au format JSON EXACT :\n\n` +
    `{\n  "title": "TechBrief — ${todayFr()}",\n  "segments": [\n` +
    `    {"type":"intro","speaker":"host","text":"Introduction chaleureuse en 70-80 mots : accueillir l'auditeur, présenter les 3 sujets du jour avec enthousiasme"},\n` +
    `${articleBlocks},\n` +
    `    {"type":"outro","speaker":"host","text":"Conclusion en 55-65 mots : récap des 3 points clés, formule de fin chaleureuse"}\n` +
    `  ]\n}\n\n` +
    `RÈGLES :\n` +
    `- Vulgarisation : accessible à quelqu'un sans background technique\n` +
    `- context (analyst) : histoire, fond, "Tout a commencé quand...", "Il faut savoir que..."\n` +
    `- explanation (host) : "Concrètement...", "En clair...", analogies simples du quotidien\n` +
    `- impact (analyst) : chiffres, acteurs, conséquences réelles\n` +
    `- Aucun markdown, JSON pur, texte naturel et fluide à l'oral`;

  const raw = await callLLM(
    env,
    [
      {
        role: 'system',
        content:
          'Tu es un producteur de podcast tech francophone spécialisé en vulgarisation. Tu rends la tech accessible à tous. Tu réponds UNIQUEMENT en JSON valide.',
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

// ─── Script Deep Dive hebdomadaire (1 sujet, ~18-20 min) ─────────────────────

async function generateDeepDiveScript(
  articles: DbArticle[],
  env: Env,
): Promise<PodcastScript | null> {
  if (!env.DEEPSEEK_API_KEY && !env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
    console.warn('[Podcast/deep_dive] Aucun LLM disponible');
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
    `\nGénère un podcast Deep Dive pédagogique en français (~18-20 minutes) au format JSON EXACT :\n\n` +
    `{\n  "title": "🔬 Deep Dive : ${shortTitle}",\n  "segments": [\n` +
    `    {"type":"intro","speaker":"host","text":"Introduction percutante en 90-100 mots : accrocher l'auditeur dès la 1ère phrase, poser la question centrale, annoncer le voyage de compréhension"},\n` +
    `    {"type":"large_context","speaker":"analyst","text":"Contexte historique et fondamentaux en 370-390 mots : d'où vient cette techno/tendance, son évolution sur 5-10 ans, les concepts de base, pourquoi ça existe, 'Tout a commencé...'"},\n` +
    `    {"type":"explanation","speaker":"host","text":"Explication progressive en 290-310 mots : comment ça fonctionne vraiment, par étapes claires, du plus simple au plus complexe, sans jargon inutile"},\n` +
    `    {"type":"analogie","speaker":"host","text":"Analogie du quotidien en 240-260 mots : DOIT commencer par 'Imaginez que...' ou 'C'est exactement comme si...', une comparaison concrète avec la vie de tous les jours pour ancrer la compréhension intuitive"},\n` +
    `    {"type":"analysis","speaker":"analyst","text":"Analyse technique approfondie en 360-380 mots : les mécanismes clés, les acteurs principaux, les chiffres importants, les défis, les enjeux techniques réels"},\n` +
    `    {"type":"impact","speaker":"analyst","text":"Impacts sectoriels en 280-300 mots : transformation de l'emploi, économie, société, quels secteurs sont disrupted, qui perd, qui gagne, exemples concrets"},\n` +
    `    {"type":"future","speaker":"host","text":"Perspectives futures en 260-280 mots : dans 3 ans, dans 10 ans, les scénarios optimiste et pessimiste, 'D'ici 2027...', 'Le scénario qui se dessine...', les signaux faibles à surveiller"},\n` +
    `    {"type":"conclusion","speaker":"host","text":"Synthèse en 110-130 mots : les 3 points essentiels à retenir, pourquoi continuer à suivre ce sujet, formule de fin qui donne envie de revenir"}\n` +
    `  ]\n}\n\n` +
    `RÈGLES ABSOLUES :\n` +
    `- Pédagogie par couches : chaque segment construit sur le précédent\n` +
    `- large_context : commencer dans le passé et progresser vers le présent\n` +
    `- analogie : OBLIGATOIREMENT commencer par "Imaginez que..." ou "C'est exactement comme si..."\n` +
    `- future : oser les projections concrètes avec des dates approximatives\n` +
    `- Respecter les word counts pour atteindre 18-20 minutes de contenu total\n` +
    `- Aucun markdown, JSON pur, texte naturel et fluide à l'oral`;

  const raw = await callLLM(
    env,
    [
      {
        role: 'system',
        content:
          'Tu es un journaliste tech expert, pédagogue et passionné. Tu crées des contenus audio longs, approfondis et accessibles. Tu réponds UNIQUEMENT en JSON valide.',
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
// Priorité : FastAPI → Parler-TTS HF (gratuit)
// Fallback  : OpenAI gpt-4o-mini-tts (~$4/mois) si FastAPI indisponible

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
      signal: AbortSignal.timeout(90_000), // Parler-TTS peut prendre 20-60s (cold start HF)
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
  if (!env.OPENAI_API_KEY) return null;

  const config = VOICES[segment.speaker];
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: config.voice,
        input: segment.text,
        instructions: config.instructions,
        response_format: 'aac',
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
  // Priorité : Edge-TTS via FastAPI (gratuit, voix neurales FR)
  const edgeAudio = await synthesizeViaFastApi(segment, env);
  if (edgeAudio) {
    console.log(`[Podcast] Segment ${segment.id} → Edge-TTS ✓`);
    return { buffer: edgeAudio, ext: 'mp3' };
  }

  // Fallback : OpenAI gpt-4o-mini-tts
  console.warn(`[Podcast] Fallback OpenAI TTS pour ${segment.id}`);
  const oaiAudio = await synthesizeViaOpenAI(segment, env);
  if (oaiAudio) return { buffer: oaiAudio, ext: 'aac' };

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
    const contentType = ext === 'wav' ? 'audio/wav' : 'audio/aac';
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

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * TechBrief quotidien vulgarisé — ~10-12 min, 3 articles.
 * Cron : 0 6 * * * (chaque jour à 6h UTC)
 */
export async function generateDailyPodcast(env: Env): Promise<void> {
  console.log('[Podcast] Démarrage TechBrief quotidien…');

  if (!env.PODCASTS) {
    console.warn('[Podcast] R2 bucket PODCASTS non configuré — abandon');
    return;
  }

  const hasFastApi = !!(env.REDDIT_PROXY_URL && env.REDDIT_PROXY_SECRET);
  const hasOpenAI  = !!env.OPENAI_API_KEY;
  if (!hasFastApi && !hasOpenAI) {
    console.warn('[Podcast] Aucun provider TTS disponible (ni FastAPI/HF ni OpenAI) — abandon');
    return;
  }
  console.log(`[Podcast] TTS providers disponibles : ${[hasFastApi && 'Parler-HF', hasOpenAI && 'OpenAI'].filter(Boolean).join(', ')}`);

  const articles = await fetchTopArticles(env, 20, 24);
  if (articles.length < 3) {
    console.log(`[Podcast] Seulement ${articles.length} articles frais — TechBrief annulé`);
    return;
  }
  console.log(`[Podcast/daily] ${articles.length} articles disponibles`);

  const script = await generateDailyScript(articles, env);
  if (!script) {
    console.warn('[Podcast/daily] Échec génération script');
    return;
  }
  console.log(`[Podcast/daily] Script OK : "${script.title}" (${script.segments.length} segments)`);

  await uploadAndSave(script, 'daily', env);
  await cleanupOldPodcasts(env);
}

/**
 * Deep Dive hebdomadaire pédagogique — ~18-20 min, 1 sujet approfondi.
 * Cron : 0 6 * * 5 (vendredi à 6h UTC)
 */
export async function generateDeepDivePodcast(env: Env): Promise<void> {
  console.log('[Podcast] Démarrage Deep Dive hebdomadaire…');

  if (!env.PODCASTS) {
    console.warn('[Podcast] R2 bucket PODCASTS non configuré — abandon');
    return;
  }

  const hasFastApi = !!(env.REDDIT_PROXY_URL && env.REDDIT_PROXY_SECRET);
  const hasOpenAI  = !!env.OPENAI_API_KEY;
  if (!hasFastApi && !hasOpenAI) {
    console.warn('[Podcast] Aucun provider TTS disponible — abandon');
    return;
  }

  // Articles de la semaine pour choisir le sujet le plus riche
  const articles = await fetchTopArticles(env, 50, 7 * 24);
  if (articles.length < 1) {
    console.log('[Podcast] Aucun article cette semaine — Deep Dive annulé');
    return;
  }
  console.log(`[Podcast/deep_dive] ${articles.length} articles candidats`);

  const script = await generateDeepDiveScript(articles, env);
  if (!script) {
    console.warn('[Podcast/deep_dive] Échec génération script');
    return;
  }
  console.log(`[Podcast/deep_dive] Script OK : "${script.title}" (${script.segments.length} segments)`);

  await uploadAndSave(script, 'deep_dive', env);
  // Le cleanup est fait par generateDailyPodcast — pas besoin de le doubler le vendredi
}
