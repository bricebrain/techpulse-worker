import type { Env } from './types';
import { buildScienceSourceContext } from './scienceSourceContext';

const MODEL = '@cf/meta/llama-3.2-3b-instruct';
const MAX_ARTICLES_PER_RUN = 6;

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
}

function cleanText(value: string | null | undefined, limit: number): string {
  return (value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function buildPrompt(article: ScienceArticleRow): string {
  const content = cleanText(article.content, 3600);
  return `Tu es l'éditeur scientifique pédagogique de TechPulse.

Transforme cet article en fiche claire pour un lecteur technique curieux, en français.

Contraintes :
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

function parseJsonObject(text: string): ScienceBrief | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<ScienceBrief>;
    const title = cleanText(parsed.title_fr, 160);
    const summary = cleanText(parsed.summary_fr, 3000);
    if (!title || summary.length < 450) return null;
    return { title_fr: title, summary_fr: summary };
  } catch {
    return null;
  }
}

function buildFallbackBrief(article: ScienceArticleRow): ScienceBrief {
  const title = cleanText(article.title, 140);
  const source = cleanText(article.source_name, 80);
  const content = cleanText(article.content, 900);
  const usableContent = content || `La source ne fournit qu'un titre exploitable : ${title}.`;

  return {
    title_fr: title,
    summary_fr: [
      `L'idée : ${usableContent}`,
      `Le mécanisme : l'intérêt est de repartir du fait scientifique ou technique précis, puis d'identifier ce qu'il révèle : une nouvelle méthode, une mesure plus fine, une hypothèse testable, un instrument plus sensible ou une application potentielle. Ici, la source ${source} donne le signal de départ ; le point important est de comprendre ce que ce signal permet de mesurer, d'observer ou de rendre possible.`,
      `Pourquoi c'est intéressant : ce type d'information est utile parce qu'il ne se limite pas à une annonce. Il peut indiquer une direction de recherche, une capacité expérimentale nouvelle, ou un changement de compréhension dans un domaine. Même quand l'extrait disponible est court, il sert de porte d'entrée vers le papier ou l'article original.`,
      `À retenir : le bon réflexe est de demander ce que cette découverte rend mesurable, testable ou applicable demain. C'est cette question qui transforme une actualité scientifique brute en signal exploitable.`,
    ].join('\n\n'),
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
          { role: 'system', content: 'Tu es un éditeur scientifique. Réponds uniquement en JSON valide, sans markdown.' },
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
    return parseJsonObject(data.choices?.[0]?.message?.content ?? '');
  } catch (e) {
    console.warn('[ScienceEnricher] xAI error:', e);
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
    return parseJsonObject(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
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

    return parseJsonObject(response?.response ?? '');
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
     ORDER BY
       CASE
         WHEN source_name LIKE 'Grok %' THEN 0
         WHEN source_name IN ('bioRxiv', 'medRxiv', 'PLOS ONE', 'Cell', 'The Lancet', 'Science News', 'Ars Technica Science', 'Quanta Magazine') THEN 1
         ELSE 2
       END,
       LENGTH(COALESCE(content, '')) DESC,
       fetched_at DESC
     LIMIT ?`,
  ).bind(cutoff, MAX_ARTICLES_PER_RUN).all<ScienceArticleRow>();

  if (!results.length) return;

  console.log(`[ScienceEnricher] Enrichissement de ${results.length} articles science`);
  let updated = 0;
  const statements: D1PreparedStatement[] = [];

  for (const article of results) {
    const sourceContext = await buildScienceSourceContext({
      url: article.url,
      sourceName: article.source_name,
      title: article.title,
      content: article.content,
    });
    const enrichedArticle = { ...article, content: sourceContext || article.content };
    const brief = await generateWithXai(xaiKey, enrichedArticle)
      ?? await generateWithGemini(geminiKey, enrichedArticle)
      ?? await generateWithWorkersAi(env, enrichedArticle)
      ?? buildFallbackBrief(enrichedArticle);

    statements.push(
      env.DB.prepare(
        `UPDATE articles
         SET content = ?, title_fr = ?, summary_fr = ?
         WHERE hash = ?`,
      ).bind(enrichedArticle.content ?? article.content ?? null, brief.title_fr, brief.summary_fr, article.hash),
    );
    updated++;
  }

  if (statements.length > 0) await env.DB.batch(statements);
  console.log(`[ScienceEnricher] ${updated}/${results.length} articles enrichis`);
}
