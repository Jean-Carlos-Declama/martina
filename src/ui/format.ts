import type { MovementType, PaymentMethod } from '../db/types';
import { formatMoney } from '../domain/common';

export { formatMoney };

/** Lo que escribe la persona ("1,250.50", "RD$ 300", "75") a centavos. Vacío o inválido = null. */
export function parseMoney(text: string): number | null {
  const clean = text.replace(/RD\$|\$|\s|,/gi, '');
  if (!clean) return null;
  const value = Number(clean);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Centavos al texto que va en un campo para editar ("1250.5" → "1250.50"; 0 → ""). */
export function moneyField(cents: number | undefined): string {
  return cents ? (cents / 100).toFixed(2) : '';
}

/** Cantidades: enteros sin decimales, libras con hasta 3. */
export function parseQty(text: string): number | null {
  const value = Number(text.replace(',', '.').trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null;
}

export function formatQty(quantity: number): string {
  return quantity.toLocaleString('es-DO', { maximumFractionDigits: 3 });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-DO', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} ${formatTime(iso)}`;
}

/** "lunes, 27 de octubre de 2026" a partir de AAAA-MM-DD. */
export function dayLabel(dayKey: string, withYear = true): string {
  const date = new Date(`${dayKey}T12:00:00`);
  const text = date.toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}) });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** El día de antes o después (AAAA-MM-DD). */
export function shiftDay(dayKey: string, days: number): string {
  const date = new Date(`${dayKey}T12:00:00`);
  date.setDate(date.getDate() + days);
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  transfer: 'Transferencia',
  card: 'Tarjeta',
  credit: 'Fiado',
};

/** Movimientos que suman (verde) o restan (rojo) en el historial. */
export function movementTone(type: MovementType, quantity: number): 'in' | 'out' {
  return type === 'count' ? (quantity >= 0 ? 'in' : 'out') : quantity > 0 ? 'in' : 'out';
}

/** "1 venta", "3 ventas". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "1 unidad", "2 unidades", "1.5 libras", "3 galones". */
export function qtyWithUnit(quantity: number, unit: string): string {
  if (quantity === 1) return `1 ${unit}`;
  const many = /[aeiou]$/i.test(unit) ? `${unit}s` : unit.endsWith('ón') ? `${unit.slice(0, -2)}ones` : `${unit}es`;
  return `${formatQty(quantity)} ${many}`;
}

export const UNITS = ['unidad', 'libra', 'onza', 'kilo', 'litro', 'galón', 'paquete', 'caja', 'docena', 'funda', 'botella'];
