import type { MartinaDb } from '../db/database';
import type { Id, Product } from '../db/types';
import { audit } from './audit';
import { BusinessError, newId, nowIso } from './common';
import { recordMovement } from './stock';

/** Lo que se llena en el formulario de un producto (la existencia no se edita: solo la inicial al crearlo). */
export interface ProductInput {
  sku?: string;
  barcode?: string;
  name: string;
  description?: string;
  categoryId?: Id;
  brand?: string;
  photo?: Blob;
  unit: string;
  costCents: number;
  priceCents: number;
  taxed: boolean;
  minStock: number;
  supplierId?: Id;
}

function clean(input: ProductInput): ProductInput {
  return {
    ...input,
    sku: input.sku?.trim() || undefined,
    barcode: input.barcode?.trim() || undefined,
    name: input.name.trim(),
    brand: input.brand?.trim() || undefined,
    description: input.description?.trim() || undefined,
    unit: input.unit.trim() || 'unidad',
  };
}

function validate(input: ProductInput): void {
  if (!input.name) throw new BusinessError('Ponle un nombre al producto.');
  if (input.priceCents < 0 || input.costCents < 0) throw new BusinessError('El precio y el costo no pueden ser negativos.');
  if (input.minStock < 0) throw new BusinessError('El mínimo no puede ser negativo.');
}

/** Revisa que el código interno y el de barras no los tenga ya otro producto. */
async function checkUnique(database: MartinaDb, input: ProductInput, exceptId?: Id): Promise<void> {
  if (input.sku) {
    const other = await database.products.where('sku').equals(input.sku).first();
    if (other && other.id !== exceptId) throw new BusinessError(`El código ${input.sku} ya es de "${other.name}".`);
  }
  if (input.barcode) {
    const other = await database.products.where('barcode').equals(input.barcode).first();
    if (other && other.id !== exceptId) throw new BusinessError(`El código de barras ya es de "${other.name}".`);
  }
}

/** Código interno nuevo (P0001, P0002...) si no le pusieron uno. */
async function nextSku(database: MartinaDb): Promise<string> {
  const count = await database.products.count();
  for (let n = count + 1; ; n++) {
    const sku = `P${String(n).padStart(4, '0')}`;
    if (!(await database.products.where('sku').equals(sku).first())) return sku;
  }
}

/** Crea un producto; si trae existencia inicial, entra como movimiento "existencia inicial". */
export async function createProduct(database: MartinaDb, raw: ProductInput, initialStock: number, userId: Id): Promise<Product> {
  const input = clean(raw);
  validate(input);
  if (initialStock < 0) throw new BusinessError('La existencia inicial no puede ser negativa.');
  return database.transaction('rw', database.products, database.movements, database.audit, async () => {
    await checkUnique(database, input);
    const now = nowIso();
    const product: Product = {
      ...input,
      id: newId(),
      sku: input.sku ?? (await nextSku(database)),
      stock: 0,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    await database.products.add(product);
    if (initialStock > 0)
      await recordMovement(database, { productId: product.id, type: 'initial', quantity: initialStock, userId, reason: 'Existencia inicial' });
    await audit(database, userId, 'crear', 'producto', product.id, product.name);
    return (await database.products.get(product.id))!;
  });
}

/** Edita los datos de un producto (la existencia NO: esa solo cambia con movimientos). */
export async function updateProduct(database: MartinaDb, id: Id, raw: ProductInput, userId: Id): Promise<void> {
  const input = clean(raw);
  validate(input);
  await database.transaction('rw', database.products, database.audit, async () => {
    const product = await database.products.get(id);
    if (!product) throw new BusinessError('El producto no existe.');
    await checkUnique(database, input, id);
    const changes: string[] = [];
    if (product.priceCents !== input.priceCents) changes.push(`precio ${product.priceCents / 100} → ${input.priceCents / 100}`);
    if (product.costCents !== input.costCents) changes.push(`costo ${product.costCents / 100} → ${input.costCents / 100}`);
    await database.products.update(id, { ...input, sku: input.sku ?? product.sku, updatedAt: nowIso() });
    await audit(database, userId, 'editar', 'producto', id, changes.join('; ') || product.name);
  });
}

/** Archiva o reactiva un producto (no se borra: su historial queda). */
export async function setProductActive(database: MartinaDb, id: Id, active: boolean, userId: Id): Promise<void> {
  await database.transaction('rw', database.products, database.audit, async () => {
    await database.products.update(id, { active, updatedAt: nowIso() });
    await audit(database, userId, active ? 'reactivar' : 'archivar', 'producto', id);
  });
}

/** Busca por nombre, código interno, código de barras o marca (sin importar mayúsculas ni acentos). */
export function matchesSearch(product: Product, text: string): boolean {
  const needle = normalize(text);
  if (!needle) return true;
  return [product.name, product.sku, product.barcode, product.brand].some(field => field && normalize(field).includes(needle));
}

export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
