import type { MovementType, PaymentMethod, Role } from '../db/types';
import { formatMoney, pluralUnit } from '../domain/common';

export { formatMoney };

/** Monedas que se pueden escoger en Ajustes (cambia el símbolo en toda la app; no convierte cantidades). */
export const CURRENCIES = [
  { symbol: 'RD$', label: 'Pesos dominicanos (RD$)' },
  { symbol: 'US$', label: 'Dólares (US$)' },
  { symbol: '€', label: 'Euros (€)' },
];

/** Lo que escribe la persona ("1,250.50", "RD$ 300", "US$ 20", "€ 75") a centavos. Vacío o inválido = null. */
export function parseMoney(text: string): number | null {
  const clean = text.replace(/RD\$|US\$|\$|€|\s|,/gi, '');
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

/** "6:11 p. m." con espacios duros: la hora nunca queda partida en dos renglones. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '\u00a0');
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} ${formatTime(iso)}`;
}

/**
 * Fecha corta para listas: "hoy 4:55 p. m." si es de hoy; si no, solo el día ("10 sept", o "10 sept 2025" si es de
 * otro año). Lo anotado con fecha anterior no tiene una hora de verdad, así que no se muestra.
 */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `hoy\u00a0${formatTime(iso)}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('es-DO', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Teléfono como se lee: 829-555-0101 (los de 10 números) o +1 829-555-0101 (con el 1 del país); si no, tal cual. */
export function formatPhone(phone?: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length !== 10) return phone;
  const dashed = `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
  return local === digits ? dashed : `+1 ${dashed}`;
}

/** Cómo está la cuenta de un cliente: "debe RD$ X", "a favor RD$ X" o "al día". */
export function balanceLabel(cents: number, money: (cents: number) => string): string {
  return cents > 0 ? `debe ${money(cents)}` : cents < 0 ? `a favor ${money(-cents)}` : 'al día';
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
  return `${count}\u00a0${count === 1 ? one : many}`;
}

/** "1 unidad", "2 unidades", "1.5 libras", "3 galones". */
export function qtyWithUnit(quantity: number, unit: string): string {
  if (quantity === 1) return `1 ${unit}`;
  return `${formatQty(quantity)} ${pluralUnit(unit)}`;
}

export const UNITS = ['unidad', 'libra', 'onza', 'kilo', 'litro', 'galón', 'paquete', 'caja', 'docena', 'funda', 'botella'];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'dueña',
  employee: 'empleado',
  viewer: 'solo mirar',
};
