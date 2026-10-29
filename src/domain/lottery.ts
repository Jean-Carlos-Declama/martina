import { getSettings, type MartinaDb } from '../db/database';
import type { Day, DayTotals, Id, LotteryEntry, Prize } from '../db/types';
import { audit } from './audit';
import { BusinessError, dayKeyOf, newId, nowIso, percentOf } from './common';
import { addCredit } from './credit';
import { normalize } from './products';

/**
 * La lotería, como la lleva Martina en su libreta: cada cliente con lo que jugó y los premios que cobró (cuántas
 * veces y cuánto), y al final la venta del día, su comisión (un % de la venta), los premios pagados y lo que tiene
 * que entregar = venta - comisión - premios. Al cerrar el día se guardan los totales y ya no se puede anotar ni anular
 * nada de ese día (salvo que la dueña lo reabra). La tienda (inventario) va aparte y no depende de este cierre.
 */

/** Tiene que llamarse dentro de una transacción con las tablas days y settings. Crea el día si no existe; falla si está cerrado. */
export async function ensureDayOpen(database: MartinaDb, dayKey: string): Promise<Day> {
  const day = await database.days.get(dayKey);
  if (day?.status === 'closed') throw new BusinessError(`La lotería del ${dayKey} ya se cerró. La dueña la puede reabrir.`);
  if (day) return day;
  const settings = await getSettings(database);
  const created: Day = { dayKey, status: 'open', commissionPct: settings.commissionPct };
  await database.days.add(created);
  return created;
}

/** El nombre a anotar: el del cliente registrado o el que se escribió a mano. */
async function nameFor(database: MartinaDb, clientId: Id | undefined, typed: string | undefined): Promise<string> {
  if (clientId) {
    const client = await database.clients.get(clientId);
    if (!client) throw new BusinessError('El cliente no existe.');
    return client.name;
  }
  const name = typed?.trim() ?? '';
  if (!name) throw new BusinessError('Escribe el nombre del cliente.');
  return name;
}

export interface LotteryInput {
  clientId?: Id;
  clientName?: string;
  amountCents: number;
  lottery?: string;
  /** Fiado: va a la cuenta del cliente (tiene que estar registrado). */
  credit?: boolean;
  note?: string;
  userId: Id;
  /** Llave única (se genera al abrir el formulario): el doble toque no anota dos veces. */
  requestId: string;
  /** Día del cuadre (AAAA-MM-DD). Vacío = hoy; un día anterior sirve para corregir un cuadre (si sigue abierto). */
  dayKey?: string;
}

/** El día donde se anota: hoy, o uno anterior para corregir (nunca uno que no ha llegado). */
function targetDay(dayKey?: string): string {
  const today = dayKeyOf();
  if (!dayKey) return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new BusinessError('Ese día no es válido.');
  if (dayKey > today) throw new BusinessError('No se puede anotar en un día que todavía no ha llegado.');
  return dayKey;
}

/** Anota lo que jugó un cliente (hoy, o en un día anterior que siga abierto). */
export async function addLotterySale(database: MartinaDb, input: LotteryInput): Promise<LotteryEntry> {
  if (!(input.amountCents > 0)) throw new BusinessError('La cantidad tiene que ser mayor que cero.');
  if (input.credit && !input.clientId) throw new BusinessError('Para fiar hay que escoger el cliente.');
  const dayKey = targetDay(input.dayKey);
  const tables = [database.lottery, database.days, database.settings, database.clients, database.credit, database.audit];
  return database.transaction('rw', tables, async () => {
    const repeated = await database.lottery.where('requestId').equals(input.requestId).first();
    if (repeated) return repeated;
    await ensureDayOpen(database, dayKey);
    const entry: LotteryEntry = {
      id: newId(),
      dayKey,
      date: nowIso(),
      clientId: input.clientId,
      clientName: await nameFor(database, input.clientId, input.clientName),
      amountCents: Math.round(input.amountCents),
      lottery: input.lottery?.trim() || undefined,
      credit: !!input.credit,
      userId: input.userId,
      note: input.note?.trim() || undefined,
      status: 'done',
      requestId: input.requestId,
    };
    await database.lottery.add(entry);
    if (entry.credit) await addCredit(database, entry.clientId!, entry.amountCents, 'lottery', input.userId, entry.id, entry.lottery);
    if (dayKey !== dayKeyOf()) await audit(database, input.userId, 'anotar en día anterior', 'lotería', entry.id, `${dayKey} · ${entry.clientName}: ${entry.amountCents / 100}`);
    return entry;
  });
}

/** Lo que se puede corregir de una jugada o un premio. */
export interface EntryChanges {
  clientId?: Id;
  clientName?: string;
  amountCents: number;
  lottery?: string;
}

/** Corrige una jugada mal anotada (cliente, monto o lotería) mientras su día está abierto: el cuadre se recalcula solo. */
export async function updateLotterySale(database: MartinaDb, entryId: Id, changes: EntryChanges, userId: Id): Promise<void> {
  if (!(changes.amountCents > 0)) throw new BusinessError('La cantidad tiene que ser mayor que cero.');
  const tables = [database.lottery, database.days, database.settings, database.clients, database.credit, database.audit];
  await database.transaction('rw', tables, async () => {
    const entry = await database.lottery.get(entryId);
    if (!entry || entry.status === 'void') throw new BusinessError('Esa jugada no existe o ya está anulada.');
    await ensureDayOpen(database, entry.dayKey);
    if (entry.credit && changes.clientId !== entry.clientId)
      throw new BusinessError(`Esa jugada se le fió a ${entry.clientName}: para cambiar el cliente, anúlala y anótala otra vez.`);
    const clientName = await nameFor(database, changes.clientId, changes.clientName);
    const amount = Math.round(changes.amountCents);
    await database.lottery.update(entryId, { clientId: changes.clientId, clientName, amountCents: amount, lottery: changes.lottery?.trim() || undefined });
    // Si era fiada, a la cuenta del cliente se le suma o resta la diferencia.
    if (entry.credit && entry.clientId && amount !== entry.amountCents)
      await addCredit(database, entry.clientId, amount - entry.amountCents, 'adjust', userId, entry.id, 'Lotería corregida');
    await audit(database, userId, 'corregir', 'lotería', entryId, `${entry.clientName} ${entry.amountCents / 100} → ${clientName} ${amount / 100}`);
  });
}

/** Anula una jugada mal anotada (solo si su día sigue abierto; si era fiada, se le quita de la cuenta). */
export async function voidLotterySale(database: MartinaDb, entryId: Id, userId: Id, reason: string): Promise<void> {
  if (!reason.trim()) throw new BusinessError('Escribe por qué se anula.');
  const tables = [database.lottery, database.days, database.settings, database.clients, database.credit, database.audit];
  await database.transaction('rw', tables, async () => {
    const entry = await database.lottery.get(entryId);
    if (!entry) throw new BusinessError('Esa jugada no existe.');
    if (entry.status === 'void') return;
    await ensureDayOpen(database, entry.dayKey);
    await database.lottery.update(entryId, { status: 'void' });
    if (entry.credit && entry.clientId) await addCredit(database, entry.clientId, -entry.amountCents, 'adjust', userId, entry.id, 'Lotería anulada');
    await audit(database, userId, 'anular', 'lotería', entryId, `${entry.clientName}: ${entry.amountCents / 100}. ${reason.trim()}`);
  });
}

export interface PrizeInput {
  clientId?: Id;
  clientName?: string;
  amountCents: number;
  lottery?: string;
  note?: string;
  userId: Id;
  requestId: string;
  /** Día del cuadre (vacío = hoy). */
  dayKey?: string;
}

/** Paga un premio a un cliente: sale del dinero del día y resta de lo que se entrega. */
export async function addPrize(database: MartinaDb, input: PrizeInput): Promise<Prize> {
  if (!(input.amountCents > 0)) throw new BusinessError('El premio tiene que ser mayor que cero.');
  const dayKey = targetDay(input.dayKey);
  return database.transaction('rw', [database.prizes, database.days, database.clients, database.settings, database.audit], async () => {
    const repeated = await database.prizes.where('requestId').equals(input.requestId).first();
    if (repeated) return repeated;
    await ensureDayOpen(database, dayKey);
    const prize: Prize = {
      id: newId(),
      dayKey,
      date: nowIso(),
      clientId: input.clientId,
      clientName: await nameFor(database, input.clientId, input.clientName),
      amountCents: Math.round(input.amountCents),
      lottery: input.lottery?.trim() || undefined,
      userId: input.userId,
      note: input.note?.trim() || undefined,
      status: 'done',
      requestId: input.requestId,
    };
    await database.prizes.add(prize);
    await audit(database, input.userId, 'premio', 'premio', prize.id, `${dayKey} · ${prize.clientName}: ${prize.amountCents / 100}`);
    return prize;
  });
}

/** Corrige un premio (quién o cuánto) mientras su día está abierto: lo que se entrega se recalcula solo. */
export async function updatePrize(database: MartinaDb, prizeId: Id, changes: EntryChanges, userId: Id): Promise<void> {
  if (!(changes.amountCents > 0)) throw new BusinessError('El premio tiene que ser mayor que cero.');
  await database.transaction('rw', database.prizes, database.days, database.clients, database.settings, database.audit, async () => {
    const prize = await database.prizes.get(prizeId);
    if (!prize || prize.status === 'void') throw new BusinessError('Ese premio no existe o ya está anulado.');
    await ensureDayOpen(database, prize.dayKey);
    const clientName = await nameFor(database, changes.clientId, changes.clientName);
    const amount = Math.round(changes.amountCents);
    await database.prizes.update(prizeId, { clientId: changes.clientId, clientName, amountCents: amount, lottery: changes.lottery?.trim() || undefined });
    await audit(database, userId, 'corregir', 'premio', prizeId, `${prize.clientName} ${prize.amountCents / 100} → ${clientName} ${amount / 100}`);
  });
}

/** Anula un premio mal anotado (solo si su día sigue abierto). */
export async function voidPrize(database: MartinaDb, prizeId: Id, userId: Id, reason: string): Promise<void> {
  if (!reason.trim()) throw new BusinessError('Escribe por qué se anula.');
  await database.transaction('rw', database.prizes, database.days, database.settings, database.audit, async () => {
    const prize = await database.prizes.get(prizeId);
    if (!prize) throw new BusinessError('El premio no existe.');
    if (prize.status === 'void') return;
    await ensureDayOpen(database, prize.dayKey);
    await database.prizes.update(prizeId, { status: 'void' });
    await audit(database, userId, 'anular', 'premio', prizeId, `${prize.clientName}: ${prize.amountCents / 100}. ${reason.trim()}`);
  });
}

/** Una fila del cuadre: un cliente con lo que jugó y los premios que cobró ese día. */
export interface DayClientRow {
  name: string;
  /** Cuántas veces jugó. */
  purchases: number;
  purchasesCents: number;
  /** Cuántas veces cobró premio. */
  prizes: number;
  prizesCents: number;
}

export interface DayReport {
  dayKey: string;
  status: Day['status'];
  totals: DayTotals;
  clients: DayClientRow[];
  /** Venta y premios de cada lotería (si se anotó de cuál). */
  byLottery: { name: string; salesCents: number; prizesCents: number }[];
  /** Lo que se fió ese día (no entró en efectivo, pero igual se entrega). */
  creditCents: number;
}

/** Calcula el cuadre de un día con lo anotado (con el % de comisión de ese día). */
export async function computeDay(database: MartinaDb, dayKey: string): Promise<DayReport> {
  const day = await database.days.get(dayKey);
  const commissionPct = day?.commissionPct ?? (await getSettings(database)).commissionPct;
  const entries = (await database.lottery.where('dayKey').equals(dayKey).toArray()).filter(e => e.status === 'done');
  const prizes = (await database.prizes.where('dayKey').equals(dayKey).toArray()).filter(p => p.status === 'done');

  // "Pedro", "pedro " y "PEDRO" son la misma fila. Se muestra el nombre del cliente registrado o, si no, el que
  // empieza con mayúscula.
  const rows = new Map<string, DayClientRow & { registered: boolean }>();
  const row = (name: string, registered: boolean): DayClientRow => {
    const clean = name.trim().replace(/\s+/g, ' ');
    const key = normalize(clean);
    let found = rows.get(key);
    if (!found) rows.set(key, (found = { name: clean, registered, purchases: 0, purchasesCents: 0, prizes: 0, prizesCents: 0 }));
    else if (registered ? !found.registered : !found.registered && isLower(found.name) && !isLower(clean)) {
      found.name = clean;
      found.registered = registered;
    }
    return found;
  };
  const lotteries = new Map<string, { name: string; salesCents: number; prizesCents: number }>();
  const lottery = (name?: string) => {
    const key = name || 'Sin especificar';
    let found = lotteries.get(key);
    if (!found) lotteries.set(key, (found = { name: key, salesCents: 0, prizesCents: 0 }));
    return found;
  };

  let salesCents = 0;
  let creditCents = 0;
  for (const entry of entries) {
    const r = row(entry.clientName, !!entry.clientId);
    r.purchases++;
    r.purchasesCents += entry.amountCents;
    salesCents += entry.amountCents;
    if (entry.credit) creditCents += entry.amountCents;
    lottery(entry.lottery).salesCents += entry.amountCents;
  }
  let prizesCents = 0;
  for (const prize of prizes) {
    const r = row(prize.clientName, !!prize.clientId);
    r.prizes++;
    r.prizesCents += prize.amountCents;
    prizesCents += prize.amountCents;
    lottery(prize.lottery).prizesCents += prize.amountCents;
  }
  const commissionCents = percentOf(salesCents, commissionPct);
  const totals: DayTotals = {
    salesCount: entries.length,
    salesCents,
    commissionPct,
    commissionCents,
    prizesCount: prizes.length,
    prizesCents,
    deliverCents: salesCents - commissionCents - prizesCents,
  };
  return {
    dayKey,
    status: day?.status ?? 'open',
    totals,
    clients: [...rows.values()].map(({ registered: _registered, ...r }) => r).sort((a, b) => a.name.localeCompare(b.name, 'es')),
    byLottery: [...lotteries.values()].sort((a, b) => b.salesCents - a.salesCents),
    creditCents,
  };
}

function isLower(name: string): boolean {
  const first = name.charAt(0);
  return first !== first.toLocaleUpperCase('es');
}

/** Cierra el día: guarda los totales tal como quedaron y ya no se puede tocar (solo la dueña). */
export async function closeDay(database: MartinaDb, dayKey: string, ownerId: Id, note?: string): Promise<Day> {
  const tables = [database.days, database.users, database.settings, database.audit, database.lottery, database.prizes];
  return database.transaction('rw', tables, async () => {
    const owner = await database.users.get(ownerId);
    if (!owner || owner.role !== 'owner') throw new BusinessError('Solo la dueña puede cerrar el día.');
    const day = await ensureDayOpen(database, dayKey);
    const report = await computeDay(database, dayKey);
    const closed: Day = { ...day, status: 'closed', totals: report.totals, closedAt: nowIso(), closedBy: ownerId, note: note?.trim() || undefined };
    await database.days.put(closed);
    await audit(database, ownerId, 'cerrar', 'día', dayKey, `Venta ${report.totals.salesCents / 100}, entregar ${report.totals.deliverCents / 100}`);
    return closed;
  });
}

/** Reabre un día cerrado para corregir algo (solo la dueña; queda en la bitácora). */
export async function reopenDay(database: MartinaDb, dayKey: string, ownerId: Id, reason: string): Promise<void> {
  if (!reason.trim()) throw new BusinessError('Escribe por qué se reabre el día.');
  await database.transaction('rw', database.days, database.users, database.audit, async () => {
    const owner = await database.users.get(ownerId);
    if (!owner || owner.role !== 'owner') throw new BusinessError('Solo la dueña puede reabrir el día.');
    const day = await database.days.get(dayKey);
    if (!day || day.status !== 'closed') return;
    await database.days.put({ dayKey: day.dayKey, status: 'open', commissionPct: day.commissionPct, note: day.note });
    await audit(database, ownerId, 'reabrir', 'día', dayKey, reason.trim());
  });
}

/** Cambia el % de comisión de un día (mientras está abierto). */
export async function setDayCommission(database: MartinaDb, dayKey: string, percent: number, userId: Id): Promise<void> {
  if (!(percent >= 0 && percent <= 100)) throw new BusinessError('La comisión tiene que estar entre 0 y 100 %.');
  await database.transaction('rw', database.days, database.settings, database.audit, async () => {
    const day = await ensureDayOpen(database, dayKey);
    await database.days.put({ ...day, commissionPct: percent });
    await audit(database, userId, 'comisión', 'día', dayKey, `${percent}%`);
  });
}

export interface LotteryPeriod {
  from: string;
  to: string;
  totals: Omit<DayTotals, 'commissionPct'>;
  days: { dayKey: string; status: Day['status']; totals: DayTotals }[];
}

/** La lotería de varios días (semana, mes): cada día con su propio % de comisión, y la suma. */
export async function lotteryReport(database: MartinaDb, from: string, to: string): Promise<LotteryPeriod> {
  const keys = new Set<string>();
  for (const e of await database.lottery.where('dayKey').between(from, to, true, true).toArray()) keys.add(e.dayKey);
  for (const p of await database.prizes.where('dayKey').between(from, to, true, true).toArray()) keys.add(p.dayKey);
  const days: LotteryPeriod['days'] = [];
  for (const dayKey of [...keys].sort()) {
    const report = await computeDay(database, dayKey);
    days.push({ dayKey, status: report.status, totals: report.totals });
  }
  const sum = (field: keyof Omit<DayTotals, 'commissionPct'>) => days.reduce((total, d) => total + d.totals[field], 0);
  return {
    from,
    to,
    days,
    totals: {
      salesCount: sum('salesCount'),
      salesCents: sum('salesCents'),
      commissionCents: sum('commissionCents'),
      prizesCount: sum('prizesCount'),
      prizesCents: sum('prizesCents'),
      deliverCents: sum('deliverCents'),
    },
  };
}
