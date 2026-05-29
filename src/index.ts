import type { Env, Source } from './types';
import { runCron, fetchAndStoreSource } from './cron';
import { json, err, isAuthorized, makeHash } from './utils';
import { adminPage } from './admin';
import { handleProxy } from './proxy';

export default {
  // ─── Cron ─────────────────────────────────────────────────────────────────
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },

  // ─── API HTTP ─────────────────────────────────────────────────────────────
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

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

    // ── /proxy/<target>/... — proxy IA transparent ───────────────────────
    if (path.startsWith('/proxy/')) {
      // Pas de secret requis en lecture (l'app est la seule à connaître l'URL)
      // mais on peut l'activer si besoin : if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
      const pathAfterProxy = path.slice('/proxy/'.length); // "openai/v1/chat/completions"
      return handleProxy(req, env, pathAfterProxy);
    }

    // ── POST /classify/test — test Workers AI sur un titre ───────────────
    if (method === 'POST' && path === '/classify/test') {
      if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
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
        : await env.DB.prepare(
            `SELECT * FROM articles
             WHERE theme = ? OR (theme = 'youtube' AND classified_theme = ?)
             ORDER BY published_at DESC, fetched_at DESC
             LIMIT ?`
          ).bind(theme, theme, limit).all();

      return json({ articles: results, theme, classified: classified ?? null, count: results.length });
    }

    // ── GET /articles/themes — liste des thèmes disponibles ──────────────
    if (method === 'GET' && path === '/articles/themes') {
      const { results } = await env.DB.prepare(
        'SELECT DISTINCT theme FROM articles ORDER BY theme ASC'
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
      if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

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
      if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

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
      if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

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
      if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

      const id = path.split('/')[2];
      await env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(id).run();
      return json({ message: 'Source supprimée' });
    }

    // ── POST /articles/ingest — ingestion d'articles depuis l'app mobile ────
    // Utilisé pour pousser les articles Reddit (IP téléphone non bloquée par Reddit)
    if (method === 'POST' && path === '/articles/ingest') {
      if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

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

    // ── POST /cron/trigger — déclencher le cron manuellement ─────────────
    if (method === 'POST' && path === '/cron/trigger') {
      if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
      ctx.waitUntil(runCron(env));
      return json({ message: 'Cron lancé en arrière-plan' });
    }

    return err('Route inconnue', 404);
  },
};
