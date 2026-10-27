import { add } from 'dexie';
import type { MartinaDb } from '../db/database';
import type { CreditEntry, Id } from '../db/types';
import { audit } from './audit';
import { BusinessError, newId, nowIso } from './common';

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
): Promise<CreditEntry> {
  const client = await database.clients.get(clientId);
  if (!client) throw new BusinessError('El cliente no existe.');
  const balance = client.balanceCents + amountCents;
  if ((kind === 'sale' || kind === 'lottery') && client.creditLimitCents && balance > client.creditLimitCents)
    throw new BusinessError(`${client.name} pasaría su límite de fiado.`);
  const entry: CreditEntry = { id: newId(), clientId, date: nowIso(), kind, amountCents, balanceAfterCents: balance, saleId, userId, note };
  await database.credit.add(entry);
  // Súmale/réstale (no "ponle X"): así dos equipos fiando o cobrando a la vez no se pisan al sincronizar.
  await database.clients.update(clientId, { balanceCents: add(amountCents) });
  return entry;
}

/** El cliente abona a lo que debe (no puede abonar más de lo que debe). */
export async function registerPayment(database: MartinaDb, clientId: Id, amountCents: number, userId: Id, note?: string): Promise<CreditEntry> {
  if (!(amountCents > 0)) throw new BusinessError('El abono tiene que ser mayor que cero.');
  return database.transaction('rw', database.clients, database.credit, database.audit, async () => {
    const client = await database.clients.get(clientId);
    if (!client) throw new BusinessError('El cliente no existe.');
    if (amountCents > client.balanceCents) throw new BusinessError(`${client.name} solo debe ${(client.balanceCents / 100).toFixed(2)}.`);
    const entry = await addCredit(database, clientId, -amountCents, 'payment', userId, undefined, note);
    await audit(database, userId, 'abono', 'cliente', clientId, `${amountCents / 100}`);
    return entry;
  });
}
