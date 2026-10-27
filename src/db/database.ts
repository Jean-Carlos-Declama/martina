import Dexie, { type EntityTable, type Table } from 'dexie';
import type {
  AuditEntry,
  Category,
  Client,
  CreditEntry,
  Day,
  LotteryEntry,
  Movement,
  Prize,
  Product,
  Sale,
  Settings,
  Supplier,
  User,
} from './types';

/** Ajustes con los que arranca la app la primera vez. */
export const DEFAULT_SETTINGS: Settings = {
  businessName: 'Martina',
  commissionPct: 10,
  lotteries: [],
  lockMinutes: 10,
  taxEnabled: false,
  taxRate: 18,
  currency: 'RD$',
  receiptFooter: '¡Gracias por su compra!',
  allowNegativeStock: false,
  nextSaleNumber: 1,
};

/**
 * La base de datos de la app, guardada en el iPad (IndexedDB). Cada tabla con sus índices para buscar rápido.
 * Si en el futuro cambian las tablas, se agrega una versión nueva aquí (nunca se cambia una versión vieja).
 */
export class MartinaDb extends Dexie {
  users!: EntityTable<User, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  suppliers!: EntityTable<Supplier, 'id'>;
  products!: EntityTable<Product, 'id'>;
  movements!: EntityTable<Movement, 'id'>;
  sales!: EntityTable<Sale, 'id'>;
  clients!: EntityTable<Client, 'id'>;
  credit!: EntityTable<CreditEntry, 'id'>;
  lottery!: EntityTable<LotteryEntry, 'id'>;
  prizes!: EntityTable<Prize, 'id'>;
  days!: EntityTable<Day, 'dayKey'>;
  audit!: EntityTable<AuditEntry, 'id'>;
  settings!: Table<Settings & { key: string }, string>;

  constructor(name = 'martina') {
    super(name);
    this.version(1).stores({
      users: 'id, name, role',
      categories: 'id, &name',
      suppliers: 'id, name, active',
      products: 'id, &sku, &barcode, name, categoryId, supplierId, active, stock',
      movements: 'id, productId, [productId+date], date, type, docId',
      sales: 'id, &requestId, number, date, dayKey, clientId, status',
      clients: 'id, name, phone, active',
      credit: 'id, clientId, [clientId+date], date, saleId',
      lottery: 'id, &requestId, dayKey, clientId, date',
      prizes: 'id, &requestId, dayKey, clientId, date',
      days: 'dayKey, status',
      audit: 'id, date, entity, entityId',
      settings: 'key',
    });
  }
}

/** La base de la app (una sola). Las pruebas crean la suya. */
export const db = new MartinaDb();

/** Los ajustes (si todavía no hay, los de fábrica). */
export async function getSettings(database: MartinaDb = db): Promise<Settings> {
  const row = await database.settings.get('main');
  if (!row) return { ...DEFAULT_SETTINGS };
  const { key: _key, ...settings } = row;
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings: Settings, database: MartinaDb = db): Promise<void> {
  await database.settings.put({ ...settings, key: 'main' });
}
