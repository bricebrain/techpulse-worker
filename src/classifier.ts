/**
 * Classification d'articles par thème via Workers AI (llama-3.2-3b-instruct).
 * Gratuit, tourne dans Cloudflare, aucun quota externe.
 */

import type { Env, Article } from './types';

const MODEL = '@cf/meta/llama-3.2-3b-instruct';

const VALID_THEMES = ['ai', 'mobile', 'general', 'business', 'startups', 'opensource', 'productivity', 'finance'] as const;
type Theme = typeof VALID_THEMES[number];

const THEME_DESCRIPTIONS: Record<Theme, string> = {
  ai:           'artificial intelligence, machine learning, LLMs, neural networks, GPT, ChatGPT, deep learning',
  mobile:       'mobile development, iOS, Android, React Native, Expo, Swift, Kotlin, Flutter',
  general:      'web development, programming, software engineering, DevOps, cloud, APIs, GitHub',
  business:     'business strategy, venture capital, investment, tech industry news, mergers, acquisitions',
  startups:     'startups, product launches, entrepreneurship, funding rounds, tech companies',
  opensource:   'open source, Linux, developer tools, libraries, frameworks, community projects',
  productivity: 'productivity, time management, automation, workflows, tools, personal efficiency',
  finance:      'stock markets, financial news, economy, trading, crypto, interest rates, earnings reports, IPO',
};

function buildPrompt(title: string, content: string): string {
  const text = [title, content].filter(Boolean).join(' — ').slice(0, 400);
  const themeList = VALID_THEMES.map(
    (t) => `- ${t}: ${THEME_DESCRIPTIONS[t]}`
  ).join('\n');

  return `You are a tech article classifier. Classify the following article into exactly one of these themes:
${themeList}

Article: "${text}"

Reply with ONLY the theme name, nothing else. Choose the single most relevant theme.`;
}

/**
 * Classifie un article et retourne le thème détecté, ou null si échec.
 */
export async function classifyArticle(
  ai: Env['AI'],
  article: Pick<Article, 'title' | 'content'>,
): Promise<string | null> {
  const title   = article.title?.trim() ?? '';
  const content = (article.content ?? '').trim();
  if (!title) return null;

  try {
    const response = await ai.run(MODEL, {
      messages: [
        {
          role: 'user',
          content: buildPrompt(title, content),
        },
      ],
      max_tokens: 10,
      temperature: 0,
    }) as { response?: string };

    const raw = (response?.response ?? '').trim().toLowerCase();

    // On cherche un thème valide dans la réponse
    const matched = VALID_THEMES.find((t) => raw.includes(t));
    return matched ?? null;
  } catch (e) {
    console.warn('[Classifier] Workers AI error:', e);
    return null;
  }
}

/**
 * Classifie un batch d'articles et met à jour classified_theme dans D1.
 */
export async function classifyAndStore(
  env: Env,
  articles: Article[],
  batchSize = 5,
): Promise<void> {
  if (!articles.length) return;

  console.log(`[Classifier] Classification de ${articles.length} articles…`);
  let classified = 0;

  for (let i = 0; i < articles.length; i += batchSize) {
    const batch = articles.slice(i, i + batchSize);

    // Classification séquentielle dans le batch (évite les rate limits)
    const results: (string | null)[] = [];
    for (const article of batch) {
      const theme = await classifyArticle(env.AI, article).catch(() => null);
      results.push(theme);
    }

    // Mise à jour D1
    const stmts = results
      .map((theme, idx) => ({ hash: batch[idx]!.hash, theme }))
      .filter((row): row is { hash: string; theme: string } => row.theme !== null)
      .map((row) =>
        env.DB.prepare('UPDATE articles SET classified_theme = ? WHERE hash = ?')
          .bind(row.theme, row.hash)
      );

    if (stmts.length > 0) {
      await env.DB.batch(stmts);
      classified += stmts.length;
    }
  }

  console.log(`[Classifier] ${classified}/${articles.length} articles classifiés ✓`);
}
