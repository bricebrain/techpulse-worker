/**
 * Génération hebdomadaire de suggestions IA.
 *
 * Analyse les titres d'articles récents et propose :
 *  - De nouveaux thèmes émergents (avec sources de démarrage)
 *  - Des chaînes YouTube pertinentes à ajouter
 *
 * Cron : 0 8 * * 1 (lundi 8h UTC)
 */

import type { Env } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StarterSource {
  type: 'youtube_channel' | 'rss';
  name: string;
  value: string; // channel_id ou URL RSS
}

interface RawSuggestion {
  type: 'new_theme' | 'youtube_channel';
  name: string;
  description: string;
  // new_theme
  slug?: string;
  starter_sources?: StarterSource[];
  // youtube_channel
  value?: string;
  theme?: string;
}

export interface DbSuggestion {
  id: string;
  type: 'new_theme' | 'youtube_channel';
  name: string;
  description: string;
  theme: string | null;
  value: string;
  extra_json: string;
  generated_at: number;
  is_applied: number;
  is_dismissed: number;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSuggestionId(): string {
  return `sug_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/, '');
}

// ─── Récupération des données contextuelles ───────────────────────────────────

async function getContext(env: Env): Promise<{
  recentTitles: string[];
  currentThemes: string[];
  existingValues: Set<string>;
}> {
  // Titres des 7 derniers jours
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const { results: articles } = await env.DB.prepare(
    `SELECT title FROM articles WHERE published_at > ? ORDER BY published_at DESC LIMIT 100`,
  ).bind(cutoff).all<{ title: string }>();

  // Thèmes actuellement configurés
  const { results: themeRows } = await env.DB.prepare(
    `SELECT DISTINCT theme FROM sources WHERE is_active = 1`,
  ).all<{ theme: string }>();

  // Valeurs déjà suggérées (channel_id ou slug) — éviter les doublons
  const { results: existingSugs } = await env.DB.prepare(
    `SELECT value FROM suggestions WHERE is_dismissed = 0`,
  ).all<{ value: string }>();

  // Sources déjà configurées
  const { results: existingSources } = await env.DB.prepare(
    `SELECT value FROM sources`,
  ).all<{ value: string }>();

  const existingValues = new Set([
    ...existingSugs.map((s) => s.value),
    ...existingSources.map((s) => s.value),
  ]);

  return {
    recentTitles: articles.map((a) => a.title),
    currentThemes: themeRows.map((r) => r.theme),
    existingValues,
  };
}

// ─── Appel Groq ───────────────────────────────────────────────────────────────

async function callGroq(prompt: string, env: Env): Promise<string | null> {
  const key = env.GROQ_API_KEY_1 ?? env.GROQ_API_KEY_2;
  if (!key) return null;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1500,
        temperature: 0.4, // plus déterministe pour les IDs
        messages: [
          {
            role: 'system',
            content:
              'Tu es un expert en veille technologique. Tu réponds UNIQUEMENT en JSON valide, sans markdown ni commentaires.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) return null;
    const data = await res.json<{ choices?: { message?: { content?: string } }[] }>();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

// ─── Parse + validation ───────────────────────────────────────────────────────

function parseSuggestions(raw: string): RawSuggestion[] {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { suggestions?: RawSuggestion[] };
    if (!Array.isArray(parsed.suggestions)) return [];
    return parsed.suggestions.filter((s) => s.type && s.name && s.description);
  } catch {
    return [];
  }
}

function isValidChannelId(value: string): boolean {
  // Les vrais channel IDs YouTube font 24 chars et commencent par UC
  return /^UC[a-zA-Z0-9_-]{22}$/.test(value);
}

// ─── Export principal ─────────────────────────────────────────────────────────

export async function generateSuggestions(env: Env): Promise<void> {
  console.log('[Suggestions] Démarrage analyse hebdomadaire…');

  const { recentTitles, currentThemes, existingValues } = await getContext(env);

  if (recentTitles.length < 10) {
    console.log('[Suggestions] Pas assez d\'articles récents — analyse annulée');
    return;
  }

  const titlesBlock = recentTitles.slice(0, 80).map((t, i) => `${i + 1}. ${t}`).join('\n');
  const themesBlock = currentThemes.join(', ');

  const prompt =
    `Voici ${recentTitles.length} titres d'articles tech collectés cette semaine :\n\n${titlesBlock}\n\n` +
    `Thèmes actuellement configurés dans l'app : ${themesBlock}\n\n` +
    `Analyse et retourne du JSON avec des suggestions pertinentes :\n\n` +
    `{\n` +
    `  "suggestions": [\n` +
    `    {\n` +
    `      "type": "new_theme",\n` +
    `      "name": "Nom du thème (max 25 car)",\n` +
    `      "slug": "theme-slug",\n` +
    `      "description": "Pourquoi ce thème émerge des articles (1 phrase courte)",\n` +
    `      "starter_sources": [\n` +
    `        {"type": "youtube_channel", "name": "Nom chaîne", "value": "UCxxxxxxxxxxxxxxxxxxxxxxx"},\n` +
    `        {"type": "rss", "name": "Nom source", "value": "https://..."}\n` +
    `      ]\n` +
    `    },\n` +
    `    {\n` +
    `      "type": "youtube_channel",\n` +
    `      "name": "Nom de la chaîne",\n` +
    `      "value": "UCxxxxxxxxxxxxxxxxxxxxxxx",\n` +
    `      "theme": "thème existant parmi : ${themesBlock}",\n` +
    `      "description": "Pourquoi cette chaîne correspond aux articles collectés (1 phrase)"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `Règles STRICTES :\n` +
    `- Maximum 2 nouveaux thèmes, maximum 5 chaînes YouTube\n` +
    `- Ne suggère PAS de thèmes déjà configurés : ${themesBlock}\n` +
    `- Pour youtube_channel : channel_id EXACTEMENT 24 caractères commençant par "UC"\n` +
    `- Seulement des chaînes très connues dont tu es CERTAIN de l'ID (Fireship, Theo, Traversy Media, etc.)\n` +
    `- Si tu n'es pas certain d'un channel_id, ne l'inclus pas\n` +
    `- Pour new_theme : le slug doit être en minuscules avec tirets`;

  const raw = await callGroq(prompt, env);
  if (!raw) {
    console.warn('[Suggestions] Groq n\'a pas répondu');
    return;
  }

  const rawSuggestions = parseSuggestions(raw);
  if (!rawSuggestions.length) {
    console.log('[Suggestions] Aucune suggestion parsée');
    return;
  }

  const now = Date.now();
  const nowIso = new Date().toISOString();
  let saved = 0;

  for (const s of rawSuggestions) {
    // Déterminer la valeur unique (pour éviter les doublons)
    const value = s.type === 'new_theme'
      ? (s.slug ? slugify(s.slug) : slugify(s.name))
      : (s.value ?? '');

    if (!value) continue;
    if (existingValues.has(value)) {
      console.log(`[Suggestions] Doublon ignoré : ${value}`);
      continue;
    }

    // Valider les channel_id YouTube
    if (s.type === 'youtube_channel' && !isValidChannelId(value)) {
      console.warn(`[Suggestions] Channel ID invalide ignoré : "${value}" pour "${s.name}"`);
      continue;
    }

    // Valider les starter_sources des new_theme
    let extra = '{}';
    if (s.type === 'new_theme' && Array.isArray(s.starter_sources)) {
      const validSources = s.starter_sources.filter((src) => {
        if (src.type === 'youtube_channel') return isValidChannelId(src.value);
        if (src.type === 'rss') return src.value.startsWith('http');
        return false;
      });
      extra = JSON.stringify({ starter_sources: validSources });
    }

    const id = makeSuggestionId();
    const theme = s.type === 'youtube_channel' ? (s.theme ?? null) : null;

    await env.DB.prepare(
      `INSERT OR IGNORE INTO suggestions
         (id, type, name, description, theme, value, extra_json, generated_at, is_applied, is_dismissed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    ).bind(id, s.type, s.name, s.description, theme, value, extra, now, nowIso).run();

    existingValues.add(value); // éviter doublons dans la même batch
    saved++;
  }

  // Nettoyer les vieilles suggestions ignorées (> 30 jours)
  const oldCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    `DELETE FROM suggestions WHERE is_dismissed = 1 AND generated_at < ?`,
  ).bind(oldCutoff).run();

  console.log(`[Suggestions] ${saved} suggestion(s) sauvegardée(s) sur ${rawSuggestions.length} parsées`);
}
