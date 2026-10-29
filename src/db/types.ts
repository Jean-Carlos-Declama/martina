// Tipos de los datos que se guardan en el iPad. El dinero va SIEMPRE en centavos (enteros) para no perder
// precisión con los decimales; la cantidad de producto puede tener decimales (libras, litros).

export type Id = string;

/**
 * Rol de quien usa la app: la dueña puede todo; el empleado vende y anota, pero no anula ni ve ganancias;
 * "solo mirar" ve todos los números (también ganancias) pero no puede anotar ni cambiar nada.
 */
export type Role = 'owner' | 'employee' | 'viewer';

export interface User {
  id: Id;
  name: string;
  role: Role;
  /** Clave (PIN) guardada como huella: nunca el PIN en claro. */
  pinHash: string;
  pinSalt: string;
  active: boolean;
  createdAt: string;
}

export interface Category {
  id: Id;
  name: string;
}

export interface Supplier {
  id: Id;
  name: string;
  phone?: string;
  notes?: string;
  active: boolean;
  createdAt: string;
}

export interface Product {
  id: Id;
  /** Código interno (único). */
  sku: string;
  /** Código de barras (único si tiene). */
  barcode?: string;
  name: string;
  description?: string;
  categoryId?: Id;
  brand?: string;
  /** Foto reducida (JPEG) guardada en el iPad. */
  photo?: Blob;
  /** Unidad: unidad, libra, litro, paquete... */
  unit: string;
  costCents: number;
  priceCents: number;
  /** Si lleva ITBIS (el % está en los ajustes). */
  taxed: boolean;
  /** Existencia actual: solo la cambian los movimientos. */
  stock: number;
  minStock: number;
  supplierId?: Id;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Por qué se mueve el inventario. */
export type MovementType =
  | 'purchase' // entrada por compra
  | 'sale' // salida por venta
  | 'customerReturn' // devolución de cliente (entra)
  | 'supplierReturn' // devolución a proveedor (sale)
  | 'adjustIn' // ajuste positivo
  | 'adjustOut' // ajuste negativo
  | 'damaged' // dañado o vencido (sale)
  | 'internalUse' // consumo interno (sale)
  | 'count' // corrección por conteo físico (+ o -)
  | 'saleVoid' // anulación de venta (vuelve a entrar)
  | 'initial'; // existencia inicial al crear el producto

export interface Movement {
  id: Id;
  productId: Id;
  type: MovementType;
  /** Cantidad con signo: + entra, - sale. */
  quantity: number;
  /** Existencia que quedó después de este movimiento (para el historial). */
  stockAfter: number;
  unitCostCents: number;
  date: string;
  userId: Id;
  reason?: string;
  /** Documento que lo originó (venta, compra, anulación...). */
  docType?: 'sale' | 'purchase' | 'manual' | 'count';
  docId?: Id;
}

export type PaymentMethod = 'cash' | 'transfer' | 'card' | 'credit';

export interface SaleLine {
  productId: Id;
  name: string;
  quantity: number;
  priceCents: number;
  costCents: number;
  /** % de ITBIS aplicado a esta línea (0 si no lleva). */
  taxRate: number;
  discountCents: number;
}

export interface Sale {
  id: Id;
  /** Número correlativo para el recibo (cada equipo lleva su propia cuenta). */
  number: number;
  /** Letra del equipo que cobró (A, B...): con varios equipos, el recibo es "#B-12". */
  series?: string;
  date: string;
  /** Día del cuadre (AAAA-MM-DD, hora local). */
  dayKey: string;
  clientId?: Id;
  clientName?: string;
  lines: SaleLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  payment: PaymentMethod;
  userId: Id;
  status: 'done' | 'void';
  voidedAt?: string;
  voidedBy?: Id;
  voidReason?: string;
  /** Llave única de la operación: el mismo toque dos veces no crea dos ventas. */
  requestId: string;
}

export interface Client {
  id: Id;
  name: string;
  phone?: string;
  notes?: string;
  /** Lo que debe (fiado), en centavos. Se mueve con el libro de fiado. */
  balanceCents: number;
  creditLimitCents?: number;
  active: boolean;
  createdAt: string;
}

/** Libro del fiado: cada fiado suma, cada abono resta. */
export interface CreditEntry {
  id: Id;
  clientId: Id;
  date: string;
  /**
   * sale: venta de la tienda fiada · lottery: lotería fiada · payment: abono · charge: deuda anotada a mano (ej. lo que
   * debía en la libreta) · saleVoid / adjust: anulación, devolución o corrección de una venta o jugada.
   */
  kind: 'sale' | 'lottery' | 'payment' | 'charge' | 'saleVoid' | 'adjust';
  /** + aumenta la deuda, - la baja. */
  amountCents: number;
  /** Lo que quedó debiendo al anotarlo (la pantalla calcula el saldo por fecha, por si se anota algo con fecha anterior). */
  balanceAfterCents: number;
  saleId?: Id;
  userId: Id;
  note?: string;
  /** Un abono o una deuda a mano que se anuló (ya no cuenta). */
  status?: 'void';
}

/** Una jugada de lotería vendida a un cliente (lo que anota en la libreta: el nombre y cuánto compró). */
export interface LotteryEntry {
  id: Id;
  dayKey: string;
  date: string;
  clientId?: Id;
  clientName: string;
  amountCents: number;
  /** De qué lotería (si lleva la lista en Ajustes). */
  lottery?: string;
  /** Si se le fió (va a la cuenta del cliente). */
  credit: boolean;
  userId: Id;
  note?: string;
  status: 'done' | 'void';
  requestId: string;
}

/** Premio de lotería pagado a un cliente ("lo que se sacaron"): resta en el cuadre del día. */
export interface Prize {
  id: Id;
  dayKey: string;
  date: string;
  clientId?: Id;
  clientName: string;
  amountCents: number;
  lottery?: string;
  userId: Id;
  note?: string;
  status: 'done' | 'void';
  requestId: string;
}

/** Totales del cuadre de lotería de un día. */
export interface DayTotals {
  salesCount: number;
  salesCents: number;
  commissionPct: number;
  /** Lo que gana ella: el % de la venta de lotería del día. */
  commissionCents: number;
  prizesCount: number;
  prizesCents: number;
  /** Lo que tiene que entregar: venta - comisión - premios. */
  deliverCents: number;
}

/** El cuadre de lotería de un día: abierto mientras se vende; al cerrarlo se guardan los totales y ya no cambia. */
export interface Day {
  dayKey: string;
  status: 'open' | 'closed';
  commissionPct: number;
  totals?: DayTotals;
  closedAt?: string;
  closedBy?: Id;
  note?: string;
}

export interface Settings {
  businessName: string;
  /** % de comisión de la venta de lotería del día (el de fábrica para cada día nuevo). */
  commissionPct: number;
  /** Las loterías que vende (si está vacía, no se pregunta de cuál). */
  lotteries: string[];
  /** Minutos sin usar la app para que se bloquee y pida el PIN (0 = nunca). */
  lockMinutes: number;
  taxEnabled: boolean;
  taxRate: number;
  currency: string;
  receiptFooter: string;
  /** Si se puede vender sin existencia (queda en negativo). */
  allowNegativeStock: boolean;
  lastBackupAt?: string;
  /** Contador viejo de recibos (antes de sincronizar): ahora cada equipo lleva el suyo en DeviceLocal. */
  nextSaleNumber: number;
}

/** Un equipo vinculado al negocio (se ve en todos los equipos; la dueña puede quitarlo). */
export interface Device {
  id: Id;
  /** Nombre para reconocerlo: "iPad de Martina", "Teléfono de Juan". */
  name: string;
  /** Letra de sus recibos. */
  letter: string;
  linkedAt: string;
  lastSeenAt: string;
  /** Si la dueña lo quitó: al conectarse, el equipo borra sus datos y se desvincula. */
  blocked?: boolean;
}

/** Datos de ESTE equipo (no se sincronizan): su letra y su contador de recibos. */
export interface DeviceLocal {
  key: 'device';
  deviceId: Id;
  series?: string;
  nextSaleNumber: number;
}

/** Bitácora: quién hizo qué (anulaciones, correcciones, ajustes, cierres). */
export interface AuditEntry {
  id: Id;
  date: string;
  userId: Id;
  action: string;
  entity: string;
  entityId?: Id;
  details?: string;
}
