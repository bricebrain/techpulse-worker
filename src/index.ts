import type { Env, Source } from './types';
import { runCronFetch, runCronEnrich, runCron, fetchAndStoreSource, sendTestPushAlert } from './cron';
import { generateDailyPodcast, generateDeepDivePodcast } from './podcast';
import { generateSuggestions } from './suggester';
import type { DbSuggestion } from './suggester';
import { buildSemanticStoryClusters, semanticSearchArticles } from './semanticSearch';
import { json, err, isAuthorized, makeHash } from './utils';
import { adminPage } from './admin';
import { handleProxy } from './proxy';
import { handleApiV2 } from './api-v2';
import { getNeonAdminStatus, resetRecentNeonAnalyses } from './neon-admin';
import { enrichScienceArticles } from './scienceEnricher';
import { getArticleFeedbackStats, recordArticleFeedback, recordTargetFeedback } from './feedback';

export default {
  // ─── Cron ─────────────────────────────────────────────────────────────────
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // ⚠️ Budget subrequests : chaque invocation cron a son propre budget.
    // Les crons 0 6 * * * et 0 6 * * 5 coïncident avec 0 */2 * * *,
    // donc runCron tourne déjà dans une invocation parallèle.
    // On ne le relance PAS dans les invocations podcast/deep-dive
    // pour ne pas épuiser le budget avant les appels LLM/TTS.
    ctx.waitUntil(
      (async () => {
        // ── Fetch rapide (30 min) : RSS/Reddit + dédup + upsert ─────────────
        if (event.cron === '*/30 * * * *') {
          await runCronFetch(env);
          return;
        }
        // ── Enrichissement (2h) : traduction FR + classification ─────────────
        // NE PAS appeler runCronFetch ici — le cron 30min s'en charge déjà.
        // Garder le budget subrequests entier pour Workers AI (classifier).
        if (event.cron === '0 */2 * * *') {
          await runCronEnrich(env);
          return;
        }
        // ── Podcast quotidien 6h ──────────────────────────────────────────────
        if (event.cron === '0 6 * * *') {
          await generateDailyPodcast(env);
          return;
        }
        // ── Deep Dive vendredi 6h ─────────────────────────────────────────────
        if (event.cron === '0 6 * * 5') {
          await generateDeepDivePodcast(env);
          return;
        }
        // ── Suggestions IA 7h ─────────────────────────────────────────────────
        if (event.cron === '0 7 * * *') {
          await runCronFetch(env);
          await generateSuggestions(env);
          return;
        }
        // Fallback : cron inconnu → fetch complet
        await runCron(env);
      })(),
    );
  },

  // ─── API HTTP ─────────────────────────────────────────────────────────────
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const hasAdminAccess = (): boolean => isAuthorized(req, env.API_SECRET);

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // ── Routes publiques utilisées par l'app ──────────────────────────────

    // ── /proxy/<target>/... — proxy IA public mais fortement contraint ───
    if (path.startsWith('/proxy/')) {
      // Le proxy reste public pour l'app, mais n'autorise qu'une petite
      // allowlist de chemins POST vers les providers réellement utilisés.
      const pathAfterProxy = path.slice('/proxy/'.length); // "openai/v1/chat/completions"
      return handleProxy(req, env, pathAfterProxy);
    }

    const apiV2Response = await handleApiV2(req, env);
    if (apiV2Response) return apiV2Response;

    // ── POST /feedback/article — signal utilisateur pour ranking et Prompt Lab ──
    if (method === 'POST' && path === '/feedback/article') {
      return recordArticleFeedback(req, env);
    }

    if (method === 'POST' && path === '/feedback/target') {
      return recordTargetFeedback(req, env);
    }

    // ── Routes privées de maintenance ─────────────────────────────────────

// ── POST /classify/test — test Workers AI sur un titre ───────────────
    if (method === 'POST' && path === '/classify/test') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      const body = await req.json<{ title?: string; content?: string }>().catch(() => null);
      const { classifyArticle } = await import('./classifier');
      const theme = await classifyArticle(env.AI, {
        title:   body?.title   ?? 'React Native new architecture and Expo performance tips',
        content: body?.content ?? '',
      });
      return json({ classified_theme: theme });
    }

    // ── GET /admin — page d'administration ───────────────────────────────
    if (method === 'GET' && path === '/admin') {
      return adminPage();
    }

    // ── GET /admin/feedback/stats — signaux utilisateur pour Prompt Lab ───
    if (method === 'GET' && path === '/admin/feedback/stats') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      return getArticleFeedbackStats(env);
    }

    // ── GET /articles?theme=youtube&limit=30&classified=ai ───────────────
    if (method === 'GET' && path === '/articles') {
      const theme      = url.searchParams.get('theme');
      const classified = url.searchParams.get('classified'); // filtre optionnel sur classified_theme
      const limit      = Math.min(Number(url.searchParams.get('limit') ?? '50'), 100);

      if (!theme) return err('Paramètre theme requis');

      // Si ?classified=ai → articles YouTube classifiés comme IA
      // Pour les thèmes non-youtube : on inclut automatiquement les vidéos
      // YouTube dont le classified_theme correspond au thème demandé.
      const { results } = classified
        ? await env.DB.prepare(
            `SELECT * FROM articles
             WHERE theme = ? AND classified_theme = ?
             ORDER BY published_at DESC, fetched_at DESC
             LIMIT ?`
          ).bind(theme, classified, limit).all()
        : theme === 'youtube'
        ? await env.DB.prepare(
            `SELECT * FROM articles
             WHERE theme = 'youtube'
             ORDER BY published_at DESC, fetched_at DESC
             LIMIT ?`
          ).bind(limit).all()
        : theme === 'general'
        ? await env.DB.prepare(
            `SELECT * FROM articles
             WHERE theme IN ('general', 'mobile')
                OR (theme = 'youtube' AND classified_theme IN ('general', 'mobile'))
             ORDER BY published_at DESC, fetched_at DESC
             LIMIT ?`
          ).bind(limit).all()
        : theme === 'science'
        ? await env.DB.prepare(
            `SELECT * FROM articles
             WHERE theme = 'science'
             ORDER BY
               CASE WHEN summary_fr IS NOT NULL AND LENGTH(summary_fr) >= 450 THEN 0 ELSE 1 END,
               published_at DESC,
               fetched_at DESC
             LIMIT ?`
          ).bind(limit).all()
        : await env.DB.prepare(
            `SELECT * FROM articles
             WHERE theme = ? OR (theme = 'youtube' AND classified_theme = ?)
             ORDER BY published_at DESC, fetched_at DESC
             LIMIT ?`
          ).bind(theme, theme, limit).all();

      return json({ articles: results, theme, classified: classified ?? null, count: results.length });
    }

    // ── GET /articles/search?q=...&limit=30 — recherche cross-thème ─────
    if (method === 'GET' && path === '/articles/search') {
      const q     = url.searchParams.get('q')?.trim() ?? '';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '30'), 100);

      if (q.length < 2) return json({ articles: [], query: q, count: 0 });

      const pattern = `%${q}%`;
      const cutoff  = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 derniers jours

      const { results } = await env.DB.prepare(
        `SELECT hash, theme, title, title_fr, source_name, url, content, summary_fr, published_at
         FROM articles
         WHERE (title LIKE ? OR content LIKE ? OR title_fr LIKE ?)
           AND published_at > ?
         ORDER BY published_at DESC
         LIMIT ?`
      ).bind(pattern, pattern, pattern, cutoff, limit).all<{
        hash: string; theme: string; title: string; title_fr: string | null;
        source_name: string; url: string | null; content: string | null;
        summary_fr: string | null; published_at: number | null;
      }>();

      return json({ articles: results, query: q, count: results.length });
    }

    // ── GET /articles/semantic-search?q=...&limit=20 — recherche sémantique ─
    if (method === 'GET' && path === '/articles/semantic-search') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '20'), 40);

      if (q.length < 2) return json({ articles: [], query: q, count: 0, provider: null, model: null });

      const result = await semanticSearchArticles(q, env, limit);
      return json({
        articles: result.articles,
        query: q,
        count: result.articles.length,
        provider: result.provider,
        model: result.model,
      });
    }

    // ── GET /stories/recent?limit=8&hours=72 — sujets consolidés ─────────
    if (method === 'GET' && path === '/stories/recent') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '8'), 20);
      const hours = Math.min(Number(url.searchParams.get('hours') ?? '72'), 24 * 14);
      const maxArticlesPerStory = Math.min(Number(url.searchParams.get('per_story') ?? '5'), 8);

      const result = await buildSemanticStoryClusters(env, {
        limit,
        hours,
        maxArticlesPerStory,
      });

      return json({
        stories: result.stories,
        count: result.stories.length,
        provider: result.provider,
        model: result.model,
      });
    }

    // ── GET /articles/recent?limit=15&hours=12 — breaking news cross-thème ─
    if (method === 'GET' && path === '/articles/recent') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '15'), 50);
      const hours = Math.min(Number(url.searchParams.get('hours') ?? '12'), 48);
      const cutoff     = Date.now() - hours * 60 * 60 * 1000;
      const freshCutoff = Date.now() - 2 * 60 * 60 * 1000; // 2h : fenêtre avant enrichissement

      // Filtre qualité :
      //   - Article classifié (classified_theme IS NOT NULL) → vérifié comme tech/finance
      //   - OU très récent (< 2h) et non encore classifié → pas encore passé à l'enrichissement
      const { results } = await env.DB.prepare(
        `SELECT hash, theme, title, title_fr, source_name, url, content, summary_fr, published_at, fetched_at
         FROM articles
         WHERE published_at > ?
           AND (classified_theme IS NOT NULL OR fetched_at > ?)
         ORDER BY published_at DESC
         LIMIT ?`
      ).bind(cutoff, freshCutoff, limit).all();

      return json({ articles: results, hours, count: results.length });
    }

    // ── GET /articles/themes — liste des thèmes disponibles ──────────────
    if (method === 'GET' && path === '/articles/themes') {
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT
           CASE WHEN theme = 'mobile' THEN 'general' ELSE theme END AS theme
         FROM articles
         WHERE theme != 'productivity'
         ORDER BY theme ASC`
      ).all<{ theme: string }>();
      return json({ themes: results.map((r) => r.theme) });
    }

    // ── GET /sources?theme=youtube ────────────────────────────────────────
    if (method === 'GET' && path === '/sources') {
      const theme = url.searchParams.get('theme');
      const query = theme
        ? env.DB.prepare('SELECT * FROM sources WHERE theme = ? ORDER BY is_default DESC, name ASC').bind(theme)
        : env.DB.prepare('SELECT * FROM sources ORDER BY theme ASC, is_default DESC, name ASC');

      const { results } = await query.all();
      return json({ sources: results });
    }

    // ── POST /sources — ajouter une source (requiert API_SECRET) ─────────
    if (method === 'POST' && path === '/sources') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const body = await req.json<Partial<Source>>().catch(() => null);
      if (!body?.name || !body.theme || !body.type || !body.value) {
        return err('Champs requis : name, theme, type, value');
      }

      const id = `src_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      const limit = Math.max(1, Math.min(20, body.limit_count ?? 5));

      await env.DB.prepare(
        `INSERT INTO sources (id, name, theme, type, value, limit_count, is_active, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
      ).bind(id, body.name, body.theme, body.type, body.value, limit, now, now).run();

      // Fetch immédiat de la nouvelle source (sans attendre le cron)
      const newSource: Source = {
        id, name: body.name, theme: body.theme,
        type: body.type as Source['type'], value: body.value,
        limit_count: limit, is_active: 1, is_default: 0,
        created_at: now, updated_at: now,
      };
      ctx.waitUntil(fetchAndStoreSource(newSource, env));

      return json({ id, message: 'Source créée' }, 201);
    }

    // ── POST /sources/sync — upsert bulk depuis l'app mobile ─────────────
    if (method === 'POST' && path === '/sources/sync') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const body = await req.json<{ sources?: Partial<Source>[] }>().catch(() => null);
      const list = body?.sources ?? [];
      if (!list.length) return json({ synced: 0 });

      const validList = list.filter((s) => s.id && s.name && s.theme && s.type && s.value);
      if (!validList.length) return json({ synced: 0 });

      // Détecter les sources déjà connues pour ne fetcher que les nouvelles
      const ids = validList.map((s) => s.id as string);
      const placeholders = ids.map(() => '?').join(',');
      const { results: existingRows } = await env.DB.prepare(
        `SELECT id FROM sources WHERE id IN (${placeholders})`
      ).bind(...ids).all<{ id: string }>();
      const knownIds = new Set(existingRows.map((r) => r.id));

      const now = new Date().toISOString();
      const stmts = validList.map((s) =>
        env.DB.prepare(
          `INSERT INTO sources (id, name, theme, type, value, limit_count, is_active, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name        = excluded.name,
             limit_count = excluded.limit_count,
             updated_at  = excluded.updated_at`
        ).bind(s.id, s.name, s.theme, s.type, s.value, s.limit_count ?? 5, now, now)
      );

      await env.DB.batch(stmts);

      // Fetch immédiat uniquement pour les sources vraiment nouvelles
      const newSources: Source[] = validList
        .filter((s) => !knownIds.has(s.id as string))
        .map((s) => ({
          id: s.id as string,
          name: s.name as string,
          theme: s.theme as string,
          type: s.type as Source['type'],
          value: s.value as string,
          limit_count: s.limit_count ?? 5,
          is_active: 1, is_default: 0,
          created_at: now, updated_at: now,
        }));

      if (newSources.length > 0) {
        ctx.waitUntil(Promise.all(newSources.map((src) => fetchAndStoreSource(src, env))));
      }

      return json({ synced: stmts.length, fetching: newSources.length });
    }

    // ── PUT /sources/:id ──────────────────────────────────────────────────
    if (method === 'PUT' && path.startsWith('/sources/')) {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const id = path.split('/')[2];
      const body = await req.json<Partial<Source>>().catch(() => null);
      if (!body) return err('Body invalide');

      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE sources SET
          name        = COALESCE(?, name),
          is_active   = COALESCE(?, is_active),
          limit_count = COALESCE(?, limit_count),
          updated_at  = ?
         WHERE id = ?`
      ).bind(body.name ?? null, body.is_active ?? null, body.limit_count ?? null, now, id).run();

      return json({ message: 'Source mise à jour' });
    }

    // ── DELETE /sources/:id ───────────────────────────────────────────────
    if (method === 'DELETE' && path.startsWith('/sources/')) {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const id = path.split('/')[2];
      await env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(id).run();
      return json({ message: 'Source supprimée' });
    }

    // ── POST /articles/ingest — ingestion d'articles depuis l'app mobile ────
    // Utilisé pour pousser les articles Reddit (IP téléphone non bloquée par Reddit)
    if (method === 'POST' && path === '/articles/ingest') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      interface IngestArticle {
        hash?: string;
        theme: string;
        title: string;
        source_name?: string;
        url?: string | null;
        content?: string | null;
        published_at?: number | null;
      }

      const body = await req.json<{ articles?: IngestArticle[] }>().catch(() => null);
      const list = (body?.articles ?? []).filter((a) => a.title && a.theme);
      if (!list.length) return json({ ingested: 0 });

      const now = Date.now();
      const stmts = list.map((a) => {
        const hash = a.hash || makeHash(`${a.source_name ?? 'unknown'}|${a.url || a.title}`);
        return env.DB.prepare(
          `INSERT INTO articles (hash, theme, title, source_name, url, content, published_at, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hash) DO UPDATE SET fetched_at = excluded.fetched_at`
        ).bind(hash, a.theme, a.title, a.source_name ?? null, a.url ?? null, a.content ?? null, a.published_at ?? null, now);
      });

      await env.DB.batch(stmts);
      return json({ ingested: stmts.length });
    }

    // ── POST /devices/register — enregistrer token push + keywords ────────
    if (method === 'POST' && path === '/devices/register') {
      const body = await req.json<{ token?: string; platform?: string; keywords?: string[] }>().catch(() => null);
      if (!body?.token) return err('token requis');
      const token = body.token.trim();
      if (token.length < 16 || token.length > 4096) return err('token invalide');

      const now = new Date().toISOString();
      const keywords = JSON.stringify(
        (body.keywords ?? [])
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 0 && k.length <= 64)
          .slice(0, 20),
      );
      const platform = (body.platform ?? 'unknown').trim().slice(0, 32) || 'unknown';

      await env.DB.prepare(
        `INSERT INTO devices (token, platform, keywords, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET keywords = excluded.keywords, updated_at = excluded.updated_at`
      ).bind(token, platform, keywords, now, now).run();

      return json({ registered: true });
    }

    // ── DELETE /devices/:token — désenregistrer un appareil ────────────────
    if (method === 'DELETE' && path.startsWith('/devices/')) {
      const token = decodeURIComponent(path.split('/')[2] ?? '');
      if (!token || token.length < 16 || token.length > 4096) return err('token invalide');
      await env.DB.prepare('DELETE FROM devices WHERE token = ?').bind(token).run();
      return json({ unregistered: true });
    }

    // ── POST /push/test — envoi manuel d'une notification de test ────────
    if (method === 'POST' && path === '/push/test') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const body = await req.json<{
        token?: string;
        title?: string;
        body?: string;
        theme?: string;
        hash?: string;
      }>().catch(() => null);

      let token = body?.token?.trim() ?? '';
      if (!token) {
        const latest = await env.DB.prepare(
          'SELECT token FROM devices ORDER BY updated_at DESC LIMIT 1'
        ).first<{ token: string }>();
        token = latest?.token?.trim() ?? '';
      }

      if (!token || token.length < 16 || token.length > 4096) {
        return err('Aucun token device exploitable trouvé', 404);
      }

      const responses = await sendTestPushAlert(token, {
        title: body?.title,
        body: body?.body,
        data: {
          theme: body?.theme?.trim() || 'ai',
          hash: body?.hash?.trim() || 'push-test',
        },
      });

      return json({
        sent: true,
        token,
        responses,
      });
    }

    // ── POST /cron/trigger — déclencher le cron fetch manuellement ───────
    if (method === 'POST' && path === '/cron/trigger') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      ctx.waitUntil(runCronFetch(env));
      return json({ message: 'Cron fetch lancé en arrière-plan' });
    }

    // ── POST /cron/enrich — traduction FR + classification ────────────────
    if (method === 'POST' && path === '/cron/enrich') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      ctx.waitUntil(runCronEnrich(env));
      return json({ message: 'Cron enrich lancé en arrière-plan' });
    }

    // ── POST /admin/reprocess/science — régénérer des fiches science ─────
    if (method === 'POST' && path === '/admin/reprocess/science') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '4'), 1), 8);
      ctx.waitUntil(enrichScienceArticles(env, { force: true, limit }));
      return json({ message: `Retraitement Science lancé (${limit} articles max).` });
    }

    // ── POST /admin/reprocess/analyses — remettre Neon en file ────────────
    if (method === 'POST' && path === '/admin/reprocess/analyses') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      return resetRecentNeonAnalyses(env);
    }

    // ── GET /podcasts — liste des podcasts auto-générés ───────────────────
    if (method === 'GET' && path === '/podcasts') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '7'), 20);
      const { results } = await env.DB.prepare(
        `SELECT id, title, theme, COALESCE(format, 'daily') as format,
                generated_at, segment_count, segments_json, created_at
         FROM podcast_feed
         WHERE is_ready = 1
         ORDER BY generated_at DESC
         LIMIT ?`,
      ).bind(limit).all<{
        id: string; title: string; theme: string; format: string;
        generated_at: number; segment_count: number;
        segments_json: string; created_at: string;
      }>();

      const podcasts = results.map((p) => ({
        id: p.id,
        title: p.title,
        theme: p.theme,
        format: p.format,
        generated_at: p.generated_at,
        segment_count: p.segment_count,
        segments: (() => { try { return JSON.parse(p.segments_json); } catch { return []; } })(),
        created_at: p.created_at,
      }));

      return json({ podcasts, count: podcasts.length });
    }

    // ── GET /podcasts/:id/segments/:index — stream MP3 depuis R2 ─────────
    if (method === 'GET' && path.startsWith('/podcasts/')) {
      const parts = path.split('/'); // ['', 'podcasts', id, 'segments', index]
      if (parts.length === 5 && parts[3] === 'segments') {
        const podId = parts[2];
        const segIndex = parseInt(parts[4] ?? '', 10);

        if (!podId || isNaN(segIndex)) return err('Paramètres invalides');
        if (!env.PODCASTS) return err('R2 non configuré', 503);

        // Ordre de priorité : mp3 (Edge-TTS) → aac (OpenAI fallback) → wav (legacy)
        let obj = await env.PODCASTS.get(`podcasts/${podId}/${segIndex}.mp3`);
        let contentType = 'audio/mpeg';
        if (!obj) { obj = await env.PODCASTS.get(`podcasts/${podId}/${segIndex}.aac`); contentType = 'audio/aac'; }
        if (!obj) { obj = await env.PODCASTS.get(`podcasts/${podId}/${segIndex}.wav`); contentType = 'audio/wav'; }
        if (!obj) return err('Segment audio introuvable', 404);

        return new Response(obj.body, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }

    // ── POST /podcasts/generate — TechBrief quotidien manuellement ────────
    if (method === 'POST' && path === '/podcasts/generate') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      // ?sync=1 : attend la fin et retourne le résultat (debug uniquement)
      if (url.searchParams.get('sync') === '1') {
        const t0 = Date.now();
        console.log(`[SyncGen] Démarrage à ${t0}`);
        try {
          console.log(`[SyncGen] PODCASTS=${!!env.PODCASTS} OPENAI=${!!env.OPENAI_API_KEY} GROQ=${!!(env.GROQ_API_KEY_1 ?? env.GROQ_API_KEY_2)}`);
          const generation = await generateDailyPodcast(env);
          const elapsed = Date.now() - t0;
          console.log(`[SyncGen] generateDailyPodcast terminé en ${elapsed}ms (${generation.status})`);
          const result = await env.DB.prepare(
            `SELECT id, title FROM podcast_feed ORDER BY generated_at DESC LIMIT 1`
          ).first<{ id: string; title: string }>();
          return json({
            done: generation.status === 'generated',
            skipped: generation.status === 'skipped',
            reason: generation.reason ?? null,
            elapsed_ms: elapsed,
            generated: generation.podcastId
              ? { id: generation.podcastId, title: generation.title ?? null }
              : null,
            latest: result ?? null,
          }, generation.reason === 'podcast_generation_already_running' ? 202 : 200);
        } catch (e) {
          console.error(`[SyncGen] Exception: ${String(e)}`);
          return json({ done: false, error: String(e), elapsed_ms: Date.now() - t0 }, 500);
        }
      }
      ctx.waitUntil(generateDailyPodcast(env));
      return json({ message: 'Génération TechBrief lancée en arrière-plan' });
    }

    // ── DELETE /podcasts/:id — supprimer un podcast (D1 + R2) ───────────────
    if (method === 'DELETE' && path.startsWith('/podcasts/') && path.split('/').length === 3) {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      const podId = path.split('/')[2];
      if (!podId) return err('ID manquant');

      const pod = await env.DB.prepare(
        'SELECT id, segment_count FROM podcast_feed WHERE id = ?'
      ).bind(podId).first<{ id: string; segment_count: number }>();
      if (!pod) return err('Podcast introuvable', 404);

      // Supprimer les segments R2 (toutes extensions)
      if (env.PODCASTS) {
        const exts = ['mp3', 'aac', 'wav'];
        const keys = exts.flatMap((ext) =>
          Array.from({ length: pod.segment_count }, (_, i) => `podcasts/${podId}/${i}.${ext}`),
        );
        await env.PODCASTS.delete(keys);
      }

      await env.DB.prepare('DELETE FROM podcast_feed WHERE id = ?').bind(podId).run();
      return json({ deleted: podId });
    }

    // ── POST /podcasts/generate-deep-dive — Deep Dive manuellement ─────────
    if (method === 'POST' && path === '/podcasts/generate-deep-dive') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      if (url.searchParams.get('sync') === '1') {
        const t0 = Date.now();
        try {
          const generation = await generateDeepDivePodcast(env);
          return json({
            done: generation.status === 'generated',
            skipped: generation.status === 'skipped',
            reason: generation.reason ?? null,
            elapsed_ms: Date.now() - t0,
            generated: generation.podcastId
              ? { id: generation.podcastId, title: generation.title ?? null }
              : null,
          }, generation.reason === 'podcast_generation_already_running' ? 202 : 200);
        } catch (e) {
          return json({ done: false, error: String(e), elapsed_ms: Date.now() - t0 }, 500);
        }
      }
      ctx.waitUntil(generateDeepDivePodcast(env));
      return json({ message: 'Génération Deep Dive lancée en arrière-plan' });
    }

    // ── GET /suggestions — liste des suggestions en attente ──────────────
    if (method === 'GET' && path === '/suggestions') {
      const { results } = await env.DB.prepare(
        `SELECT * FROM suggestions
         WHERE is_applied = 0 AND is_dismissed = 0
         ORDER BY generated_at DESC`,
      ).all<DbSuggestion>();

      const suggestions = results.map((s) => ({
        ...s,
        extra: (() => { try { return JSON.parse(s.extra_json); } catch { return {}; } })(),
      }));

      return json({ suggestions, count: suggestions.length });
    }

    // ── POST /suggestions/:id/apply — appliquer une suggestion ───────────
    if (method === 'POST' && path.startsWith('/suggestions/') && path.endsWith('/apply')) {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const id = path.split('/')[2];
      const sug = await env.DB.prepare(
        'SELECT * FROM suggestions WHERE id = ?',
      ).bind(id).first<DbSuggestion>();

      if (!sug) return err('Suggestion introuvable', 404);

      const now = new Date().toISOString();

      if (sug.type === 'youtube_channel') {
        // Ajouter directement comme source
        const sourceId = `src_sug_${Math.random().toString(36).slice(2, 8)}`;
        const theme = sug.theme ?? 'general';
        await env.DB.prepare(
          `INSERT OR IGNORE INTO sources
             (id, name, theme, type, value, limit_count, is_active, is_default, created_at, updated_at)
           VALUES (?, ?, ?, 'youtube_channel', ?, 8, 1, 0, ?, ?)`,
        ).bind(sourceId, sug.name, theme, sug.value, now, now).run();
        ctx.waitUntil(
          (async () => {
            const src = { id: sourceId, name: sug.name, theme, type: 'youtube_channel' as const, value: sug.value, limit_count: 8, is_active: 1, is_default: 0, created_at: now, updated_at: now };
            const { fetchAndStoreSource } = await import('./cron');
            await fetchAndStoreSource(src, env);
          })(),
        );
      } else if (sug.type === 'new_theme') {
        // Ajouter les sources de démarrage
        const extra = (() => { try { return JSON.parse(sug.extra_json); } catch { return {}; } })();
        const starters: Array<{ type: string; name: string; value: string }> = extra.starter_sources ?? [];
        const stmts = starters.map((src) => {
          const sourceId = `src_sug_${Math.random().toString(36).slice(2, 8)}`;
          return env.DB.prepare(
            `INSERT OR IGNORE INTO sources
               (id, name, theme, type, value, limit_count, is_active, is_default, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 8, 1, 0, ?, ?)`,
          ).bind(sourceId, src.name, sug.value, src.type, src.value, now, now);
        });
        if (stmts.length) await env.DB.batch(stmts);
        // Fetch immédiat des nouvelles sources
        ctx.waitUntil(
          (async () => {
            const { fetchAndStoreSource } = await import('./cron');
            for (const src of starters) {
              const sourceId = `src_sug_${Math.random().toString(36).slice(2, 6)}`;
              const s = { id: sourceId, name: src.name, theme: sug.value, type: src.type as 'youtube_channel' | 'rss', value: src.value, limit_count: 8, is_active: 1, is_default: 0, created_at: now, updated_at: now };
              await fetchAndStoreSource(s, env);
            }
          })(),
        );
      }

      await env.DB.prepare(
        'UPDATE suggestions SET is_applied = 1 WHERE id = ?',
      ).bind(id).run();

      return json({ message: 'Suggestion appliquée', id });
    }

    // ── DELETE /suggestions/:id — ignorer une suggestion ─────────────────
    if (method === 'DELETE' && path.startsWith('/suggestions/')) {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const id = path.split('/')[2];
      await env.DB.prepare(
        'UPDATE suggestions SET is_dismissed = 1 WHERE id = ?',
      ).bind(id).run();

      return json({ message: 'Suggestion ignorée', id });
    }

    // ── POST /suggestions/generate — déclencher manuellement ─────────────
    if (method === 'POST' && path === '/suggestions/generate') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      ctx.waitUntil(generateSuggestions(env));
      return json({ message: 'Analyse de suggestions lancée en arrière-plan' });
    }

    // ── GET /analyses?hashes=h1,h2,... — batch fetch analyses depuis D1 ───────
    // Utilisé par l'app avant de lancer l'IA : "est-ce que cette analyse existe déjà ?"
    if (method === 'GET' && path === '/analyses') {
      const rawHashes = url.searchParams.get('hashes') ?? '';
      const hashes = rawHashes
        .split(',')
        .map((h) => h.trim())
        .filter((h) => /^[a-z0-9_-]{4,120}$/i.test(h))
        .slice(0, 50);
      if (!hashes.length) return json({ analyses: [] });

      const placeholders = hashes.map(() => '?').join(',');
      const { results } = await env.DB.prepare(
        `SELECT article_hash, title, source_name, url, analysis_en, summary_fr, impact_fr,
                analysis_status, analysis_data, model_used, updated_at
         FROM article_analyses WHERE article_hash IN (${placeholders})`
      ).bind(...hashes).all<{
        article_hash: string; title: string; source_name: string | null; url: string | null;
        analysis_en: string | null; summary_fr: string | null; impact_fr: string | null;
        analysis_status: string; analysis_data: string | null; model_used: string | null;
        updated_at: number;
      }>();

      return json({ analyses: results, count: results.length });
    }

    // ── POST /analyses — upsert une ou plusieurs analyses ────────────────────
    // L'app pousse l'analyse après génération IA locale.
    if (method === 'POST' && path === '/analyses') {
      interface AnalysisInput {
        article_hash: string;
        title: string;
        source_name?: string | null;
        url?: string | null;
        analysis_en?: string | null;
        summary_fr?: string | null;
        impact_fr?: string | null;
        analysis_status?: string;
        analysis_data?: string | null;
        model_used?: string | null;
      }

      const body = await req.json<{ analyses?: AnalysisInput[]; analysis?: AnalysisInput }>().catch(() => null);
      const list: AnalysisInput[] = (body?.analyses ?? (body?.analysis ? [body.analysis] : [])).slice(0, 20);

      const valid = list.filter((a) =>
        /^[a-z0-9_-]{4,120}$/i.test(a.article_hash)
        && typeof a.title === 'string'
        && a.title.trim().length > 0
        && a.title.length <= 300
        && (a.analysis_en == null || a.analysis_en.length <= 20_000)
        && (a.summary_fr == null || a.summary_fr.length <= 5_000)
        && (a.impact_fr == null || a.impact_fr.length <= 5_000)
        && (a.analysis_data == null || a.analysis_data.length <= 50_000),
      );
      if (!valid.length) return json({ upserted: 0 });

      const now = Date.now();
      const stmts = valid.map((a) =>
        env.DB.prepare(
          `INSERT INTO article_analyses
             (article_hash, title, source_name, url, analysis_en, summary_fr, impact_fr,
              analysis_status, analysis_data, model_used, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(article_hash) DO UPDATE SET
             analysis_en     = COALESCE(excluded.analysis_en, analysis_en),
             summary_fr      = COALESCE(excluded.summary_fr, summary_fr),
             impact_fr       = COALESCE(excluded.impact_fr, impact_fr),
             analysis_status = excluded.analysis_status,
             analysis_data   = COALESCE(excluded.analysis_data, analysis_data),
             model_used      = COALESCE(excluded.model_used, model_used),
             updated_at      = excluded.updated_at`
        ).bind(
          a.article_hash, a.title, a.source_name ?? null, a.url ?? null,
          a.analysis_en ?? null, a.summary_fr ?? null, a.impact_fr ?? null,
          a.analysis_status ?? 'done', a.analysis_data ?? null, a.model_used ?? null,
          now, now,
        )
      );

      await env.DB.batch(stmts);
      return json({ upserted: valid.length });
    }

    // ── GET /analyses/radar — Tech Radar aggrégé sur les analyses D1 ─────────
    // Retourne signaux, technos, horizons, et exemples récents par signal.
    if (method === 'GET' && path === '/analyses/radar') {
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 jours

      const [signals, rawAnalyses, total] = await Promise.all([
        // Distribution des signaux avec avg impact et horizon dominant
        env.DB.prepare(
          `SELECT
             json_extract(analysis_data, '$.actionSignal') as signal,
             COUNT(*) as n,
             ROUND(AVG(CAST(json_extract(analysis_data, '$.impactScore') AS REAL)), 1) as avg_impact
           FROM article_analyses
           WHERE analysis_data IS NOT NULL AND updated_at > ?
           GROUP BY signal
           ORDER BY n DESC`
        ).bind(cutoff).all<{ signal: string | null; n: number; avg_impact: number | null }>(),

        // Récupère les analysis_data bruts pour agréger les technos en JS
        env.DB.prepare(
          `SELECT title, analysis_data FROM article_analyses
           WHERE analysis_data IS NOT NULL AND updated_at > ?
           ORDER BY updated_at DESC LIMIT 100`
        ).bind(cutoff).all<{ title: string; analysis_data: string }>(),

        env.DB.prepare(
          `SELECT COUNT(*) as n FROM article_analyses WHERE analysis_data IS NOT NULL AND updated_at > ?`
        ).bind(cutoff).first<{ n: number }>(),
      ]);

      // Agrégation JS : technos par signal + top technos globales + exemples par signal
      const techGlobal: Record<string, number> = {};
      const techBySignal: Record<string, Record<string, number>> = {};
      const examplesBySignal: Record<string, string[]> = {};

      for (const row of rawAnalyses.results) {
        try {
          const d = JSON.parse(row.analysis_data) as {
            actionSignal?: string;
            keyTechnologies?: string[];
            impactScore?: number;
          };
          const sig = d.actionSignal ?? 'watch';

          // Technos
          for (const tech of d.keyTechnologies ?? []) {
            techGlobal[tech] = (techGlobal[tech] ?? 0) + 1;
            if (!techBySignal[sig]) techBySignal[sig] = {};
            techBySignal[sig][tech] = (techBySignal[sig][tech] ?? 0) + 1;
          }

          // Exemple (3 titres max par signal)
          if (!examplesBySignal[sig]) examplesBySignal[sig] = [];
          if (examplesBySignal[sig].length < 3) {
            examplesBySignal[sig].push(row.title);
          }
        } catch { /* JSON corrompu, on ignore */ }
      }

      // Top technos globales (max 20)
      const topTechnologies = Object.entries(techGlobal)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([tech, n]) => ({ tech, n }));

      // Top technos par signal (max 5)
      const topTechBySignal: Record<string, { tech: string; n: number }[]> = {};
      for (const [sig, counts] of Object.entries(techBySignal)) {
        topTechBySignal[sig] = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([tech, n]) => ({ tech, n }));
      }

      return json({
        total: total?.n ?? 0,
        period_days: 90,
        signals: signals.results,
        topTechnologies,
        topTechBySignal,
        examplesBySignal,
      });
    }

    // ── POST /podcasts/debug2 — trace étape par étape de la génération ──────
    if (method === 'POST' && path === '/podcasts/debug2') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const steps: Record<string, unknown> = { ts: Date.now() };

      // Étape 1 : articles récents
      const cutoff = Date.now() - 24 * 3600 * 1000;
      const { results: arts } = await env.DB.prepare(
        `SELECT title, source_name, content, published_at FROM articles WHERE published_at > ? ORDER BY published_at DESC LIMIT 20`
      ).bind(cutoff).all<{ title: string; source_name: string; content: string | null; published_at: number | null }>();
      steps.articles_found = arts.length;
      if (arts.length < 3) return json({ ...steps, blocker: 'not_enough_articles' });
      steps.article_sample = arts[0]?.title;

      // Étape 2 : appel Groq (prompt réduit pour rapidité)
      const groqKey = env.GROQ_API_KEY_1 ?? env.GROQ_API_KEY_2;
      if (!groqKey) return json({ ...steps, blocker: 'no_groq_key' });

      const articleList = arts.slice(0, 3)
        .map((a, i) => `Article ${i + 1}: "${a.title}" (${a.source_name})`)
        .join('\n');

      const groqStart = Date.now();
      let groqBody: Response | null = null;
      try {
        groqBody = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 80,
            messages: [{ role: 'user', content: `Ces articles tech sont-ils intéressants ? Réponds "oui" ou "non".\n${articleList}` }],
          }),
          signal: AbortSignal.timeout(20_000),
        });
        steps.groq_status = groqBody.status;
        steps.groq_ms = Date.now() - groqStart;
        if (!groqBody.ok) {
          steps.groq_error = await groqBody.text().catch(() => '');
          return json({ ...steps, blocker: 'groq_failed' });
        }
        const gd = await groqBody.json<{ choices?: { message?: { content?: string } }[]; usage?: unknown }>();
        steps.groq_reply = gd.choices?.[0]?.message?.content?.slice(0, 50);
        steps.groq_usage = gd.usage;
      } catch (e) {
        steps.groq_error = String(e);
        steps.groq_ms = Date.now() - groqStart;
        return json({ ...steps, blocker: 'groq_exception' });
      }

      // Étape 3 : TTS OpenAI sur un texte court
      if (env.OPENAI_API_KEY) {
        const ttsStart = Date.now();
        try {
          const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'gpt-4o-mini-tts', voice: 'alloy',
              input: 'Bienvenue dans TechBrief, votre podcast tech du jour.',
              response_format: 'aac',
            }),
            signal: AbortSignal.timeout(20_000),
          });
          steps.tts_status = ttsRes.status;
          steps.tts_ms = Date.now() - ttsStart;
          if (ttsRes.ok) {
            const buf = await ttsRes.arrayBuffer();
            steps.tts_bytes = buf.byteLength;
          } else {
            steps.tts_error = await ttsRes.text().catch(() => '');
          }
        } catch (e) {
          steps.tts_error = String(e);
          steps.tts_ms = Date.now() - ttsStart;
        }
      }

      // Étape 4 : test R2 write/read
      if (env.PODCASTS) {
        try {
          await env.PODCASTS.put('debug/test.txt', 'ok', { httpMetadata: { contentType: 'text/plain' } });
          const obj = await env.PODCASTS.get('debug/test.txt');
          steps.r2_write_read = obj ? 'ok' : 'write_ok_read_fail';
          await env.PODCASTS.delete('debug/test.txt');
        } catch (e) {
          steps.r2_error = String(e);
        }
      }

      steps.total_ms = Date.now() - (steps.ts as number);
      return json(steps);
    }

    // ── POST /podcasts/debug — diagnostic complet de la chaîne TTS ────────
    if (method === 'POST' && path === '/podcasts/debug') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const report: Record<string, unknown> = {};

      // 1. Articles disponibles
      const arts = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM articles WHERE fetched_at > ?`
      ).bind(Date.now() - 12 * 3600 * 1000).first<{ cnt: number }>();
      report.articles_last_12h = arts?.cnt ?? 0;

      // 2. Podcasts en base
      const pods = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM podcast_feed`
      ).first<{ cnt: number }>();
      report.podcasts_total = pods?.cnt ?? 0;

      // 3. Variables d'env disponibles
      report.env = {
        GROQ_API_KEY_1: !!env.GROQ_API_KEY_1,
        GROQ_API_KEY_2: !!env.GROQ_API_KEY_2,
        OPENAI_API_KEY: !!env.OPENAI_API_KEY,
        REDDIT_PROXY_URL: env.REDDIT_PROXY_URL || null,
        REDDIT_PROXY_SECRET: !!env.REDDIT_PROXY_SECRET,
        HF_TOKEN: !!(env as unknown as Record<string, unknown>).HF_TOKEN,
        PODCASTS_R2: !!env.PODCASTS,
      };

      // 4. Test FastAPI /health ou /api/v1/tts/podcast-segment
      if (env.REDDIT_PROXY_URL && env.REDDIT_PROXY_SECRET) {
        const baseUrl = env.REDDIT_PROXY_URL.replace(/\/$/, '');
        try {
          // Test ping via docs ou root
          const pingRes = await fetch(`${baseUrl}/docs`, {
            signal: AbortSignal.timeout(10_000),
          });
          report.fastapi_docs_status = pingRes.status;
        } catch (e) {
          report.fastapi_docs_error = String(e);
        }

        // Test TTS court (5 mots)
        try {
          const ttsRes = await fetch(`${baseUrl}/api/v1/tts/podcast-segment`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.REDDIT_PROXY_SECRET}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: 'Bonjour, test audio.',
              voice: 'host',
              provider: 'edge_tts',
              response_format: 'mp3',
            }),
            signal: AbortSignal.timeout(60_000),
          });
          report.fastapi_tts_status = ttsRes.status;
          if (ttsRes.ok) {
            const buf = await ttsRes.arrayBuffer();
            report.fastapi_tts_bytes = buf.byteLength;
          } else {
            report.fastapi_tts_error = await ttsRes.text().catch(() => '');
          }
        } catch (e) {
          report.fastapi_tts_error = String(e);
        }
      } else {
        report.fastapi_tts_status = 'skipped — REDDIT_PROXY_URL ou SECRET manquant';
      }

      // 5. Test OpenAI TTS si disponible
      if (env.OPENAI_API_KEY) {
        try {
          const oaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini-tts',
              voice: 'alloy',
              input: 'Test.',
              response_format: 'aac',
            }),
            signal: AbortSignal.timeout(20_000),
          });
          report.openai_tts_status = oaiRes.status;
          if (oaiRes.ok) {
            const buf = await oaiRes.arrayBuffer();
            report.openai_tts_bytes = buf.byteLength;
          } else {
            report.openai_tts_error = await oaiRes.text().catch(() => '');
          }
        } catch (e) {
          report.openai_tts_error = String(e);
        }
      } else {
        report.openai_tts_status = 'skipped — OPENAI_API_KEY absent';
      }

      // 6. Test Groq LLM
      const groqKey = env.GROQ_API_KEY_1 ?? env.GROQ_API_KEY_2;
      if (groqKey) {
        try {
          const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${groqKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: 'Réponds juste "ok".' }],
              max_tokens: 5,
            }),
            signal: AbortSignal.timeout(15_000),
          });
          report.groq_status = groqRes.status;
          if (!groqRes.ok) {
            const errText = await groqRes.text().catch(() => '');
            report.groq_error = errText;
          }
        } catch (e) {
          report.groq_error = String(e);
        }
      } else {
        report.groq_status = 'skipped — GROQ_API_KEY_1 et GROQ_API_KEY_2 absents';
      }

      return json(report);
    }

    // ── POST /grok/fetch — teste + insère toutes les sources grok_live ────
    if (method === 'POST' && path === '/grok/fetch') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      const { fetchGrokLive } = await import('./fetchers/grok');

      const { results: grokSources } = await env.DB.prepare(
        `SELECT * FROM sources WHERE type = 'grok_live' AND is_active = 1`,
      ).all<import('./types').Source>();

      const report: Array<{ source: string; fetched: number; articles: string[] }> = [];
      const allArticles: import('./types').Article[] = [];

      for (const src of grokSources) {
        const articles = await fetchGrokLive(src, env);
        report.push({ source: src.name, fetched: articles.length, articles: articles.map((a) => a.title) });
        allArticles.push(...articles);
      }

      if (allArticles.length > 0) {
        const stmts = allArticles.map((a) =>
          env.DB.prepare(
            `INSERT INTO articles (hash, theme, title, source_name, url, content, published_at, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(hash) DO UPDATE SET fetched_at = excluded.fetched_at`,
          ).bind(a.hash, a.theme, a.title, a.source_name, a.url, a.content, a.published_at, a.fetched_at),
        );
        await env.DB.batch(stmts);
      }
      return json({ total: allArticles.length, sources: report });
    }

    // ── POST /grok/test — test rapide Grok live search (Responses API) ───
    if (method === 'POST' && path === '/grok/test') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      const report: Record<string, unknown> = { has_key: !!env.XAI_API_KEY };
      if (!env.XAI_API_KEY) return json({ ...report, error: 'XAI_API_KEY manquant' });

      const t0 = Date.now();
      try {
        const res = await fetch('https://api.x.ai/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'grok-3',
            input: [{ role: 'user', content: 'Give me 2 very recent AI news headlines as JSON array: [{"title":"...","url":"https://..."}]. ONLY the JSON array.' }],
            tools: [{ type: 'web_search' }],
            max_output_tokens: 300,
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        report.status = res.status;
        report.ms = Date.now() - t0;
        const body = await res.text();
        if (res.ok) {
          const d = JSON.parse(body) as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>; model?: string; status?: string };
          report.model_used = d.model;
          report.api_status = d.status;
          const text = d.output?.find(o => o.type === 'message')?.content?.find(c => c.type === 'output_text')?.text ?? '';
          report.reply = text.slice(0, 400);
        } else {
          report.error = body.slice(0, 400);
        }
      } catch (e) {
        report.error = String(e);
        report.ms = Date.now() - t0;
      }
      return json(report);
    }

    // ── POST /grok/llm-test — test grok-4.3 chat completions (même API que podcast) ──
    if (method === 'POST' && path === '/grok/llm-test') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      const report: Record<string, unknown> = { has_key: !!env.XAI_API_KEY, model: 'grok-4.3' };
      if (!env.XAI_API_KEY) return json({ ...report, error: 'XAI_API_KEY manquant' });

      const t0 = Date.now();
      try {
        const res = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'grok-4.3',
            max_tokens: 80,
            temperature: 0.5,
            messages: [
              { role: 'system', content: 'Tu es un assistant concis. Réponds en JSON uniquement.' },
              { role: 'user', content: 'Donne une actu tech fictive : {"title":"...","summary":"..."}' },
            ],
          }),
          signal: AbortSignal.timeout(60_000),
        });
        report.status = res.status;
        report.ms = Date.now() - t0;
        const body = await res.text();
        if (res.ok) {
          const d = JSON.parse(body) as { choices?: { message?: { content?: string } }[]; model?: string; usage?: unknown };
          report.model_used = d.model;
          report.usage = d.usage;
          report.reply = d?.choices?.[0]?.message?.content?.slice(0, 300) ?? '';
        } else {
          report.error = body.slice(0, 500);
        }
      } catch (e) {
        report.error = String(e);
        report.ms = Date.now() - t0;
      }
      return json(report);
    }

    // ── GET /admin/stats — monitoring Worker (health check aggrégé) ──────────
    if (method === 'GET' && path === '/admin/stats') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);

      const now = Date.now();
      const h1  = now - 1  * 60 * 60 * 1000;
      const h6  = now - 6  * 60 * 60 * 1000;
      const h24 = now - 24 * 60 * 60 * 1000;

      const [
        total,
        last1h,
        last6h,
        last24h,
        by_theme,
        sources,
        podcasts,
        devices,
        latest_podcast,
        latest_article,
      ] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as n FROM articles').first<{ n: number }>(),
        env.DB.prepare('SELECT COUNT(*) as n FROM articles WHERE fetched_at > ?').bind(h1).first<{ n: number }>(),
        env.DB.prepare('SELECT COUNT(*) as n FROM articles WHERE fetched_at > ?').bind(h6).first<{ n: number }>(),
        env.DB.prepare('SELECT COUNT(*) as n FROM articles WHERE fetched_at > ?').bind(h24).first<{ n: number }>(),
        env.DB.prepare('SELECT theme, COUNT(*) as n FROM articles WHERE fetched_at > ? GROUP BY theme ORDER BY n DESC').bind(h24).all<{ theme: string; n: number }>(),
        env.DB.prepare('SELECT COUNT(*) as total, SUM(is_active) as active FROM sources').first<{ total: number; active: number }>(),
        env.DB.prepare('SELECT COUNT(*) as total FROM podcast_feed WHERE is_ready = 1').first<{ total: number }>(),
        env.DB.prepare('SELECT COUNT(*) as n FROM devices').first<{ n: number }>(),
        env.DB.prepare('SELECT title, generated_at, format FROM podcast_feed WHERE is_ready = 1 ORDER BY generated_at DESC LIMIT 1').first<{ title: string; generated_at: number; format: string }>(),
        env.DB.prepare('SELECT title, source_name, fetched_at FROM articles ORDER BY fetched_at DESC LIMIT 1').first<{ title: string; source_name: string; fetched_at: number }>(),
      ]);

      // Heuristique santé cron : on attend ~15-50 articles toutes les 30min
      const cron_fetch_ok = (last1h?.n ?? 0) > 0 || (last6h?.n ?? 0) > 5;

      // Dernière génération de podcast < 26h → ok
      const podcast_age_ms = latest_podcast ? now - latest_podcast.generated_at : Infinity;
      const podcast_ok = podcast_age_ms < 26 * 60 * 60 * 1000;

      return json({
        ok: cron_fetch_ok && podcast_ok,
        generated_at: now,
        articles: {
          total:   total?.n ?? 0,
          last_1h: last1h?.n ?? 0,
          last_6h: last6h?.n ?? 0,
          last_24h: last24h?.n ?? 0,
          pending_fr: 0,
          by_theme: by_theme.results,
        },
        cron: {
          fetch_ok: cron_fetch_ok,
          translation_ok: true,
          translation_mode: 'disabled',
          latest_article: latest_article ?? null,
        },
        podcast: {
          total: podcasts?.total ?? 0,
          ok: podcast_ok,
          latest: latest_podcast ? {
            title: latest_podcast.title,
            format: latest_podcast.format,
            age_hours: Math.round(podcast_age_ms / 3600000),
          } : null,
        },
        sources: {
          total: sources?.total ?? 0,
          active: sources?.active ?? 0,
        },
        devices: devices?.n ?? 0,
      });
    }

    // ── GET /admin/neon-status — monitoring Neon + pipelines GitHub Actions ─
    if (method === 'GET' && path === '/admin/neon-status') {
      if (!hasAdminAccess()) return err('Non autorisé', 401);
      return getNeonAdminStatus(env);
    }

    return err('Route inconnue', 404);
  },
};
