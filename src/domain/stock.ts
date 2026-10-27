import { add } from 'dexie';
import type { MartinaDb } from '../db/database';
import type { Id, Movement, MovementType } from '../db/types';
import { BusinessError, newId, nowIso } from './common';

/** Hacia dónde mueve cada tipo: entra (+1), sale (-1) o cualquiera (0, el conteo físico). */
const DIRECTION: Record<MovementType, 1 | -1 | 0> = {
  purchase: 1,
  customerReturn: 1,
  adjustIn: 1,
  saleVoid: 1,
  initial: 1,
  sale: -1,
  supplierReturn: -1,
  adjustOut: -1,
  damaged: -1,
  internalUse: -1,
  count: 0,
};

export interface MovementInput {
  productId: Id;
  type: MovementType;
  /** Cantidad con signo (+ entra, - sale). */
  quantity: number;
  userId: Id;
  reason?: string;
  docType?: Movement['docType'];
  docId?: Id;
  unitCostCents?: number;
  /** Permitir que la existencia quede en negativo (si los ajustes lo dejan). */
  allowNegative?: boolean;
}

/**
 * Registra un movimiento y cambia la existencia del producto. ES LA ÚNICA forma de cambiar la existencia: así
 * siempre queda el historial (qué, cuánto, quién, por qué). Tiene que llamarse dentro de una transacción que
 * incluya las tablas products y movements.
 */
export async function recordMovement(database: MartinaDb, input: MovementInput): Promise<Movement> {
  if (!Number.isFinite(input.quantity) || input.quantity === 0) throw new BusinessError('La cantidad tiene que ser distinta de cero.');
  const direction = DIRECTION[input.type];
  if (direction !== 0 && Math.sign(input.quantity) !== direction)
    throw new BusinessError(direction > 0 ? 'Este movimiento tiene que sumar existencia.' : 'Este movimiento tiene que restar existencia.');

  const product = await database.products.get(input.productId);
  if (!product) throw new BusinessError('El producto no existe.');
  const stockAfter = roundQty(product.stock + input.quantity);
  if (stockAfter < 0 && !input.allowNegative)
    throw new BusinessError(`No hay suficiente "${product.name}": quedan ${product.stock} ${product.unit}.`);

  const movement: Movement = {
    id: newId(),
    productId: product.id,
    type: input.type,
    quantity: input.quantity,
    stockAfter,
    unitCostCents: input.unitCostCents ?? product.costCents,
    date: nowIso(),
    userId: input.userId,
    reason: input.reason,
    docType: input.docType,
    docId: input.docId,
  };
  await database.movements.add(movement);
  // "Súmale/réstale", no "ponle X": si dos equipos venden lo mismo sin internet, al sincronizar se juntan las dos
  // ventas en vez de que una borre a la otra.
  await database.products.update(product.id, { stock: add(input.quantity), updatedAt: movement.date });
  return movement;
}

/** Movimientos que se hacen a mano desde la ficha del producto. */
export type ManualMovementType = 'purchase' | 'adjustIn' | 'adjustOut' | 'damaged' | 'internalUse' | 'supplierReturn';

export interface ManualMovementInput {
  productId: Id;
  type: ManualMovementType;
  /** Cuánto (siempre positivo: el tipo dice si entra o sale). */
  quantity: number;
  userId: Id;
  reason?: string;
  /** Costo de cada uno en la compra (si cambió). */
  unitCostCents?: number;
}

/**
 * Entrada o salida de mercancía a mano (llegó mercancía, se dañó, se usó en la casa...). En una compra con otro
 * costo, el costo del producto queda en el promedio de lo que había y lo que entró, para que la ganancia sea real.
 */
export async function manualMovement(database: MartinaDb, input: ManualMovementInput): Promise<Movement> {
  if (!(input.quantity > 0)) throw new BusinessError('La cantidad tiene que ser mayor que cero.');
  if (input.type !== 'purchase' && !input.reason?.trim()) throw new BusinessError('Escribe el motivo.');
  if (input.unitCostCents !== undefined && input.unitCostCents < 0) throw new BusinessError('El costo no puede ser negativo.');
  return database.transaction('rw', database.products, database.movements, database.audit, async () => {
    const product = await database.products.get(input.productId);
    if (!product) throw new BusinessError('El producto no existe.');
    const quantity = roundQty(input.quantity);
    const unitCost = input.type === 'purchase' && input.unitCostCents !== undefined ? Math.round(input.unitCostCents) : product.costCents;
    const movement = await recordMovement(database, {
      productId: product.id,
      type: input.type,
      quantity: DIRECTION[input.type] * quantity,
      userId: input.userId,
      reason: input.reason?.trim() || undefined,
      docType: 'manual',
      unitCostCents: unitCost,
    });
    let details = `${MOVEMENT_LABELS[input.type]} ${quantity} ${product.unit}`;
    if (input.type === 'purchase' && unitCost !== product.costCents) {
      const before = Math.max(0, product.stock);
      const average = Math.round((before * product.costCents + quantity * unitCost) / (before + quantity));
      await database.products.update(product.id, { costCents: average });
      details += `; costo ${product.costCents / 100} → ${average / 100} (promedio)`;
    }
    await database.audit.add({ id: newId(), date: movement.date, userId: input.userId, action: 'movimiento', entity: 'producto', entityId: product.id, details });
    return movement;
  });
}

/** Cómo se llama cada tipo de movimiento en pantalla. */
export const MOVEMENT_LABELS: Record<MovementType, string> = {
  purchase: 'Entrada (compra)',
  sale: 'Venta',
  customerReturn: 'Devolución de cliente',
  supplierReturn: 'Devolución al proveedor',
  adjustIn: 'Ajuste (+)',
  adjustOut: 'Ajuste (−)',
  damaged: 'Dañado o vencido',
  internalUse: 'Uso de la casa',
  count: 'Conteo físico',
  saleVoid: 'Venta anulada',
  initial: 'Existencia inicial',
};

/** Las cantidades con hasta 3 decimales (libras, litros) sin errores de coma flotante. */
export function roundQty(quantity: number): number {
  return Math.round(quantity * 1000) / 1000;
}

/** Corrección por conteo físico: registra la diferencia entre lo contado y lo que dice la app. */
export async function countCorrection(
  database: MartinaDb,
  productId: Id,
  counted: number,
  userId: Id,
  reason = 'Conteo físico',
): Promise<Movement | null> {
  return database.transaction('rw', database.products, database.movements, database.audit, async () => {
    const product = await database.products.get(productId);
    if (!product) throw new BusinessError('El producto no existe.');
    if (counted < 0) throw new BusinessError('Lo contado no puede ser negativo.');
    const difference = roundQty(counted - product.stock);
    if (difference === 0) return null;
    const movement = await recordMovement(database, { productId, type: 'count', quantity: difference, userId, reason, docType: 'count' });
    await database.audit.add({
      id: newId(),
      date: movement.date,
      userId,
      action: 'conteo',
      entity: 'producto',
      entityId: productId,
      details: `Había ${product.stock}, se contaron ${counted} (${difference > 0 ? '+' : ''}${difference}). ${reason}`,
    });
    return movement;
  });
}
