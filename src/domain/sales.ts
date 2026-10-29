import { getDeviceLocal, getSettings, type MartinaDb } from '../db/database';
import type { Id, PaymentMethod, Sale, SaleLine } from '../db/types';
import { audit } from './audit';
import { createClient } from './clients';
import { BusinessError, dayKeyOf, newId, nowIso } from './common';
import { addCredit } from './credit';
import { recordMovement, roundQty } from './stock';

export interface CartLine {
  productId: Id;
  quantity: number;
  /** Descuento de la línea, en centavos. */
  discountCents?: number;
}

export interface SaleInput {
  lines: CartLine[];
  payment: PaymentMethod;
  clientId?: Id;
  /** Nombre del cliente (si no está registrado, se escribe a mano). */
  clientName?: string;
  /** Fiado a alguien que no está registrado: se registra como cliente en la misma transacción (si la venta no se hace, tampoco). */
  newClientName?: string;
  /** Descuento a toda la venta, en centavos. */
  discountCents?: number;
  /** Llave única de esta operación (se genera al abrir la venta): repetir el toque no crea otra venta. */
  requestId: string;
  userId: Id;
}

/**
 * Cobra una venta: revisa existencias, descuenta el inventario (un movimiento por producto), anota el fiado si es
 * fiado, y numera el recibo. Todo en una sola transacción: o se hace completa o no se hace nada.
 * Los precios ya llevan el ITBIS incluido (lo de la etiqueta es lo que se cobra); el ITBIS se calcula aparte para el recibo.
 */
export async function createSale(database: MartinaDb, input: SaleInput): Promise<Sale> {
  if (input.lines.length === 0) throw new BusinessError('La venta no tiene productos.');
  return database.transaction(
    'rw',
    [database.products, database.movements, database.sales, database.settings, database.clients, database.credit, database.audit, database.local],
    async () => {
      // Si ya se cobró con esta misma llave (doble toque, reintento), se devuelve la misma venta.
      const repeated = await database.sales.where('requestId').equals(input.requestId).first();
      if (repeated) return repeated;

      const dayKey = dayKeyOf();
      const settings = await getSettings(database);
      // Cada equipo numera sus recibos (con su letra si hay varios): dos equipos sin internet no repiten número.
      const device = await getDeviceLocal(database);

      const lines: SaleLine[] = [];
      for (const item of input.lines) {
        if (!(item.quantity > 0)) throw new BusinessError('Las cantidades tienen que ser mayores que cero.');
        const product = await database.products.get(item.productId);
        if (!product || !product.active) throw new BusinessError('Un producto de la venta ya no existe.');
        const discount = Math.max(0, Math.round(item.discountCents ?? 0));
        if (discount > product.priceCents * item.quantity) throw new BusinessError(`El descuento de "${product.name}" es mayor que su precio.`);
        lines.push({
          productId: product.id,
          name: product.name,
          quantity: item.quantity,
          priceCents: product.priceCents,
          costCents: product.costCents,
          taxRate: settings.taxEnabled && product.taxed ? settings.taxRate : 0,
          discountCents: discount,
        });
      }

      const subtotal = lines.reduce((sum, line) => sum + Math.round(line.priceCents * line.quantity) - line.discountCents, 0);
      const discount = Math.max(0, Math.round(input.discountCents ?? 0));
      if (discount > subtotal) throw new BusinessError('El descuento es mayor que la venta.');
      const total = subtotal - discount;
      const tax = includedTax(lines, discount, subtotal);

      let clientName = input.clientName?.trim() || undefined;
      let clientId = input.clientId;
      if (!clientId && input.newClientName) clientId = (await createClient(database, { name: input.newClientName }, input.userId)).id;
      if (clientId) {
        const client = await database.clients.get(clientId);
        if (!client) throw new BusinessError('El cliente no existe.');
        clientName = client.name;
      }
      if (input.payment === 'credit' && !clientId) throw new BusinessError('Para fiar hay que escoger el cliente.');

      const sale: Sale = {
        id: newId(),
        number: device.nextSaleNumber,
        series: device.series,
        date: nowIso(),
        dayKey,
        clientId,
        clientName,
        lines,
        subtotalCents: subtotal,
        discountCents: discount,
        taxCents: tax,
        totalCents: total,
        payment: input.payment,
        userId: input.userId,
        status: 'done',
        requestId: input.requestId,
      };
      await database.sales.add(sale);
      for (const line of lines) {
        await recordMovement(database, {
          productId: line.productId,
          type: 'sale',
          quantity: -line.quantity,
          userId: input.userId,
          docType: 'sale',
          docId: sale.id,
          unitCostCents: line.costCents,
          allowNegative: settings.allowNegativeStock,
          reason: `Venta #${receiptNumber(sale)}`,
        });
      }
      if (input.payment === 'credit') await addCredit(database, clientId!, total, 'sale', input.userId, sale.id, `Venta #${receiptNumber(sale)}`);
      await database.local.put({ ...device, nextSaleNumber: device.nextSaleNumber + 1 });
      return sale;
    },
  );
}

/** El número del recibo como se muestra: "12", o "B-12" si hay varios equipos. */
export function receiptNumber(sale: Pick<Sale, 'number' | 'series'>): string {
  return sale.series ? `${sale.series}-${sale.number}` : String(sale.number);
}

/** El ITBIS que va incluido en el precio (repartiendo el descuento general en proporción). */
function includedTax(lines: SaleLine[], generalDiscount: number, subtotal: number): number {
  let tax = 0;
  for (const line of lines) {
    if (line.taxRate <= 0) continue;
    const gross = Math.round(line.priceCents * line.quantity) - line.discountCents;
    const share = subtotal > 0 ? gross - (generalDiscount * gross) / subtotal : 0;
    tax += share - share / (1 + line.taxRate / 100);
  }
  return Math.round(tax);
}

/**
 * Anula una venta completa (solo la dueña): la mercancía vuelve al inventario, el fiado se descuenta y queda en
 * la bitácora. Si el día de esa venta ya se cerró, no se puede (habría que reabrirlo).
 */
export async function voidSale(database: MartinaDb, saleId: Id, ownerId: Id, reason: string): Promise<Sale> {
  if (!reason.trim()) throw new BusinessError('Escribe por qué se anula.');
  return database.transaction(
    'rw',
    [database.products, database.movements, database.sales, database.clients, database.credit, database.audit, database.users],
    async () => {
      const owner = await database.users.get(ownerId);
      if (!owner || owner.role !== 'owner') throw new BusinessError('Solo la dueña puede anular ventas.');
      const sale = await database.sales.get(saleId);
      if (!sale) throw new BusinessError('La venta no existe.');
      if (sale.status === 'void') return sale;

      // Lo que ya se devolvió con "Devolver productos" no se vuelve a deshacer: solo se anula lo que falta.
      const returns = await database.movements.where('docId').equals(sale.id).filter(m => m.type === 'customerReturn').toArray();
      let refundedCents = 0;
      for (const line of sale.lines) {
        const returned = returns.filter(m => m.productId === line.productId).reduce((sum, m) => sum + m.quantity, 0);
        refundedCents += refundOf(sale, line, returned);
        const left = roundQty(line.quantity - returned);
        if (left <= 0) continue;
        await recordMovement(database, {
          productId: line.productId,
          type: 'saleVoid',
          quantity: left,
          userId: ownerId,
          docType: 'sale',
          docId: sale.id,
          unitCostCents: line.costCents,
          reason: `Anulación venta #${receiptNumber(sale)}: ${reason}`,
        });
      }
      // Al cliente se le quita lo que valía lo que no devolvió (lo devuelto ya se le rebajó, o se le dio en efectivo).
      const owedCents = sale.totalCents - refundedCents;
      if (sale.payment === 'credit' && sale.clientId && owedCents > 0)
        await addCredit(database, sale.clientId, -owedCents, 'saleVoid', ownerId, sale.id, `Anulación venta #${receiptNumber(sale)}`);
      const voided: Sale = { ...sale, status: 'void', voidedAt: nowIso(), voidedBy: ownerId, voidReason: reason.trim() };
      await database.sales.put(voided);
      await audit(database, ownerId, 'anular', 'venta', sale.id, `#${receiptNumber(sale)}: ${reason.trim()}`);
      return voided;
    },
  );
}

/** Devolución de parte de una venta (el cliente trae algo): la mercancía vuelve y queda anotada. Solo la dueña. */
export async function returnItems(
  database: MartinaDb,
  saleId: Id,
  items: { productId: Id; quantity: number }[],
  ownerId: Id,
  reason: string,
): Promise<void> {
  if (!reason.trim()) throw new BusinessError('Escribe por qué se devuelve.');
  if (items.length === 0) throw new BusinessError('Escoge qué se devuelve.');
  const tables = [database.products, database.movements, database.sales, database.clients, database.credit, database.audit, database.users];
  await database.transaction('rw', tables, async () => {
    const owner = await database.users.get(ownerId);
    if (!owner || owner.role !== 'owner') throw new BusinessError('Solo la dueña puede autorizar devoluciones.');
    const sale = await database.sales.get(saleId);
    if (!sale || sale.status === 'void') throw new BusinessError('La venta no existe o ya está anulada.');
    let refundCents = 0;
    for (const item of items) {
      const line = sale.lines.find(l => l.productId === item.productId);
      if (!line) throw new BusinessError('Ese producto no está en la venta.');
      const already = await database.movements
        .where('docId').equals(sale.id)
        .filter(m => m.productId === item.productId && m.type === 'customerReturn')
        .toArray();
      const returned = already.reduce((sum, m) => sum + m.quantity, 0);
      if (item.quantity <= 0 || roundQty(returned + item.quantity) > line.quantity)
        throw new BusinessError(`No se pueden devolver más "${line.name}" de los que se vendieron.`);
      await recordMovement(database, {
        productId: item.productId,
        type: 'customerReturn',
        quantity: item.quantity,
        userId: ownerId,
        docType: 'sale',
        docId: sale.id,
        unitCostCents: line.costCents,
        reason: `Devolución venta #${receiptNumber(sale)}: ${reason}`,
      });
      refundCents += refundOf(sale, line, item.quantity);
    }
    // Si era fiado, lo devuelto se le rebaja de la deuda (sin dejarla en negativo).
    if (sale.payment === 'credit' && sale.clientId) {
      const client = await database.clients.get(sale.clientId);
      const amount = Math.min(refundCents, Math.max(0, client?.balanceCents ?? 0));
      if (amount > 0) await addCredit(database, sale.clientId, -amount, 'adjust', ownerId, sale.id, `Devolución venta #${receiptNumber(sale)}`);
    }
    await audit(database, ownerId, 'devolución', 'venta', sale.id, reason.trim());
  });
}

/** Lo que se le devuelve al cliente por esa cantidad: su precio con el descuento de la línea y el general repartidos. */
export function refundOf(sale: Sale, line: SaleLine, quantity: number): number {
  const lineNet = Math.round(line.priceCents * line.quantity) - line.discountCents;
  const factor = sale.subtotalCents > 0 ? sale.totalCents / sale.subtotalCents : 1;
  return Math.round((lineNet / line.quantity) * quantity * factor);
}

export interface Refund {
  /** Día en que se devolvió (el que se le descuenta en los reportes), no el de la venta. */
  dayKey: string;
  productId: Id;
  quantity: number;
  amountCents: number;
  costCents: number;
}

/** Las devoluciones de clientes entre dos días (incluidos), con lo que se devolvió en dinero y su costo. */
export async function refundsBetween(database: MartinaDb, from: string, to: string): Promise<Refund[]> {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  end.setDate(end.getDate() + 1);
  const returns = await database.movements
    .where('date').between(start.toISOString(), end.toISOString())
    .filter(m => m.type === 'customerReturn' && m.docType === 'sale')
    .toArray();
  const refunds: Refund[] = [];
  for (const movement of returns) {
    const sale = movement.docId ? await database.sales.get(movement.docId) : undefined;
    const line = sale?.lines.find(l => l.productId === movement.productId);
    // Una venta anulada ya no cuenta entera en los reportes: su devolución tampoco se resta.
    if (!sale || sale.status === 'void' || !line) continue;
    refunds.push({
      dayKey: dayKeyOf(new Date(movement.date)),
      productId: movement.productId,
      quantity: movement.quantity,
      amountCents: refundOf(sale, line, movement.quantity),
      costCents: Math.round(line.costCents * movement.quantity),
    });
  }
  return refunds;
}
