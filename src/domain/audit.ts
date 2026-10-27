import type { MartinaDb } from '../db/database';
import type { Id } from '../db/types';
import { newId, nowIso } from './common';

/** Anota en la bitácora quién hizo qué (se llama dentro de la misma transacción del cambio). */
export async function audit(
  database: MartinaDb,
  userId: Id,
  action: string,
  entity: string,
  entityId?: Id,
  details?: string,
): Promise<void> {
  await database.audit.add({ id: newId(), date: nowIso(), userId, action, entity, entityId, details });
}
