import Dexie from 'dexie';
import { CLOUD } from '../config';
import { exportBackup, importBackup } from '../domain/backup';
import { BusinessError, nowIso } from '../domain/common';
import { db, getDeviceLocal, getSettings, MartinaDb } from './database';

/**
 * Sincronización entre equipos (Dexie Cloud). Cómo funciona:
 *
 * - Todo el negocio es UN usuario de Dexie Cloud: cada equipo vinculado entra como ese usuario y ve lo mismo.
 *   Quién es quién (dueña, empleado, solo mirar) lo decide el PIN dentro de la app, como siempre.
 * - Para entrar, el equipo manda la "llave del negocio" (la que va en el QR) al enlace de Cloudflare
 *   (carpeta enlace/), que la revisa y le pide a Dexie Cloud el permiso. La clave de Dexie Cloud solo la tiene el
 *   enlace: este código es público.
 * - Lo que se anota sin internet se guarda y se sube cuando vuelve la conexión.
 * - La llave se guarda en localStorage (fuera de la base) porque Dexie Cloud la vuelve a pedir si un día el permiso
 *   se vence, y porque al vincular se borra la base de este equipo.
 */

const LINK_KEY = 'martina.enlace';
const NAME_KEY = 'martina.equipo';
const PENDING_KEY = 'martina.enlace-pendiente';
const MIGRATED_KEY = 'martina.migrado';

export const cloudEnabled = !!CLOUD.databaseUrl && !!CLOUD.linkUrl;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Sin almacenamiento (modo privado): no se puede vincular, la app sigue sola.
  }
}

/** La llave del negocio, si este equipo está vinculado. */
export function linkSecret(): string | null {
  return readStorage(LINK_KEY);
}

export function isLinked(): boolean {
  return cloudEnabled && !!linkSecret();
}

/** Lo que va dentro del QR: la dirección de la app con la llave (si se escanea con la cámara normal, abre la app y explica qué hacer). */
export function linkUrl(): string {
  return `${location.origin}${import.meta.env.BASE_URL}#vincular=${linkSecret() ?? ''}`;
}

/** Saca la llave de lo que leyó el escáner (la dirección completa o solo la llave). */
export function parseLinkCode(text: string): string | null {
  const match = text.match(/vincular=([A-Za-z0-9_-]{20,})/) ?? text.trim().match(/^([A-Za-z0-9_-]{20,})$/);
  return match ? match[1] : null;
}

/** Se llama una sola vez al arrancar, antes de que la app toque la base. */
export async function startCloud(): Promise<void> {
  if (!cloudEnabled) return;
  db.cloud.configure({
    databaseUrl: CLOUD.databaseUrl,
    requireAuth: false,
    customLoginGui: true,
    socialAuth: false,
    unsyncedTables: ['local'],
    fetchTokens: async ({ public_key }) => {
      const link = linkSecret();
      if (!link) throw new BusinessError('Este equipo no está vinculado.');
      const response = await fetch(CLOUD.linkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_key, link }),
      });
      if (response.status === 403) {
        writeStorage(LINK_KEY, null);
        throw new BusinessError('Ese código QR ya no sirve. Pídele a la dueña que te muestre el de ahora.');
      }
      if (!response.ok) throw new BusinessError('No se pudo conectar para vincular. Revisa el internet e intenta otra vez.');
      return response.json();
    },
  });
  await migrateOldLocalData();
  if (readStorage(PENDING_KEY)) {
    writeStorage(PENDING_KEY, null);
    await connect();
  }
}

/**
 * Antes de la sincronización, los datos vivían en la base "martina" de este equipo. Con la nube, la base se llama
 * distinto; la primera vez se copian aquí (y la vieja se deja quieta, por si acaso).
 */
async function migrateOldLocalData(): Promise<void> {
  if (readStorage(MIGRATED_KEY)) return;
  if ((await Dexie.exists('martina')) && (await db.users.count()) === 0) {
    const old = new MartinaDb('martina');
    try {
      if ((await old.users.count()) > 0) {
        await importBackup(db, await exportBackup(old));
        const settings = await getSettings(old);
        await db.local.put({ ...(await getDeviceLocal(db)), nextSaleNumber: settings.nextSaleNumber });
      }
    } finally {
      old.close();
    }
  }
  writeStorage(MIGRATED_KEY, '1');
}

/** Entra a la nube con la llave guardada, baja lo del negocio y anota este equipo en la lista. */
async function connect(): Promise<void> {
  await db.cloud.login();
  await db.cloud.sync({ wait: true, purpose: 'pull' });
  await registerDevice();
}

/** Anota este equipo en la lista de equipos (con su letra para los recibos) o le pone la hora de ahora. */
async function registerDevice(): Promise<void> {
  const local = await getDeviceLocal(db);
  let device = await db.devices.get(local.deviceId);
  if (!device) {
    const used = new Set((await db.devices.toArray()).map(d => d.letter));
    const letter = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(l => !used.has(l)) ?? 'Z';
    device = { id: local.deviceId, name: readStorage(NAME_KEY) || defaultDeviceName(), letter, linkedAt: nowIso(), lastSeenAt: nowIso() };
    await db.devices.add(device);
  } else {
    await db.devices.update(device.id, { lastSeenAt: nowIso() });
  }
  await db.local.put({ ...local, series: device.letter });
}

export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Teléfono Android';
  return 'Computadora';
}

/**
 * Activa la sincronización en el equipo PRINCIPAL (el iPad de Martina): lo que ya tiene anotado se sube a la nube.
 * Se hace una sola vez, con el código de activación que da el dueño del sistema.
 */
export async function activateMainDevice(code: string, name: string): Promise<void> {
  writeStorage(LINK_KEY, code);
  writeStorage(NAME_KEY, name.trim() || defaultDeviceName());
  try {
    await connect();
  } catch (error) {
    writeStorage(LINK_KEY, null);
    throw error;
  }
}

/**
 * Vincula este equipo a un negocio que ya está en otro equipo. Lo que este equipo tuviera anotado se BORRA antes
 * (si no, se mezclaría con lo del negocio); luego la app se recarga y baja todo lo del negocio.
 */
export async function linkToBusiness(code: string, name: string): Promise<void> {
  writeStorage(LINK_KEY, code);
  writeStorage(NAME_KEY, name.trim() || defaultDeviceName());
  writeStorage(PENDING_KEY, '1');
  writeStorage(MIGRATED_KEY, '1');
  await db.delete();
  location.reload();
}

/** Desvincula este equipo: borra sus datos (en la nube y en los otros equipos quedan) y vuelve a empezar. */
export async function unlinkThisDevice(): Promise<void> {
  writeStorage(LINK_KEY, null);
  writeStorage(PENDING_KEY, null);
  writeStorage(MIGRATED_KEY, '1');
  await db.delete();
  location.reload();
}

/** Al abrir la app ya vinculada: anota que este equipo se usó hoy (para la lista de equipos). */
export async function touchDevice(): Promise<void> {
  if (!isLinked()) return;
  const local = await getDeviceLocal(db);
  const device = await db.devices.get(local.deviceId);
  if (!device) return registerDevice();
  if (Date.now() - Date.parse(device.lastSeenAt) > 6 * 60 * 60 * 1000) await db.devices.update(device.id, { lastSeenAt: nowIso() });
}

/** La dueña quita un equipo (perdido, de alguien que ya no trabaja): al conectarse, ese equipo borra todo. */
export async function blockDevice(id: string): Promise<void> {
  const local = await getDeviceLocal(db);
  if (id === local.deviceId) throw new BusinessError('Para este equipo usa «Desvincular este equipo».');
  await db.devices.update(id, { blocked: true });
}
