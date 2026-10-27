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
