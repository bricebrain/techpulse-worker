import type { Env } from './types';
import { buildScienceSourceContext } from './scienceSourceContext';

const MODEL = '@cf/meta/llama-3.2-3b-instruct';
const MAX_ARTICLES_PER_RUN = 2;
const MIN_CONTEXT_FOR_STANDARD_GENERATION = 1200;
const CURATED_SCIENCE_SOURCES = [
  'Quanta Magazine',
  'Our World in Data',
  'Science Etonnante',
  'Science News',
  'Ars Technica Science',
];

interface ScienceArticleRow {
  hash: string;
  title: string;
  source_name: string;
  url: string | null;
  content: string | null;
}

interface ScienceBrief {
  title_fr: string;
  summary_fr: string;
  context?: string;
}

function cleanText(value: string | null | undefined, limit: number): string {
  return (value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function countMatches(text: string, words: string[]): number {
  return words.reduce((total, word) => {
    const pattern = new RegExp(`\\b${word}\\b`, 'gi');
    return total + (text.match(pattern)?.length ?? 0);
  }, 0);
}

function isMostlyFrench(summary: string): boolean {
  const body = summary
    .replace(/L'idée\s*:/gi, '')
    .replace(/Le mécanisme\s*:/gi, '')
    .replace(/Pourquoi c'est intéressant\s*:/gi, '')
    .replace(/À retenir\s*:/gi, '')
    .toLowerCase();
  const englishScore = countMatches(body, [
    'the',
    'and',
    'with',
    'from',
    'that',
    'this',
    'study',
    'research',
    'scientists',
    'university',
    'published',
    'results',
    'will',
    'can',
  ]);
  const frenchScore = countMatches(body, [
    'le',
    'la',
    'les',
    'des',
    'une',
    'un',
    'du',
    'dans',
    'avec',
    'pour',
    'cette',
    'ces',
    'qui',
    'que',
    'chercheurs',
    'étude',
    'résultat',
  ]);

  return frenchScore >= 8 && englishScore <= Math.max(4, Math.floor(frenchScore * 0.5));
}

function buildPrompt(article: ScienceArticleRow): string {
  const content = cleanText(article.content, 3600);
  return `Tu es l'éditeur scientifique pédagogique de TechPulse.

Transforme cet article en fiche claire pour un lecteur technique curieux, en français.

Contraintes :
- La valeur "summary_fr" doit être intégralement en français.
- Ne copie jamais une phrase anglaise de la source ; reformule et vulgarise en français.
- N'invente aucun fait absent du titre ou du contenu.
- Si l'information source est limitée, distingue clairement le fait observé et le contexte scientifique général.
- Ne fais pas un résumé journalistique court : rends le sujet compréhensible.
- Ton style doit être pédagogique, concret, sans jargon inutile.
- Le brief doit faire 180 à 260 mots.
- Structure le brief avec ces lignes : "L'idée :", "Le mécanisme :", "Pourquoi c'est intéressant :", "À retenir :".

Article :
Titre : ${article.title}
Source : ${article.source_name}
Contexte source disponible :
${content || 'aucun extrait fourni'}

Réponds uniquement en JSON valide :
{
  "title_fr": "titre français clair, max 110 caractères",
  "summary_fr": "fiche pédagogique en français"
}`;
}

function briefFromFreeText(text: string, article: ScienceArticleRow): ScienceBrief | null {
  const summary = cleanText(
    text
      .replace(/```json/gi, '')
      .replace(/```/g, ''),
    3000,
  );
  if (summary.length < 450) return null;
  if (!isMostlyFrench(summary)) return null;
  return {
    title_fr: cleanText(article.title, 160),
    summary_fr: summary,
  };
}

function parseBriefResponse(text: string, article: ScienceArticleRow): ScienceBrief | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return briefFromFreeText(text, article);
  try {
    const parsed = JSON.parse(match[0]) as Partial<ScienceBrief>;
    const title = cleanText(parsed.title_fr, 160);
    const summary = cleanText(parsed.summary_fr, 3000);
    if (!title || summary.length < 450) return null;
    if (!isMostlyFrench(summary)) return null;
    const context = cleanText(parsed.context, 4200);
    return { title_fr: title, summary_fr: summary, context: context || undefined };
  } catch {
    return briefFromFreeText(text, article);
  }
}

function buildFallbackBrief(article: ScienceArticleRow): ScienceBrief {
  const title = cleanText(article.title, 140);
  const source = cleanText(article.source_name, 80);

  return {
    title_fr: title,
    summary_fr: `Signal à vérifier : ${source} mentionne « ${title} », mais le contexte récupéré est insuffisant pour produire une fiche pédagogique fiable sans inventer. Cet item reste disponible dans le flux, sans être priorisé comme brief science enrichi.`,
  };
}

async function getGeminiKey(env: Env): Promise<string> {
  try {
    return await env.GEMINI_API_KEY.get();
  } catch {
    return '';
  }
}

async function getXaiKey(env: Env): Promise<string> {
  try {
    return await env.XAI_API_KEY.get();
  } catch {
    return '';
  }
}

async function generateWithXai(apiKey: string, article: ScienceArticleRow): Promise<ScienceBrief | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-4',
        max_tokens: 900,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'Tu es un éditeur scientifique français. Réponds uniquement en JSON valide, sans markdown. Le champ summary_fr doit être entièrement en français.' },
          { role: 'user', content: buildPrompt(article) },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      console.warn(`[ScienceEnricher] xAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json<{ choices?: { message?: { content?: string } }[] }>();
    return parseBriefResponse(data.choices?.[0]?.message?.content ?? '', article);
  } catch (e) {
    console.warn('[ScienceEnricher] xAI error:', e);
    return null;
  }
}

function buildWebBriefPrompt(article: ScienceArticleRow): string {
  const content = cleanText(article.content, 1600);
  return `Tu es l'éditeur scientifique pédagogique de TechPulse.

Recherche sur le web le sujet exact, puis produis une fiche pédagogique en français.

Contraintes :
- La valeur "summary_fr" doit être intégralement en français.
- Ne copie jamais une phrase anglaise de la source ; reformule et vulgarise en français.
- Utilise la recherche web pour compléter l'information si l'extrait est insuffisant.
- Privilégie source primaire, papier, preprint, revue, institution ou média scientifique fiable.
- N'invente rien : si une information n'est pas confirmée, ne l'utilise pas.
- Explique le mécanisme scientifique, pas seulement l'annonce.
- Si c'est médical, indique le stade de preuve : préclinique, phase 1/2/3, observationnel, revue, etc.
- Évite les formulations génériques comme "ce signal permet de mesurer".
- Le brief doit faire 220 à 320 mots.
- Structure le brief avec : "L'idée :", "Le mécanisme :", "Pourquoi c'est intéressant :", "À retenir :".

Signal initial :
Titre : ${article.title}
Source : ${article.source_name}
URL : ${article.url ?? 'absente'}
Extrait disponible : ${content || 'aucun'}

Réponds uniquement en JSON valide :
{
  "title_fr": "titre français clair, max 110 caractères",
  "summary_fr": "fiche pédagogique en français",
  "context": "contexte factuel condensé utilisé pour générer la fiche, avec noms de sources ou papiers"
}`;
}

async function generateWithXaiWebSearch(apiKey: string, article: ScienceArticleRow): Promise<ScienceBrief | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-4',
        input: [
          {
            role: 'user',
            content: buildWebBriefPrompt(article),
          },
        ],
        tools: [{ type: 'web_search' }],
        temperature: 0.1,
        max_output_tokens: 2600,
      }),
      signal: AbortSignal.timeout(55_000),
    });

    if (!res.ok) {
      console.warn(`[ScienceEnricher] xAI web HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }

    const data = await res.json<{ output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> }>();
    const text = data.output
      ?.find((item) => item.type === 'message')
      ?.content
      ?.find((item) => item.type === 'output_text')
      ?.text ?? '';
    return parseBriefResponse(text, article);
  } catch (e) {
    console.warn('[ScienceEnricher] xAI web error:', e);
    return null;
  }
}

async function generateWithGemini(apiKey: string, article: ScienceArticleRow): Promise<ScienceBrief | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(article) }] }],
        generationConfig: {
          maxOutputTokens: 900,
          temperature: 0.25,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[ScienceEnricher] Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>();
    return parseBriefResponse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '', article);
  } catch (e) {
    console.warn('[ScienceEnricher] Gemini error:', e);
    return null;
  }
}

async function generateWithWorkersAi(env: Env, article: ScienceArticleRow): Promise<ScienceBrief | null> {
  try {
    const response = await env.AI.run(MODEL, {
      messages: [{ role: 'user', content: buildPrompt(article) }],
      max_tokens: 900,
      temperature: 0.2,
    }) as { response?: string };

    return parseBriefResponse(response?.response ?? '', article);
  } catch (e) {
    console.warn('[ScienceEnricher] Workers AI error:', e);
    return null;
  }
}

export async function enrichScienceArticles(env: Env): Promise<void> {
  const xaiKey = await getXaiKey(env);
  const geminiKey = await getGeminiKey(env);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT hash, title, source_name, url, content
     FROM articles
     WHERE theme = 'science'
       AND fetched_at > ?
       AND (summary_fr IS NULL OR LENGTH(summary_fr) < 120)
       AND title NOT LIKE '%Seminar%'
       AND title NOT LIKE '%Symposium%'
       AND title NOT LIKE '%Activities%'
       AND title NOT LIKE '%Take Place%'
       AND title NOT LIKE '%#shorts%'
       AND title NOT LIKE '%#short%'
     ORDER BY
       CASE
         WHEN source_name IN (${CURATED_SCIENCE_SOURCES.map(() => '?').join(',')}) THEN 0
         WHEN source_name LIKE 'Grok %' THEN 1
         WHEN source_name IN ('bioRxiv', 'medRxiv', 'PLOS ONE', 'Cell', 'The Lancet', 'Science News', 'Ars Technica Science') THEN 2
         ELSE 2
       END,
       LENGTH(COALESCE(content, '')) DESC,
       fetched_at DESC
     LIMIT ?`,
  ).bind(cutoff, ...CURATED_SCIENCE_SOURCES, MAX_ARTICLES_PER_RUN).all<ScienceArticleRow>();

  if (!results.length) return;

  console.log(`[ScienceEnricher] Enrichissement de ${results.length} articles science`);
  let updated = 0;

  for (const article of results) {
    const sourceContext = await buildScienceSourceContext({
      url: article.url,
      sourceName: article.source_name,
      title: article.title,
      content: article.content,
      xaiApiKey: xaiKey,
    });
    const enrichedArticle = { ...article, content: sourceContext || article.content };
    const needsWebSearch = cleanText(enrichedArticle.content, 5000).length < MIN_CONTEXT_FOR_STANDARD_GENERATION;
    const brief = (needsWebSearch ? await generateWithXaiWebSearch(xaiKey, enrichedArticle) : null)
      ?? await generateWithXai(xaiKey, enrichedArticle)
      ?? await generateWithGemini(geminiKey, enrichedArticle)
      ?? await generateWithWorkersAi(env, enrichedArticle)
      ?? buildFallbackBrief(enrichedArticle);
    const contentToStore = brief.context && brief.context.length > (enrichedArticle.content?.length ?? 0)
      ? brief.context
      : enrichedArticle.content;

    await env.DB.prepare(
      `UPDATE articles
       SET content = ?, title_fr = ?, summary_fr = ?
       WHERE hash = ?`,
    ).bind(contentToStore ?? article.content ?? null, brief.title_fr, brief.summary_fr, article.hash).run();
    updated++;
  }

  console.log(`[ScienceEnricher] ${updated}/${results.length} articles enrichis`);
}
