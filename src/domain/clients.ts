import type { MartinaDb } from '../db/database';
import type { Client, Id } from '../db/types';
import { audit } from './audit';
import { BusinessError, newId, nowIso } from './common';
import { normalize } from './products';

export interface ClientInput {
  name: string;
  phone?: string;
  notes?: string;
  /** Hasta cuánto se le puede fiar (vacío = sin límite). */
  creditLimitCents?: number;
}

function clean(input: ClientInput): ClientInput {
  const phone = input.phone?.replace(/[^\d+]/g, '') || undefined;
  return {
    name: input.name.trim().replace(/\s+/g, ' '),
    phone,
    notes: input.notes?.trim() || undefined,
    creditLimitCents: input.creditLimitCents && input.creditLimitCents > 0 ? Math.round(input.creditLimitCents) : undefined,
  };
}

/** Que no haya dos clientes con el mismo nombre (si no, el cuadre y el fiado se confunden). */
async function checkName(database: MartinaDb, name: string, exceptId?: Id): Promise<void> {
  if (!name) throw new BusinessError('Escribe el nombre del cliente.');
  const wanted = normalize(name);
  const other = await database.clients.filter(c => c.id !== exceptId && normalize(c.name) === wanted).first();
  if (other) throw new BusinessError(`Ya hay un cliente que se llama "${other.name}".`);
}

export async function createClient(database: MartinaDb, raw: ClientInput, userId: Id): Promise<Client> {
  const input = clean(raw);
  return database.transaction('rw', database.clients, database.audit, async () => {
    await checkName(database, input.name);
    const client: Client = { id: newId(), ...input, balanceCents: 0, active: true, createdAt: nowIso() };
    await database.clients.add(client);
    await audit(database, userId, 'crear', 'cliente', client.id, client.name);
    return client;
  });
}

/** Edita los datos del cliente (lo que debe NO: eso solo cambia con fiados y abonos). */
export async function updateClient(database: MartinaDb, id: Id, raw: ClientInput, userId: Id): Promise<void> {
  const input = clean(raw);
  await database.transaction('rw', database.clients, database.audit, async () => {
    if (!(await database.clients.get(id))) throw new BusinessError('El cliente no existe.');
    await checkName(database, input.name, id);
    await database.clients.update(id, { ...input });
    await audit(database, userId, 'editar', 'cliente', id, input.name);
  });
}

export async function setClientActive(database: MartinaDb, id: Id, active: boolean, userId: Id): Promise<void> {
  await database.transaction('rw', database.clients, database.audit, async () => {
    const client = await database.clients.get(id);
    if (!client) throw new BusinessError('El cliente no existe.');
    if (!active && client.balanceCents > 0) throw new BusinessError(`${client.name} todavía debe: cobra primero.`);
    await database.clients.update(id, { active });
    await audit(database, userId, active ? 'reactivar' : 'archivar', 'cliente', id);
  });
}

/** El nombre para comparar: sin tildes, mayúsculas ni espacios de más. */
const nameKey = (name: string) => normalize(name).replace(/\s+/g, ' ');

/** El cliente con ese nombre exacto (sin importar tildes, mayúsculas ni espacios), si existe. */
export function exactClient(name: string, clients: Client[] | undefined): Client | undefined {
  const typed = nameKey(name);
  return typed ? clients?.find(c => nameKey(c.name) === typed) : undefined;
}

/** Cómo suena una palabra, para que "Gomes" encuentre a "Gómez": sin h, z = s, ce/ci = se/si, v = b, ll = y, sin letras repetidas. */
function soundKey(word: string): string {
  return word
    .replace(/h/g, '')
    .replace(/z/g, 's')
    .replace(/c([ei])/g, 's$1')
    .replace(/v/g, 'b')
    .replace(/ll/g, 'y')
    .replace(/(.)\1+/g, '$1');
}

/** Cuántas letras hay que cambiar, quitar, poner o voltear (dos seguidas) para pasar de una palabra a la otra. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** ¿La palabra escrita puede ser (el comienzo de) esta palabra del nombre, aunque tenga una letra mal o suene igual? */
function wordMatches(typed: string, part: string): boolean {
  if (part.startsWith(typed)) return true;
  const t = soundKey(typed);
  const p = soundKey(part);
  if (p.startsWith(t)) return true;
  if (t.length < 4) return false;
  const tolerance = t.length >= 7 ? 2 : 1;
  return editDistance(t, p) <= tolerance || editDistance(t, p.slice(0, t.length)) <= tolerance;
}

/**
 * Clientes cuyo nombre se parece a lo escrito (sin contar el que se llama exactamente así): cada palabra escrita es el
 * comienzo de una palabra del nombre, aunque tenga una letra mal o se escriba como suena ("pedro" → "Pedro Gómez",
 * "Pedro Gomes" → "Pedro Gómez", "rosa" → "Doña Rosa"). Primero los que más deben. Sirve para que un nombre a medias o
 * mal escrito no termine en una cuenta nueva mientras la deuda de "Pedro Gómez" se queda igual.
 */
export function similarClients(name: string, clients: Client[], limit = 5): Client[] {
  const typed = nameKey(name);
  const words = typed.split(' ').filter(Boolean);
  if (words.length === 0) return [];
  return clients
    .filter(c => nameKey(c.name) !== typed)
    .filter(c => {
      const parts = nameKey(c.name).split(' ');
      return words.every(w => parts.some(p => wordMatches(w, p)));
    })
    .sort((a, b) => b.balanceCents - a.balanceCents || a.name.localeCompare(b.name, 'es'))
    .slice(0, limit);
}
