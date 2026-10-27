import type { MartinaDb } from '../db/database';
import type { Product } from '../db/types';
import { dayKeyOf } from './common';
import { refundsBetween } from './sales';

export interface TopProduct {
  productId: string;
  name: string;
  quantity: number;
  revenueCents: number;
  profitCents: number;
}

export interface PeriodReport {
  from: string;
  to: string;
  salesCount: number;
  salesCents: number;
  costCents: number;
  profitCents: number;
  /** Venta y ganancia de cada día del período (AAAA-MM-DD). */
  days: { dayKey: string; salesCents: number; profitCents: number; count: number }[];
  top: TopProduct[];
}

/** Ventas, costo y ganancia entre dos días (incluidos), por día, y los productos que más se venden. */
export async function salesReport(database: MartinaDb, from: string, to: string, topCount = 10): Promise<PeriodReport> {
  const sales = (await database.sales.where('dayKey').between(from, to, true, true).toArray()).filter(s => s.status === 'done');
  const days = new Map<string, { dayKey: string; salesCents: number; profitCents: number; count: number }>();
  const products = new Map<string, TopProduct>();
  let salesCents = 0;
  let costCents = 0;
  for (const sale of sales) {
    const cost = sale.lines.reduce((sum, line) => sum + Math.round(line.costCents * line.quantity), 0);
    salesCents += sale.totalCents;
    costCents += cost;
    const day = days.get(sale.dayKey) ?? { dayKey: sale.dayKey, salesCents: 0, profitCents: 0, count: 0 };
    day.salesCents += sale.totalCents;
    day.profitCents += sale.totalCents - cost;
    day.count++;
    days.set(sale.dayKey, day);
    // Lo que deja cada producto (el descuento general se reparte en proporción).
    const factor = sale.subtotalCents > 0 ? sale.totalCents / sale.subtotalCents : 1;
    for (const line of sale.lines) {
      const revenue = (Math.round(line.priceCents * line.quantity) - line.discountCents) * factor;
      const entry = products.get(line.productId) ?? { productId: line.productId, name: line.name, quantity: 0, revenueCents: 0, profitCents: 0 };
      entry.quantity += line.quantity;
      entry.revenueCents += Math.round(revenue);
      entry.profitCents += Math.round(revenue - line.costCents * line.quantity);
      products.set(line.productId, entry);
    }
  }
  // Las devoluciones restan (en el día en que se devolvió, como en el cuadre).
  for (const refund of await refundsBetween(database, from, to)) {
    salesCents -= refund.amountCents;
    costCents -= refund.costCents;
    const day = days.get(refund.dayKey) ?? { dayKey: refund.dayKey, salesCents: 0, profitCents: 0, count: 0 };
    day.salesCents -= refund.amountCents;
    day.profitCents -= refund.amountCents - refund.costCents;
    days.set(refund.dayKey, day);
    const entry = products.get(refund.productId);
    if (entry) {
      entry.quantity -= refund.quantity;
      entry.revenueCents -= refund.amountCents;
      entry.profitCents -= refund.amountCents - refund.costCents;
    }
  }
  return {
    from,
    to,
    salesCount: sales.length,
    salesCents,
    costCents,
    profitCents: salesCents - costCents,
    days: [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    top: [...products.values()].sort((a, b) => b.quantity - a.quantity).slice(0, topCount),
  };
}

/** Los rangos de siempre: hoy, esta semana (desde el lunes), este mes. */
export function periodOf(kind: 'today' | 'week' | 'month', today = new Date()): { from: string; to: string } {
  const to = dayKeyOf(today);
  if (kind === 'today') return { from: to, to };
  const start = new Date(today);
  if (kind === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  else start.setDate(1);
  return { from: dayKeyOf(start), to };
}

export interface StockAlerts {
  low: Product[];
  out: Product[];
}

/** Productos activos agotados (0 o menos) y con poca existencia (en el mínimo o por debajo). */
export async function stockAlerts(database: MartinaDb): Promise<StockAlerts> {
  const products = (await database.products.toArray()).filter(p => p.active);
  return {
    out: products.filter(p => p.stock <= 0).sort((a, b) => a.name.localeCompare(b.name)),
    low: products.filter(p => p.stock > 0 && p.stock <= p.minStock).sort((a, b) => a.stock - b.stock),
  };
}

export interface InventorySummary {
  products: number;
  units: number;
  valueAtCostCents: number;
  valueAtPriceCents: number;
}

/** Cuánto hay en inventario: productos activos, unidades y lo que vale (al costo y al precio). */
export async function inventorySummary(database: MartinaDb): Promise<InventorySummary> {
  const products = (await database.products.toArray()).filter(p => p.active);
  return {
    products: products.length,
    units: products.reduce((sum, p) => sum + Math.max(0, p.stock), 0),
    valueAtCostCents: products.reduce((sum, p) => sum + Math.round(Math.max(0, p.stock) * p.costCents), 0),
    valueAtPriceCents: products.reduce((sum, p) => sum + Math.round(Math.max(0, p.stock) * p.priceCents), 0),
  };
}
