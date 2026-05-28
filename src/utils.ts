/** Hash déterministe (djb2) — identique à celui de l'app mobile */
export function makeHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h = h >>> 0; // unsigned 32-bit
  }
  return h.toString(36);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Vérifie le header Authorization: Bearer <API_SECRET> */
export function isAuthorized(req: Request, secret?: string): boolean {
  if (!secret) return true; // pas de secret configuré → ouvert
  const auth = req.headers.get('Authorization') ?? '';
  return auth === `Bearer ${secret}`;
}
