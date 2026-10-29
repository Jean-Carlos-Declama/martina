import { add } from 'dexie';
import type { MartinaDb } from '../db/database';
import type { CreditEntry, Id } from '../db/types';
import { audit } from './audit';
import { BusinessError, dayKeyOf, newId, nowIso } from './common';

/** ¿Fiarle esto lo pasa de su límite de fiado? La misma regla para avisar en pantalla y para no dejar guardar. */
export function passesCreditLimit(client: { balanceCents: number; creditLimitCents?: number }, amountCents: number): boolean {
  return !!client.creditLimitCents && client.balanceCents + amountCents > client.creditLimitCents;
}

/**
 * Mueve la cuenta de fiado de un cliente: + aumenta lo que debe (fiado), - lo baja (abono, anulación). Tiene que
 * llamarse dentro de una transacción con las tablas clients y credit.
 */
export async function addCredit(
  database: MartinaDb,
  clientId: Id,
  amountCents: number,
  kind: CreditEntry['kind'],
  userId: Id,
  saleId?: Id,
  note?: string,
  date: string = nowIso(),
): Promise<CreditEntry> {
  const client = await database.clients.get(clientId);
  if (!client) throw new BusinessError('El cliente no existe.');
  const balance = client.balanceCents + amountCents;
  if ((kind === 'sale' || kind === 'lottery') && passesCreditLimit(client, amountCents)) throw new BusinessError(`${client.name} pasaría su límite de fiado.`);
  const entry: CreditEntry = { id: newId(), clientId, date, kind, amountCents, balanceAfterCents: balance, saleId, userId, note };
  await database.credit.add(entry);
  // Súmale/réstale (no "ponle X"): así dos equipos fiando o cobrando a la vez no se pisan al sincronizar.
  // Un cliente archivado que vuelve a deber se reactiva: nunca queda escondido alguien que debe.
  await database.clients.update(clientId, { balanceCents: add(amountCents), ...(balance > 0 && !client.active ? { active: true } : {}) });
  return entry;
}

/**
 * La fecha de un abono o una deuda a mano: hoy (con la hora de ahora) o un día anterior (a mediodía de ese día),
 * para anotar lo que pasó ayer o el mes pasado. Nunca un día que no ha llegado.
 */
function entryDate(dayKey?: string): string {
  const today = dayKeyOf();
  if (!dayKey || dayKey === today) return nowIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new BusinessError('Esa fecha no es válida.');
  if (dayKey > today) throw new BusinessError('No se puede anotar en un día que todavía no ha llegado.');
  return new Date(`${dayKey}T12:00:00`).toISOString();
}

/** El cliente abona a lo que debe (no puede abonar más de lo que debe). Con `dayKey` se anota en un día anterior. */
export async function registerPayment(
  database: MartinaDb,
  clientId: Id,
  amountCents: number,
  userId: Id,
  note?: string,
  dayKey?: string,
): Promise<CreditEntry> {
  if (!(amountCents > 0)) throw new BusinessError('El abono tiene que ser mayor que cero.');
  const date = entryDate(dayKey);
  return database.transaction('rw', database.clients, database.credit, database.audit, async () => {
    const client = await database.clients.get(clientId);
    if (!client) throw new BusinessError('El cliente no existe.');
    if (amountCents > client.balanceCents) throw new BusinessError(`${client.name} solo debe ${(client.balanceCents / 100).toFixed(2)}.`);
    const entry = await addCredit(database, clientId, -amountCents, 'payment', userId, undefined, note?.trim() || undefined, date);
    await audit(database, userId, 'abono', 'cliente', clientId, `${amountCents / 100}${dayKey ? ` (${dayKey})` : ''}`);
    return entry;
  });
}

/** Anota a mano algo que el cliente debe (ej. lo que traía de la libreta del mes pasado), con su fecha. */
export async function addCharge(database: MartinaDb, clientId: Id, amountCents: number, userId: Id, note: string, dayKey?: string): Promise<CreditEntry> {
  if (!(amountCents > 0)) throw new BusinessError('La deuda tiene que ser mayor que cero.');
  if (!note.trim()) throw new BusinessError('Escribe de qué es la deuda.');
  const date = entryDate(dayKey);
  return database.transaction('rw', database.clients, database.credit, database.audit, async () => {
    const entry = await addCredit(database, clientId, Math.round(amountCents), 'charge', userId, undefined, note.trim(), date);
    await audit(database, userId, 'deuda a mano', 'cliente', clientId, `${amountCents / 100}: ${note.trim()}`);
    return entry;
  });
}

/** Si un cliente archivado queda debiendo con este cambio, se reactiva (para que salga en la lista de los que deben). */
function reactivate(client: { active: boolean; balanceCents: number }, change: number): { active?: true } {
  return !client.active && client.balanceCents + change > 0 ? { active: true } : {};
}

/** Solo los abonos y las deudas anotadas a mano se corrigen aquí; lo que viene de una venta o jugada, desde allá. */
function checkManual(entry: CreditEntry | undefined): asserts entry is CreditEntry {
  if (!entry || entry.status === 'void') throw new BusinessError('Ese movimiento no existe o ya está anulado.');
  if (entry.kind !== 'payment' && entry.kind !== 'charge')
    throw new BusinessError(entry.kind === 'lottery' ? 'Ese fiado viene de una jugada: corrígelo en Lotería, en el día que se anotó.' : 'Ese fiado viene de una venta: corrígelo en Ventas.');
}

/**
 * Corrige un abono o una deuda a mano (monto, fecha o nota), de cualquier fecha: lo que debe el cliente se
 * recalcula solo. Un cambio que baja lo que debe no lo puede dejar en menos de cero (si ya tenía saldo a favor, igual
 * se le puede corregir la fecha o la nota, o un cambio que lo acerque a cero).
 */
export async function updateCreditEntry(
  database: MartinaDb,
  entryId: Id,
  changes: { amountCents: number; dayKey?: string; note?: string },
  userId: Id,
): Promise<void> {
  if (!(changes.amountCents > 0)) throw new BusinessError('El monto tiene que ser mayor que cero.');
  const date = changes.dayKey ? entryDate(changes.dayKey) : undefined;
  await database.transaction('rw', database.clients, database.credit, database.audit, async () => {
    const entry = await database.credit.get(entryId);
    checkManual(entry);
    if (entry.kind === 'charge' && !changes.note?.trim()) throw new BusinessError('Escribe de qué es la deuda.');
    const client = await database.clients.get(entry.clientId);
    if (!client) throw new BusinessError('El cliente no existe.');
    const sign = entry.kind === 'payment' ? -1 : 1;
    const newAmount = sign * Math.round(changes.amountCents);
    const diff = newAmount - entry.amountCents;
    if (diff < 0 && client.balanceCents + diff < 0) throw new BusinessError(`Así ${client.name} quedaría debiendo menos de cero: revisa el monto.`);
    // Si la fecha no cambió de día, se queda la hora original.
    const keepDate = !changes.dayKey || changes.dayKey === dayKeyOf(new Date(entry.date));
    await database.credit.update(entryId, { amountCents: newAmount, date: keepDate ? entry.date : date, note: changes.note?.trim() || undefined });
    if (diff !== 0) await database.clients.update(entry.clientId, { balanceCents: add(diff), ...reactivate(client, diff) });
    await audit(database, userId, 'corregir', 'cuenta', entry.clientId, `${entry.kind === 'payment' ? 'abono' : 'deuda'} ${Math.abs(entry.amountCents) / 100} → ${changes.amountCents / 100}`);
  });
}

/** Anula un abono o una deuda a mano mal anotada (de cualquier fecha): deja de contar y lo que debe se recalcula. */
export async function voidCreditEntry(database: MartinaDb, entryId: Id, userId: Id, reason: string): Promise<void> {
  if (!reason.trim()) throw new BusinessError('Escribe por qué se anula.');
  await database.transaction('rw', database.clients, database.credit, database.audit, async () => {
    const entry = await database.credit.get(entryId);
    checkManual(entry);
    const client = await database.clients.get(entry.clientId);
    if (!client) throw new BusinessError('El cliente no existe.');
    const change = -entry.amountCents;
    if (change < 0 && client.balanceCents + change < 0) throw new BusinessError(`Si se anula, ${client.name} quedaría debiendo menos de cero.`);
    await database.credit.update(entryId, { status: 'void' });
    await database.clients.update(entry.clientId, { balanceCents: add(change), ...reactivate(client, change) });
    await audit(database, userId, 'anular', 'cuenta', entry.clientId, `${entry.kind === 'payment' ? 'abono' : 'deuda'} ${Math.abs(entry.amountCents) / 100}: ${reason.trim()}`);
  });
}

export interface AccountLine extends CreditEntry {
  /** Lo que debía después de este movimiento, contando por fecha (los anulados no cuentan). */
  runningCents: number;
}

/** La cuenta de un cliente en orden de fecha, con lo que iba debiendo después de cada movimiento. */
export async function clientAccount(database: MartinaDb, clientId: Id): Promise<AccountLine[]> {
  const entries = await database.credit.where('[clientId+date]').between([clientId, ''], [clientId, '￿']).toArray();
  let running = 0;
  return entries.map(entry => {
    if (entry.status !== 'void') running += entry.amountCents;
    return { ...entry, runningCents: running };
  });
}
