import type { MartinaDb } from '../db/database';
import type { Id, Role, User } from '../db/types';
import { audit } from './audit';
import { BusinessError, newId, nowIso } from './common';

/**
 * Usuarios con clave (PIN de 4 a 6 números). El PIN no se guarda: se guarda su huella (PBKDF2), así nadie lo puede
 * leer en el iPad. Es para que el empleado no entre como la dueña, no una caja fuerte.
 */
const ITERATIONS = 100_000;

export async function hashPin(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: ITERATIONS },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function checkPin(pin: string): void {
  if (!/^\d{4,6}$/.test(pin)) throw new BusinessError('El PIN tiene que ser de 4 a 6 números.');
}

export async function createUser(database: MartinaDb, name: string, role: Role, pin: string, byUserId?: Id): Promise<User> {
  if (!name.trim()) throw new BusinessError('Escribe el nombre.');
  checkPin(pin);
  const salt = newId();
  const user: User = { id: newId(), name: name.trim(), role, pinHash: await hashPin(pin, salt), pinSalt: salt, active: true, createdAt: nowIso() };
  await database.transaction('rw', database.users, database.audit, async () => {
    await database.users.add(user);
    await audit(database, byUserId ?? user.id, 'crear', 'usuario', user.id, `${user.name} (${role})`);
  });
  return user;
}

export async function verifyPin(user: User, pin: string): Promise<boolean> {
  return user.active && (await hashPin(pin, user.pinSalt)) === user.pinHash;
}

/** Cambia el PIN (hay que saber el actual). */
export async function changePin(database: MartinaDb, userId: Id, currentPin: string, newPin: string): Promise<void> {
  const user = await database.users.get(userId);
  if (!user || !(await verifyPin(user, currentPin))) throw new BusinessError('El PIN actual no es correcto.');
  checkPin(newPin);
  const salt = newId();
  await database.users.update(userId, { pinHash: await hashPin(newPin, salt), pinSalt: salt });
  await audit(database, userId, 'cambiar PIN', 'usuario', userId);
}

/** La dueña le pone un PIN nuevo a alguien que lo olvidó. */
export async function resetPin(database: MartinaDb, userId: Id, newPin: string, ownerId: Id): Promise<void> {
  checkPin(newPin);
  const owner = await database.users.get(ownerId);
  if (owner?.role !== 'owner') throw new BusinessError('Solo la dueña puede cambiar el PIN de otro.');
  const salt = newId();
  await database.users.update(userId, { pinHash: await hashPin(newPin, salt), pinSalt: salt });
  await audit(database, ownerId, 'nuevo PIN', 'usuario', userId);
}

/** Activa o desactiva a alguien (nunca deja la app sin una dueña activa). */
export async function setUserActive(database: MartinaDb, userId: Id, active: boolean, ownerId: Id): Promise<void> {
  await database.transaction('rw', database.users, database.audit, async () => {
    const owner = await database.users.get(ownerId);
    if (owner?.role !== 'owner') throw new BusinessError('Solo la dueña puede hacer esto.');
    const user = await database.users.get(userId);
    if (!user) throw new BusinessError('Ese usuario no existe.');
    if (!active && user.role === 'owner') {
      const owners = await database.users.filter(u => u.role === 'owner' && u.active && u.id !== userId).count();
      if (owners === 0) throw new BusinessError('Tiene que quedar al menos una dueña activa.');
    }
    await database.users.update(userId, { active });
    await audit(database, ownerId, active ? 'activar' : 'desactivar', 'usuario', userId, user.name);
  });
}

/** Busca a la dueña que tenga ese PIN (para autorizar anulaciones y cierres desde la cuenta del empleado). */
export async function ownerByPin(database: MartinaDb, pin: string): Promise<User | undefined> {
  const owners = await database.users.where('role').equals('owner').toArray();
  for (const owner of owners) if (await verifyPin(owner, pin)) return owner;
  return undefined;
}
