/**
 * Génération automatique de podcasts côté serveur.
 *
 * Flux :
 *   1. Fetch des meilleurs articles D1 des dernières 24h
 *   2. Script JSON via Groq (llama-3.3-70b)
 *   3. TTS segment par segment via OpenAI gpt-4o-mini-tts
 *   4. Upload MP3 dans R2  →  podcasts/{id}/{i}.mp3
 *   5. Sauvegarde métadonnées + segments_json dans D1
 *   6. Nettoyage des podcasts > 7 jours
 */

import type { Env } from './types';

// ─── Types internes ───────────────────────────────────────────────────────────

export interface PodcastSegment {
  id: string;
  type: 'intro' | 'headline' | 'analysis' | 'transition' | 'outro';
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

// ─── Config voix (identique à l'app) ─────────────────────────────────────────

const VOICES: Record<'host' | 'analyst', { voice: string; instructions: string }> = {
  host: {
    voice: 'alloy',
    instructions:
      'Tu es un présentateur tech passionné et dynamique. Parle avec énergie et enthousiasme, en variant les inflexions. Ton chaleureux, accessible et accrocheur.',
  },
  analyst: {
    voice: 'onyx',
    instructions:
      'Tu es un analyste tech expert et posé. Articule chaque point avec précision et autorité. Ton sérieux, informatif, légèrement dramatique sur les chiffres et insights importants.',
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

// ─── Étape 1 : récupération des articles frais ────────────────────────────────

async function fetchTopArticles(env: Env): Promise<DbArticle[]> {
  // Articles des dernières 24h, tous thèmes confondus
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT title, source_name, content, published_at
     FROM articles
     WHERE published_at > ?
     ORDER BY published_at DESC
     LIMIT 20`,
  ).bind(cutoff).all<DbArticle>();
  return results;
}

// ─── Étape 2 : génération du script via Groq ──────────────────────────────────

function parseScript(raw: string): PodcastScript | null {
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
        type: (['intro', 'headline', 'analysis', 'transition', 'outro'].includes(s.type ?? '')
          ? s.type
          : 'analysis') as PodcastSegment['type'],
        speaker: (s.speaker === 'analyst' ? 'analyst' : 'host') as PodcastSegment['speaker'],
        text: (s.text ?? '').trim(),
      }));

    if (segments.length < 3) return null;

    return {
      title:
        typeof parsed.title === 'string' && parsed.title.trim()
          ? parsed.title.trim()
          : `TechBrief — ${todayFr()}`,
      segments,
    };
  } catch {
    return null;
  }
}

async function generateScript(
  articles: DbArticle[],
  env: Env,
): Promise<PodcastScript | null> {
  const groqKey = env.GROQ_API_KEY_1 ?? env.GROQ_API_KEY_2;
  if (!groqKey) {
    console.warn('[Podcast] Aucune clé Groq — génération impossible');
    return null;
  }

  const top = articles.slice(0, 5);
  const articleList = top
    .map(
      (a, i) =>
        `Article ${i + 1}: "${a.title}" (source: ${a.source_name})\nRésumé: ${(a.content ?? '').slice(0, 300).trim()}`,
    )
    .join('\n\n');

  const pairs = top
    .map(() => `{"type":"headline","speaker":"host","text":"..."},{"type":"analysis","speaker":"analyst","text":"..."}`)
    .join(',');

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.8,
        messages: [
          {
            role: 'system',
            content:
              "Tu es un producteur de podcast tech pour francophones. Tu génères des scripts courts, dynamiques et naturels à l'oral. Réponds UNIQUEMENT en JSON valide.",
          },
          {
            role: 'user',
            content:
              `Voici ${top.length} article${top.length > 1 ? 's' : ''} tech :\n\n${articleList}\n\n` +
              `Génère un script de podcast en français avec cette structure JSON exacte :\n` +
              `{"title":"TechBrief — ${todayFr()}","segments":[` +
              `{"type":"intro","speaker":"host","text":"..."},` +
              `${pairs},` +
              `{"type":"outro","speaker":"host","text":"..."}]}\n\n` +
              `Règles : intro 40-50 mots, headline 15-25 mots, analysis 100-140 mots, outro 35-45 mots. Naturel à l'oral, sans markdown.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn(`[Podcast] Groq API ${res.status}`);
      return null;
    }

    const data = await res.json<{
      choices?: { message?: { content?: string } }[];
    }>();
    const raw = data?.choices?.[0]?.message?.content ?? '';
    return parseScript(raw);
  } catch (e) {
    console.warn('[Podcast] Groq exception:', e);
    return null;
  }
}

// ─── Étape 3 : TTS via OpenAI ─────────────────────────────────────────────────

async function synthesizeSegment(
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
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn(`[Podcast] TTS ${segment.id} → ${res.status}`);
      return null;
    }
    return res.arrayBuffer();
  } catch (e) {
    console.warn(`[Podcast] TTS exception ${segment.id}:`, e);
    return null;
  }
}

// ─── Nettoyage des anciens podcasts ───────────────────────────────────────────

async function cleanupOldPodcasts(env: Env): Promise<void> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const { results: old } = await env.DB.prepare(
    'SELECT id, segment_count FROM podcast_feed WHERE generated_at < ?',
  ).bind(cutoff).all<{ id: string; segment_count: number }>();

  for (const pod of old) {
    // Supprimer les MP3 dans R2
    const keys = Array.from(
      { length: pod.segment_count },
      (_, i) => `podcasts/${pod.id}/${i}.mp3`,
    );
    if (keys.length > 0) {
      await env.PODCASTS?.delete(keys);
    }
    await env.DB.prepare('DELETE FROM podcast_feed WHERE id = ?').bind(pod.id).run();
  }

  if (old.length > 0) {
    console.log(`[Podcast] ${old.length} ancien(s) podcast(s) nettoyé(s)`);
  }
}

// ─── Export principal ─────────────────────────────────────────────────────────

export async function generateDailyPodcast(env: Env): Promise<void> {
  console.log('[Podcast] Démarrage génération quotidienne…');

  if (!env.PODCASTS) {
    console.warn('[Podcast] R2 bucket PODCASTS non configuré — abandon');
    return;
  }
  if (!env.OPENAI_API_KEY) {
    console.warn('[Podcast] OPENAI_API_KEY manquant — TTS impossible');
    return;
  }

  // 1. Articles frais
  const articles = await fetchTopArticles(env);
  if (articles.length < 3) {
    console.log(`[Podcast] Seulement ${articles.length} articles frais — podcast annulé`);
    return;
  }
  console.log(`[Podcast] ${articles.length} articles disponibles`);

  // 2. Script
  const script = await generateScript(articles, env);
  if (!script) {
    console.warn('[Podcast] Échec génération script');
    return;
  }
  console.log(`[Podcast] Script OK : "${script.title}" (${script.segments.length} segments)`);

  // 3. TTS + upload R2
  const id = makePodcastId();
  const generatedAt = Date.now();
  let uploaded = 0;

  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i]!;
    const audio = await synthesizeSegment(seg, env);
    if (!audio) continue;

    await env.PODCASTS.put(`podcasts/${id}/${i}.mp3`, audio, {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
    uploaded++;
    console.log(`[Podcast] Segment ${i + 1}/${script.segments.length} uploadé (${audio.byteLength} bytes)`);
  }

  // Abort si trop peu de segments ont du son (au moins 50%)
  if (uploaded < Math.ceil(script.segments.length * 0.5)) {
    console.warn(`[Podcast] Trop peu de segments audio (${uploaded}/${script.segments.length}) — podcast non sauvegardé`);
    return;
  }

  // 4. Sauvegarde D1
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO podcast_feed (id, title, theme, generated_at, segment_count, segments_json, is_ready, created_at)
     VALUES (?, ?, 'general', ?, ?, ?, 1, ?)`,
  ).bind(
    id,
    script.title,
    generatedAt,
    script.segments.length,
    JSON.stringify(script.segments),
    now,
  ).run();

  console.log(`[Podcast] ✓ Podcast sauvegardé : ${id} (${uploaded}/${script.segments.length} segments audio)`);

  // 5. Nettoyage
  await cleanupOldPodcasts(env);
}
