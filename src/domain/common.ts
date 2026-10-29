// Utilidades de todos los módulos: identificadores, fechas, el día del cuadre y el dinero.

/** Un identificador único nuevo. */
export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** El día del cuadre en hora local del iPad (AAAA-MM-DD). */
export function dayKeyOf(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Pesos (con decimales) a centavos enteros, redondeando bien. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Muestra centavos como dinero: RD$ 1,234.50 (con espacio duro: "RD$" y el número nunca quedan en renglones distintos). */
export function formatMoney(cents: number, currency = 'RD$'): string {
  const sign = cents < 0 ? '-' : '';
  const value = (Math.abs(cents) / 100).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${currency} ${value}`;
}

/** El plural de una unidad: "unidad" → "unidades", "libra" → "libras", "galón" → "galones". */
export function pluralUnit(unit: string): string {
  return /[aeiou]$/i.test(unit) ? `${unit}s` : unit.endsWith('ón') ? `${unit.slice(0, -2)}ones` : `${unit}es`;
}

/** Un porcentaje de una cantidad en centavos, redondeado al centavo. */
export function percentOf(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}

/** Error de una regla del negocio (se le muestra a la persona tal cual). */
export class BusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessError';
  }
}
