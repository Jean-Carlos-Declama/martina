// El "enlace" de Martina (Cloudflare Worker). Cuando un equipo escanea el QR, la app le manda aquí la llave del
// negocio; si es la correcta, este programa le pide a Dexie Cloud un permiso para ese equipo y se lo devuelve.
//
// Lo secreto vive SOLO aquí (como secretos de Cloudflare, nunca en GitHub):
//   CLIENT_ID, CLIENT_SECRET  la clave de Dexie Cloud (archivo dexie-cloud.key)
//   LINK_SECRET               la llave del negocio (la que va en el QR)
// Y como variables normales: DB_URL (la base en Dexie Cloud) y ALLOWED_ORIGINS (desde dónde se puede pedir).

/** Todo el negocio es un solo usuario de Dexie Cloud: cada equipo vinculado entra como él. */
const BUSINESS_USER = 'negocio-martina';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/token') return json({ error: 'No encontrado' }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Pedido inválido' }, 400);
    }
    if (typeof body?.public_key !== 'string' || typeof body?.link !== 'string') return json({ error: 'Pedido inválido' }, 400);
    if (!(await sameSecret(body.link.trim(), (env.LINK_SECRET || '').trim()))) return json({ error: 'La llave no es la del negocio' }, 403);

    const response = await fetch(`${env.DB_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        scopes: ['ACCESS_DB'],
        public_key: body.public_key,
        client_id: env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
        claims: { sub: BUSINESS_USER, name: 'Martina' },
      }),
    });
    if (!response.ok) return json({ error: 'Dexie Cloud no dio el permiso', status: response.status }, 502);
    return json(await response.json());
  },
};

/** Compara las llaves sin dar pistas por el tiempo que tarda (compara sus huellas SHA-256). */
async function sameSecret(given, expected) {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map(text => crypto.subtle.digest('SHA-256', encoder.encode(text))));
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
