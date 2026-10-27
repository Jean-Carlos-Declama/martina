import type { MartinaDb } from '../db/database';
import type { Category, Id, Supplier } from '../db/types';
import { audit } from './audit';
import { BusinessError, newId, nowIso } from './common';
import { normalize } from './products';

// Categorías (para agrupar los productos) y proveedores (a quién se le compra).

export async function saveCategory(database: MartinaDb, name: string, userId: Id, id?: Id): Promise<Category> {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new BusinessError('Escribe el nombre de la categoría.');
  return database.transaction('rw', database.categories, database.audit, async () => {
    const other = await database.categories.filter(c => c.id !== id && normalize(c.name) === normalize(clean)).first();
    if (other) throw new BusinessError(`Ya existe la categoría "${other.name}".`);
    const category: Category = { id: id ?? newId(), name: clean };
    await database.categories.put(category);
    await audit(database, userId, id ? 'editar' : 'crear', 'categoría', category.id, clean);
    return category;
  });
}

/** Se borra solo si ningún producto la usa. */
export async function deleteCategory(database: MartinaDb, id: Id, userId: Id): Promise<void> {
  await database.transaction('rw', database.categories, database.products, database.audit, async () => {
    const used = await database.products.where('categoryId').equals(id).count();
    if (used > 0) throw new BusinessError(`Hay ${used} producto(s) en esa categoría: cámbialos primero.`);
    await database.categories.delete(id);
    await audit(database, userId, 'borrar', 'categoría', id);
  });
}

export interface SupplierInput {
  name: string;
  phone?: string;
  notes?: string;
}

export async function saveSupplier(database: MartinaDb, input: SupplierInput, userId: Id, id?: Id): Promise<Supplier> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new BusinessError('Escribe el nombre del proveedor.');
  return database.transaction('rw', database.suppliers, database.audit, async () => {
    const other = await database.suppliers.filter(s => s.id !== id && normalize(s.name) === normalize(name)).first();
    if (other) throw new BusinessError(`Ya existe el proveedor "${other.name}".`);
    const existing = id ? await database.suppliers.get(id) : undefined;
    const supplier: Supplier = {
      id: id ?? newId(),
      name,
      phone: input.phone?.replace(/[^\d+]/g, '') || undefined,
      notes: input.notes?.trim() || undefined,
      active: existing?.active ?? true,
      createdAt: existing?.createdAt ?? nowIso(),
    };
    await database.suppliers.put(supplier);
    await audit(database, userId, id ? 'editar' : 'crear', 'proveedor', supplier.id, name);
    return supplier;
  });
}
