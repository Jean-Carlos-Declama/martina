import type { MartinaDb } from '../db/database';
import { BusinessError, nowIso } from './common';

/**
 * Respaldo: todo lo de la app en un archivo (las fotos van dentro como texto). Como los datos viven solo en el
 * iPad, este archivo es lo único que salva la información si el iPad se pierde o se borra la app. Se guarda en
 * Archivos / iCloud / WhatsApp, y se recupera desde ahí.
 */
const FORMAT = 'martina-respaldo';
const VERSION = 1;

const TABLES = ['users', 'categories', 'suppliers', 'products', 'movements', 'sales', 'clients', 'credit', 'lottery', 'prizes', 'days', 'audit', 'settings'] as const;

export async function exportBackup(database: MartinaDb): Promise<string> {
  const data: Record<string, unknown[]> = {};
  for (const name of TABLES) {
    const rows = await database.table(name).toArray();
    data[name] = name === 'products' ? await Promise.all(rows.map(encodePhoto)) : rows;
  }
  return JSON.stringify({ format: FORMAT, version: VERSION, createdAt: nowIso(), data });
}

/** Reemplaza TODO lo del iPad con lo del respaldo (en una sola transacción: si algo falla, no se toca nada). */
export async function importBackup(database: MartinaDb, json: string): Promise<{ products: number; sales: number }> {
  let parsed: { format?: string; version?: number; data?: Record<string, unknown[]> };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new BusinessError('El archivo no es un respaldo de Martina.');
  }
  if (parsed.format !== FORMAT || !parsed.data) throw new BusinessError('El archivo no es un respaldo de Martina.');
  if ((parsed.version ?? 0) > VERSION) throw new BusinessError('El respaldo es de una versión más nueva de la app: actualízala primero.');
  const data = parsed.data;
  const products = await Promise.all(((data.products ?? []) as Record<string, unknown>[]).map(decodePhoto));
  await database.transaction('rw', TABLES.map(name => database.table(name)), async () => {
    for (const name of TABLES) {
      await database.table(name).clear();
      const rows = name === 'products' ? products : data[name] ?? [];
      if (rows.length > 0) await database.table(name).bulkAdd(rows);
    }
  });
  return { products: products.length, sales: (data.sales ?? []).length };
}

async function encodePhoto(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const photo = row.photo;
  if (!(photo instanceof Blob)) return row;
  const bytes = new Uint8Array(await photo.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { ...row, photo: { type: photo.type, base64: btoa(binary) } };
}

async function decodePhoto(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const photo = row.photo as { type?: string; base64?: string } | undefined;
  if (!photo?.base64) return row;
  const binary = atob(photo.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { ...row, photo: new Blob([bytes], { type: photo.type ?? 'image/jpeg' }) };
}
