import { MartinaDb } from '../db/database';
import type { User } from '../db/types';
import { newId } from '../domain/common';
import { createProduct, type ProductInput } from '../domain/products';
import { createUser } from '../domain/users';

export interface World {
  db: MartinaDb;
  owner: User;
  employee: User;
}

/** Una base nueva y vacía para cada prueba, con la dueña (PIN 1234) y un empleado (PIN 5678). */
export async function newWorld(): Promise<World> {
  const db = new MartinaDb(`prueba-${newId()}`);
  const owner = await createUser(db, 'Martina', 'owner', '1234');
  const employee = await createUser(db, 'Ayudante', 'employee', '5678', owner.id);
  return { db, owner, employee };
}

export function productInput(overrides: Partial<ProductInput> = {}): ProductInput {
  return { name: 'Refresco', unit: 'unidad', costCents: 3000, priceCents: 5000, taxed: false, minStock: 2, ...overrides };
}

export function addProduct(world: World, overrides: Partial<ProductInput> = {}, stock = 10) {
  return createProduct(world.db, productInput(overrides), stock, world.owner.id);
}
