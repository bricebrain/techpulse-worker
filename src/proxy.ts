/**
 * Proxy transparent vers les APIs IA.
 * L'app envoie sa requête au Worker, le Worker la retransmet avec la vraie clé.
 * La clé ne quitte jamais Cloudflare.
 */

import type { Env } from './types';
import { resolveSecrets } from './types';
import { err } from './utils';

type ProxyTarget = 'openai' | 'openrouter' | 'gemini' | 'groq' | 'deepseek' | 'xai';

const TARGET_URLS: Record<ProxyTarget, string> = {
  openai:      'https://api.openai.com',
  openrouter:  'https://openrouter.ai/api',
  gemini:      'https://generativelanguage.googleapis.com',
  groq:        'https://api.groq.com',
  deepseek:    'https://api.deepseek.com',
  xai:         'https://api.x.ai',
};

const EXACT_ALLOWED_PATHS: Record<Exclude<ProxyTarget, 'gemini'>, string[]> = {
  openai: ['/v1/chat/completions', '/v1/audio/speech'],
  openrouter: ['/v1/chat/completions'],
  groq: ['/openai/v1/chat/completions'],
  deepseek: ['/v1/chat/completions'],
  xai: ['/v1/chat/completions', '/v1/responses'],
};

/**
 * Proxifie une requête vers l'API cible.
 * Route attendue : /proxy/<target>/<reste-du-chemin>
 * Ex : /proxy/openai/v1/chat/completions
 *      /proxy/groq/openai/v1/audio/speech
 *      /proxy/gemini/v1beta/models/gemini-pro:generateContent
 */
export async function handleProxy(
  req: Request,
  env: Env,
  pathAfterProxy: string,   // ex: "openai/v1/chat/completions"
): Promise<Response> {
  if (req.method !== 'POST') {
    return err('Méthode non autorisée pour le proxy', 405);
  }

  const [target, ...rest] = pathAfterProxy.split('/');

  if (!isValidTarget(target)) {
    return err(`Cible inconnue : ${target}. Cibles valides : openai, openrouter, gemini, groq, deepseek, xai`, 400);
  }

  const secrets = await resolveSecrets(env);

  function getApiKey(t: ProxyTarget): string | undefined {
    switch (t) {
      case 'openai':     return secrets.OPENAI_API_KEY || undefined;
      case 'openrouter': return secrets.OPENROUTER_API_KEY || undefined;
      case 'gemini':     return secrets.GEMINI_API_KEY || undefined;
      case 'groq':       return secrets.GROQ_API_KEY_1 || secrets.GROQ_API_KEY_2 || env.GROQ_TTS_KEY_1 || env.GROQ_TTS_KEY_2;
      case 'deepseek':   return secrets.DEEPSEEK_API_KEY || undefined;
      case 'xai':        return secrets.XAI_API_KEY || undefined;
    }
  }

  const apiKey = getApiKey(target);
  if (!apiKey) {
    return err(`Clé non configurée pour : ${target}`, 503);
  }

  const upstreamPath = '/' + rest.join('/');
  if (!isAllowedProxyPath(target, upstreamPath)) {
    return err(`Chemin proxy non autorisé pour ${target}: ${upstreamPath}`, 403);
  }

  const originalUrl = new URL(req.url);
  const upstreamUrl = TARGET_URLS[target] + upstreamPath + (originalUrl.search ?? '');

  // Copie des headers en retirant ceux spécifiques au Worker
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');
  headers.delete('x-forwarded-for');
  headers.delete('x-real-ip');
  headers.delete('Authorization'); // on injecte la vraie clé

  if (target === 'gemini') {
    if (upstreamPath.includes('/openai/')) {
      // Endpoint OpenAI-compatible → Bearer comme les autres
      headers.set('Authorization', `Bearer ${apiKey}`);
    } else {
      // API native Gemini → ?key= dans l'URL
      const url = new URL(upstreamUrl);
      url.searchParams.set('key', apiKey);
      const upstreamReq = new Request(url.toString(), {
        method: req.method,
        headers,
        body: req.body,
      });
      const res = await fetch(upstreamReq);
      return proxyResponse(res);
    }
  } else {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }

  const upstreamReq = new Request(upstreamUrl, {
    method: req.method,
    headers,
    body: req.body,
  });

  const res = await fetch(upstreamReq);
  return proxyResponse(res);
}

/** Retransmet la réponse upstream (supporte le streaming) */
function proxyResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function isValidTarget(value: string): value is ProxyTarget {
  return value in TARGET_URLS;
}

function isAllowedProxyPath(target: ProxyTarget, upstreamPath: string): boolean {
  if (target === 'gemini') {
    return upstreamPath === '/v1beta/openai/chat/completions'
      || /^\/v1beta\/models\/[^/]+:generateContent$/.test(upstreamPath);
  }

  return EXACT_ALLOWED_PATHS[target].includes(upstreamPath);
}
