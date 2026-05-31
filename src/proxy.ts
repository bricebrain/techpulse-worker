/**
 * Proxy transparent vers les APIs IA.
 * L'app envoie sa requête au Worker, le Worker la retransmet avec la vraie clé.
 * La clé ne quitte jamais Cloudflare.
 */

import type { Env } from './types';
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

function getApiKey(target: ProxyTarget, env: Env): string | undefined {
  switch (target) {
    case 'openai':     return env.OPENAI_API_KEY;
    case 'openrouter': return env.OPENROUTER_API_KEY;
    case 'gemini':     return env.GEMINI_API_KEY;
    case 'groq':       return env.GROQ_API_KEY_1 ?? env.GROQ_API_KEY_2 ?? env.GROQ_TTS_KEY_1 ?? env.GROQ_TTS_KEY_2;
    case 'deepseek':   return env.DEEPSEEK_API_KEY;
    case 'xai':        return env.XAI_API_KEY;
  }
}

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
  const [target, ...rest] = pathAfterProxy.split('/');

  if (!isValidTarget(target)) {
    return err(`Cible inconnue : ${target}. Cibles valides : openai, openrouter, gemini, groq, deepseek, xai`, 400);
  }

  const apiKey = getApiKey(target, env);
  if (!apiKey) {
    return err(`Clé non configurée pour : ${target}`, 503);
  }

  const upstreamPath = '/' + rest.join('/');
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
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
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
    body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
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
