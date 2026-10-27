import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './src/index.js';

const env = {
  DB_URL: 'https://zprueba.dexie.cloud',
  CLIENT_ID: 'id-secreto',
  CLIENT_SECRET: 'clave-secreta',
  LINK_SECRET: 'llave-del-negocio-1234567890',
  ALLOWED_ORIGINS: 'https://jean-carlos-declama.github.io,http://localhost:4173',
};

const ask = (body, origin = 'https://jean-carlos-declama.github.io') =>
  worker.fetch(new Request('https://martina-enlace.x.workers.dev/token', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);

afterEach(() => vi.unstubAllGlobals());

describe('enlace (Cloudflare)', () => {
  it('con la llave equivocada no da permiso ni llama a Dexie Cloud', async () => {
    const dexie = vi.fn();
    vi.stubGlobal('fetch', dexie);
    const response = await ask({ public_key: 'pk', link: 'otra-llave' });
    expect(response.status).toBe(403);
    expect(dexie).not.toHaveBeenCalled();
  });

  it('con la llave correcta pide el permiso del negocio y lo devuelve (la clave de Dexie no sale)', async () => {
    const dexie = vi.fn(async () => new Response(JSON.stringify({ type: 'tokens', accessToken: 'abc' }), { status: 200 }));
    vi.stubGlobal('fetch', dexie);
    const response = await ask({ public_key: 'pk-del-equipo', link: `${env.LINK_SECRET}\n` });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ type: 'tokens', accessToken: 'abc' });
    expect(text).not.toContain('clave-secreta');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://jean-carlos-declama.github.io');
    const [url, init] = dexie.mock.calls[0];
    expect(url).toBe('https://zprueba.dexie.cloud/token');
    expect(JSON.parse(init.body)).toMatchObject({
      grant_type: 'client_credentials',
      public_key: 'pk-del-equipo',
      client_id: 'id-secreto',
      client_secret: 'clave-secreta',
      claims: { sub: 'negocio-martina' },
    });
  });

  it('a otras páginas no les da permiso del navegador (CORS)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const response = await ask({ public_key: 'pk', link: env.LINK_SECRET }, 'https://otra-pagina.com');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('null');
  });

  it('pedidos mal hechos o a otra dirección', async () => {
    expect((await ask({ link: env.LINK_SECRET })).status).toBe(400);
    const other = await worker.fetch(new Request('https://martina-enlace.x.workers.dev/otra', { method: 'POST' }), env);
    expect(other.status).toBe(404);
  });
});
