import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { getDeviceLocal, getSettings, MartinaDb, saveSettings } from '../db/database';
import { addProduct, newWorld } from '../test/helpers';
import { exportBackup, importBackup } from './backup';
import { createClient } from './clients';
import { BusinessError, dayKeyOf, newId } from './common';
import { addCharge, clientAccount, registerPayment, updateCreditEntry, voidCreditEntry } from './credit';
import { addLotterySale, addPrize, closeDay, computeDay, lotteryReport, reopenDay, updateLotterySale, updatePrize, voidLotterySale, voidPrize } from './lottery';
import { createProduct, updateProduct } from './products';
import { salesReport, stockAlerts } from './reports';
import { createSale, receiptNumber, returnItems, voidSale } from './sales';
import { countCorrection, manualMovement } from './stock';
import { ownerByPin, verifyPin } from './users';

const today = () => dayKeyOf();

async function newClient(db: MartinaDb, name: string, creditLimitCents?: number) {
  const id = newId();
  await db.clients.add({ id, name, balanceCents: 0, creditLimitCents, active: true, createdAt: new Date().toISOString() });
  return id;
}

describe('productos e inventario', () => {
  it('la existencia inicial entra como movimiento y queda en el historial', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 12);
    expect(p.stock).toBe(12);
    expect(p.sku).toBe('P0001');
    const moves = await w.db.movements.where('productId').equals(p.id).toArray();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: 'initial', quantity: 12, stockAfter: 12 });
  });

  it('no deja repetir el código interno ni el de barras', async () => {
    const w = await newWorld();
    await addProduct(w, { sku: 'A1', barcode: '7460001' });
    await expect(addProduct(w, { sku: 'A1', name: 'Otro' })).rejects.toThrow(BusinessError);
    await expect(addProduct(w, { barcode: '7460001', name: 'Otro' })).rejects.toThrow(/código de barras/);
  });

  it('editar el producto no cambia la existencia', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 5);
    await updateProduct(w.db, p.id, { name: 'Refresco grande', unit: 'unidad', costCents: 3500, priceCents: 6000, taxed: false, minStock: 1 }, w.owner.id);
    const after = await w.db.products.get(p.id);
    expect(after).toMatchObject({ name: 'Refresco grande', priceCents: 6000, stock: 5 });
  });

  it('el conteo físico anota solo la diferencia', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const move = await countCorrection(w.db, p.id, 7, w.owner.id);
    expect(move).toMatchObject({ type: 'count', quantity: -3, stockAfter: 7 });
    expect(await countCorrection(w.db, p.id, 7, w.owner.id)).toBeNull();
  });

  it('entrada de mercancía con otro costo deja el costo promedio; las salidas piden motivo', async () => {
    const w = await newWorld();
    const p = await addProduct(w, { costCents: 3000 }, 10);
    await manualMovement(w.db, { productId: p.id, type: 'purchase', quantity: 10, unitCostCents: 4000, userId: w.owner.id });
    expect(await w.db.products.get(p.id)).toMatchObject({ stock: 20, costCents: 3500 });
    await expect(manualMovement(w.db, { productId: p.id, type: 'damaged', quantity: 2, userId: w.owner.id })).rejects.toThrow(/motivo/);
    await manualMovement(w.db, { productId: p.id, type: 'damaged', quantity: 2, reason: 'vencidos', userId: w.owner.id });
    await expect(manualMovement(w.db, { productId: p.id, type: 'internalUse', quantity: 50, reason: 'casa', userId: w.owner.id })).rejects.toThrow(
      /No hay suficiente/,
    );
    expect((await w.db.products.get(p.id))!.stock).toBe(18);
  });

  it('las cantidades con decimales no acumulan errores', async () => {
    const w = await newWorld();
    const p = await createProduct(w.db, { name: 'Arroz', unit: 'libra', costCents: 3000, priceCents: 4000, taxed: false, minStock: 0 }, 1, w.owner.id);
    await createSale(w.db, { lines: [{ productId: p.id, quantity: 0.1 }], payment: 'cash', requestId: newId(), userId: w.owner.id });
    await createSale(w.db, { lines: [{ productId: p.id, quantity: 0.2 }], payment: 'cash', requestId: newId(), userId: w.owner.id });
    expect((await w.db.products.get(p.id))!.stock).toBe(0.7);
  });
});

describe('ventas de la tienda', () => {
  it('cobrar descuenta el inventario y numera el recibo', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const s1 = await createSale(w.db, { lines: [{ productId: p.id, quantity: 3 }], payment: 'cash', requestId: newId(), userId: w.employee.id });
    const s2 = await createSale(w.db, { lines: [{ productId: p.id, quantity: 1 }], payment: 'cash', requestId: newId(), userId: w.employee.id });
    expect(s1.totalCents).toBe(15000);
    expect([s1.number, s2.number]).toEqual([1, 2]);
    expect((await w.db.products.get(p.id))!.stock).toBe(6);
  });

  it('el doble toque (misma llave) no cobra ni descuenta dos veces', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const input = { lines: [{ productId: p.id, quantity: 2 }], payment: 'cash' as const, requestId: newId(), userId: w.owner.id };
    const [a, b] = await Promise.all([createSale(w.db, input), createSale(w.db, input)]);
    expect(a.id).toBe(b.id);
    expect(await w.db.sales.count()).toBe(1);
    expect((await w.db.products.get(p.id))!.stock).toBe(8);
  });

  it('si no alcanza la existencia no se hace nada de la venta', async () => {
    const w = await newWorld();
    const a = await addProduct(w, { name: 'Pan' }, 10);
    const b = await addProduct(w, { name: 'Leche' }, 1);
    await expect(
      createSale(w.db, { lines: [{ productId: a.id, quantity: 2 }, { productId: b.id, quantity: 5 }], payment: 'cash', requestId: newId(), userId: w.owner.id }),
    ).rejects.toThrow(/No hay suficiente "Leche"/);
    expect((await w.db.products.get(a.id))!.stock).toBe(10);
    expect(await w.db.sales.count()).toBe(0);
    expect((await getDeviceLocal(w.db)).nextSaleNumber).toBe(1);
  });

  it('cada equipo numera sus recibos con su letra (dos equipos sin internet no repiten número)', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    await w.db.local.put({ key: 'device', deviceId: 'equipo-b', series: 'B', nextSaleNumber: 7 });
    const sale = await createSale(w.db, { lines: [{ productId: p.id, quantity: 1 }], payment: 'cash', requestId: newId(), userId: w.owner.id });
    expect(receiptNumber(sale)).toBe('B-7');
    expect((await getDeviceLocal(w.db)).nextSaleNumber).toBe(8);
    expect(receiptNumber({ number: 3 })).toBe('3');
  });

  it('la existencia y lo que se debe se guardan como "suma/resta" (se juntan bien al sincronizar)', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const ana = await newClient(w.db, 'Ana');
    // Otro equipo vendió 3 mientras tanto (llegó por la sincronización): la venta de aquí resta encima, no lo pisa.
    await w.db.products.update(p.id, { stock: 7 });
    await createSale(w.db, { lines: [{ productId: p.id, quantity: 2 }], payment: 'credit', clientId: ana, requestId: newId(), userId: w.owner.id });
    expect((await w.db.products.get(p.id))!.stock).toBe(5);
    expect((await w.db.clients.get(ana))!.balanceCents).toBe(10000);
  });

  it('descuentos y el ITBIS incluido en el precio', async () => {
    const w = await newWorld();
    await saveSettings({ ...(await getSettings(w.db)), taxEnabled: true, taxRate: 18 }, w.db);
    const p = await addProduct(w, { priceCents: 11800, taxed: true }, 10);
    const sale = await createSale(w.db, { lines: [{ productId: p.id, quantity: 1 }], payment: 'card', requestId: newId(), userId: w.owner.id });
    expect(sale.totalCents).toBe(11800);
    expect(sale.taxCents).toBe(1800);
    const withDiscount = await createSale(w.db, {
      lines: [{ productId: p.id, quantity: 2, discountCents: 3600 }],
      discountCents: 10000,
      payment: 'cash',
      requestId: newId(),
      userId: w.owner.id,
    });
    expect(withDiscount.subtotalCents).toBe(20000);
    expect(withDiscount.totalCents).toBe(10000);
    await expect(
      createSale(w.db, { lines: [{ productId: p.id, quantity: 1 }], discountCents: 20000, payment: 'cash', requestId: newId(), userId: w.owner.id }),
    ).rejects.toThrow(/mayor que la venta/);
  });

  it('solo la dueña anula; la mercancía vuelve y el recibo queda marcado', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const sale = await createSale(w.db, { lines: [{ productId: p.id, quantity: 4 }], payment: 'cash', requestId: newId(), userId: w.employee.id });
    await expect(voidSale(w.db, sale.id, w.employee.id, 'error')).rejects.toThrow(/Solo la dueña/);
    const voided = await voidSale(w.db, sale.id, w.owner.id, 'se equivocó');
    expect(voided.status).toBe('void');
    expect((await w.db.products.get(p.id))!.stock).toBe(10);
    // Anular otra vez no devuelve la mercancía dos veces.
    await voidSale(w.db, sale.id, w.owner.id, 'otra vez');
    expect((await w.db.products.get(p.id))!.stock).toBe(10);
    expect((await w.db.audit.where('entity').equals('venta').toArray()).some(a => a.action === 'anular')).toBe(true);
  });

  it('devolución parcial: no se puede devolver más de lo vendido y resta de la venta', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const sale = await createSale(w.db, { lines: [{ productId: p.id, quantity: 3 }], payment: 'cash', requestId: newId(), userId: w.owner.id });
    await returnItems(w.db, sale.id, [{ productId: p.id, quantity: 2 }], w.owner.id, 'vino dañado');
    expect((await w.db.products.get(p.id))!.stock).toBe(9);
    await expect(returnItems(w.db, sale.id, [{ productId: p.id, quantity: 2 }], w.owner.id, 'otra')).rejects.toThrow(/más/);
    expect((await salesReport(w.db, today(), today())).salesCents).toBe(5000);
  });
});

describe('fiado', () => {
  it('fiar sube la deuda, abonar la baja, y no se abona más de lo que debe', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const ana = await newClient(w.db, 'Ana');
    await expect(createSale(w.db, { lines: [{ productId: p.id, quantity: 1 }], payment: 'credit', requestId: newId(), userId: w.owner.id })).rejects.toThrow(
      /escoger el cliente/,
    );
    await createSale(w.db, { lines: [{ productId: p.id, quantity: 2 }], payment: 'credit', clientId: ana, requestId: newId(), userId: w.owner.id });
    expect((await w.db.clients.get(ana))!.balanceCents).toBe(10000);
    await registerPayment(w.db, ana, 4000, w.owner.id);
    expect((await w.db.clients.get(ana))!.balanceCents).toBe(6000);
    await expect(registerPayment(w.db, ana, 7000, w.owner.id)).rejects.toThrow(/solo debe/);
  });

  it('respeta el límite de fiado', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const luis = await newClient(w.db, 'Luis', 8000);
    await expect(
      createSale(w.db, { lines: [{ productId: p.id, quantity: 2 }], payment: 'credit', clientId: luis, requestId: newId(), userId: w.owner.id }),
    ).rejects.toThrow(/límite/);
    expect((await w.db.products.get(p.id))!.stock).toBe(10);
  });

  it('anular o devolver una venta fiada le baja la deuda', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const ana = await newClient(w.db, 'Ana');
    const s1 = await createSale(w.db, { lines: [{ productId: p.id, quantity: 2 }], payment: 'credit', clientId: ana, requestId: newId(), userId: w.owner.id });
    const s2 = await createSale(w.db, { lines: [{ productId: p.id, quantity: 2 }], payment: 'credit', clientId: ana, requestId: newId(), userId: w.owner.id });
    await voidSale(w.db, s1.id, w.owner.id, 'error');
    await returnItems(w.db, s2.id, [{ productId: p.id, quantity: 1 }], w.owner.id, 'devolvió uno');
    expect((await w.db.clients.get(ana))!.balanceCents).toBe(5000);
  });

  it('no deja dos clientes con el mismo nombre (aunque cambien mayúsculas o acentos)', async () => {
    const w = await newWorld();
    await createClient(w.db, { name: 'José Pérez', phone: '809-555-1234' }, w.owner.id);
    await expect(createClient(w.db, { name: 'jose perez' }, w.owner.id)).rejects.toThrow(/Ya hay un cliente/);
    expect((await w.db.clients.toArray())[0].phone).toBe('8095551234');
  });

  it('deuda a mano y abono con fecha del mes pasado; corregir y anular; la cuenta va por fecha', async () => {
    const w = await newWorld();
    const rosa = await newClient(w.db, 'Rosa');
    const lastMonth = dayKeyOf(new Date(Date.now() - 35 * 24 * 60 * 60 * 1000));
    const lastWeek = dayKeyOf(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    await addCharge(w.db, rosa, 50000, w.owner.id, 'Lo que debía en la libreta', lastMonth);
    const payment = await registerPayment(w.db, rosa, 20000, w.owner.id, undefined, lastWeek);
    expect((await w.db.clients.get(rosa))!.balanceCents).toBe(30000);
    // Se anota hoy un abono, y DESPUÉS uno con fecha anterior: la cuenta los pone en orden de fecha.
    await registerPayment(w.db, rosa, 5000, w.owner.id);
    await registerPayment(w.db, rosa, 1000, w.owner.id, 'de ayer', dayKeyOf(new Date(Date.now() - 24 * 60 * 60 * 1000)));
    let account = await clientAccount(w.db, rosa);
    expect(account.map(a => a.runningCents)).toEqual([50000, 30000, 29000, 24000]);

    // El abono de la semana pasada era de 250, no de 200.
    await updateCreditEntry(w.db, payment.id, { amountCents: 25000, dayKey: lastWeek }, w.owner.id);
    expect((await w.db.clients.get(rosa))!.balanceCents).toBe(19000);
    // El de ayer no era de ella: se anula.
    const wrong = account[2];
    await voidCreditEntry(w.db, wrong.id, w.owner.id, 'era de otra persona');
    expect((await w.db.clients.get(rosa))!.balanceCents).toBe(20000);
    account = await clientAccount(w.db, rosa);
    expect(account.map(a => a.runningCents)).toEqual([50000, 25000, 25000, 20000]);
    // No se puede dejar debiendo menos de cero ni anotar en el futuro.
    await expect(updateCreditEntry(w.db, payment.id, { amountCents: 90000 }, w.owner.id)).rejects.toThrow(/menos de cero/);
    await expect(registerPayment(w.db, rosa, 100, w.owner.id, undefined, dayKeyOf(new Date(Date.now() + 48 * 60 * 60 * 1000)))).rejects.toThrow(
      /no ha llegado/,
    );
  });

  it('el fiado que viene de una venta o jugada se corrige desde Ventas o Lotería, no en la cuenta', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    const ana = await newClient(w.db, 'Ana');
    await createSale(w.db, { lines: [{ productId: p.id, quantity: 1 }], payment: 'credit', clientId: ana, requestId: newId(), userId: w.owner.id });
    await addLotterySale(w.db, { amountCents: 2000, clientId: ana, credit: true, userId: w.owner.id, requestId: newId() });
    const [fromSale, fromLottery] = await clientAccount(w.db, ana);
    await expect(updateCreditEntry(w.db, fromSale.id, { amountCents: 1 }, w.owner.id)).rejects.toThrow(/Ventas/);
    await expect(voidCreditEntry(w.db, fromLottery.id, w.owner.id, 'x')).rejects.toThrow(/Lotería/);
  });
});

describe('lotería (el cuadre del día)', () => {
  const play = (w: Awaited<ReturnType<typeof newWorld>>, amountCents: number, clientName: string, extra: { clientId?: string; credit?: boolean } = {}) =>
    addLotterySale(w.db, { amountCents, clientName, ...extra, userId: w.employee.id, requestId: newId() });
  const prize = (w: Awaited<ReturnType<typeof newWorld>>, amountCents: number, clientName: string) =>
    addPrize(w.db, { amountCents, clientName, userId: w.employee.id, requestId: newId() });

  it('como la libreta: clientes, veces que jugaron y cobraron, venta, comisión, premios y lo que se entrega', async () => {
    const w = await newWorld();
    await saveSettings({ ...(await getSettings(w.db)), commissionPct: 10 }, w.db);
    await play(w, 40000, 'Ana');
    await play(w, 30000, 'Pedro');
    await play(w, 30000, 'pedro ');
    await prize(w, 15000, 'Ana');
    await prize(w, 5000, 'Ana');
    const wrong = await prize(w, 99900, 'Pedro');
    await voidPrize(w.db, wrong.id, w.owner.id, 'mal anotado');

    const day = await computeDay(w.db, today());
    expect(day.totals).toEqual({
      salesCount: 3,
      salesCents: 100000, // RD$ 1,000
      commissionPct: 10,
      commissionCents: 10000, // RD$ 100 (lo que gana ella)
      prizesCount: 2,
      prizesCents: 20000, // RD$ 200
      deliverCents: 70000, // 1,000 - 100 - 200 = RD$ 700
    });
    expect(day.clients).toEqual([
      { name: 'Ana', purchases: 1, purchasesCents: 40000, prizes: 2, prizesCents: 20000 },
      { name: 'Pedro', purchases: 2, purchasesCents: 60000, prizes: 0, prizesCents: 0 },
    ]);
  });

  it('el doble toque no anota la jugada dos veces', async () => {
    const w = await newWorld();
    const input = { amountCents: 5000, clientName: 'Ana', userId: w.owner.id, requestId: newId() };
    await Promise.all([addLotterySale(w.db, input), addLotterySale(w.db, input)]);
    expect(await w.db.lottery.count()).toBe(1);
  });

  it('lotería fiada va a la cuenta del cliente, y al anularla se quita', async () => {
    const w = await newWorld();
    const ana = await newClient(w.db, 'Ana');
    await expect(play(w, 5000, 'Luis', { credit: true })).rejects.toThrow(/escoger el cliente/);
    const entry = await play(w, 5000, '', { clientId: ana, credit: true });
    expect(entry.clientName).toBe('Ana');
    expect((await w.db.clients.get(ana))!.balanceCents).toBe(5000);
    expect((await computeDay(w.db, today())).creditCents).toBe(5000);
    await voidLotterySale(w.db, entry.id, w.owner.id, 'se arrepintió');
    expect((await w.db.clients.get(ana))!.balanceCents).toBe(0);
    expect((await computeDay(w.db, today())).totals.salesCents).toBe(0);
  });

  it('al cerrar el día no se anota ni se paga premio; la dueña lo puede reabrir; la tienda sigue vendiendo', async () => {
    const w = await newWorld();
    const p = await addProduct(w, {}, 10);
    await play(w, 5000, 'Ana');
    await expect(closeDay(w.db, today(), w.employee.id)).rejects.toThrow(/Solo la dueña/);
    const closed = await closeDay(w.db, today(), w.owner.id);
    expect(closed.totals?.salesCents).toBe(5000);
    await expect(play(w, 5000, 'Ana')).rejects.toThrow(/ya se cerró/);
    await expect(prize(w, 100, 'Ana')).rejects.toThrow(/ya se cerró/);
    await createSale(w.db, { lines: [{ productId: p.id, quantity: 1 }], payment: 'cash', requestId: newId(), userId: w.owner.id });
    await reopenDay(w.db, today(), w.owner.id, 'faltó una jugada');
    await play(w, 5000, 'Ana');
    expect((await computeDay(w.db, today())).totals.salesCents).toBe(10000);
  });

  it('el reporte de varios días usa la comisión de cada día', async () => {
    const w = await newWorld();
    await play(w, 100000, 'Ana');
    await prize(w, 20000, 'Ana');
    const report = await lotteryReport(w.db, '2000-01-01', today());
    expect(report.totals).toMatchObject({ salesCents: 100000, commissionCents: 10000, prizesCents: 20000, deliverCents: 70000 });
    expect(report.days).toHaveLength(1);
  });

  it('si los premios pasan la venta, lo que se entrega queda en negativo (faltante)', async () => {
    const w = await newWorld();
    await saveSettings({ ...(await getSettings(w.db)), commissionPct: 20 }, w.db);
    await play(w, 10000, 'Ana'); // vendió 100
    await prize(w, 12000, 'Ana'); // se sacó 120
    const t = (await computeDay(w.db, today())).totals;
    // 100 - 20 de comisión - 120 de premio = -40
    expect(t).toMatchObject({ salesCents: 10000, commissionCents: 2000, prizesCents: 12000, deliverCents: -4000 });
  });

  it('editar un premio o una jugada recalcula el cuadre solo; la jugada fiada ajusta la deuda', async () => {
    const w = await newWorld();
    const ana = await newClient(w.db, 'Ana');
    await play(w, 3000, 'Luis');
    const fiada = await play(w, 2000, '', { clientId: ana, credit: true });
    const p1 = await prize(w, 1000, 'Luis');
    await prize(w, 1500, 'Pedro');
    await prize(w, 2500, 'Juana');
    expect((await computeDay(w.db, today())).totals).toMatchObject({ prizesCount: 3, prizesCents: 5000 });

    await updatePrize(w.db, p1.id, { clientName: 'Luis', amountCents: 2000 }, w.owner.id);
    await updateLotterySale(w.db, fiada.id, { clientId: ana, amountCents: 3500 }, w.owner.id);
    const day = await computeDay(w.db, today());
    expect(day.totals).toMatchObject({ salesCents: 6500, prizesCount: 3, prizesCents: 6000 });
    expect(day.totals.deliverCents).toBe(6500 - 650 - 6000);
    expect((await w.db.clients.get(ana))!.balanceCents).toBe(3500);
    await expect(updateLotterySale(w.db, fiada.id, { clientName: 'Otra', amountCents: 3500 }, w.owner.id)).rejects.toThrow(/anúlala/);
  });

  it('se puede volver a un día anterior abierto a anotar lo que faltó (no a uno cerrado ni a uno futuro)', async () => {
    const w = await newWorld();
    const monday = dayKeyOf(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const tomorrow = dayKeyOf(new Date(Date.now() + 24 * 60 * 60 * 1000));
    await addLotterySale(w.db, { amountCents: 5000, clientName: 'Ana', userId: w.owner.id, requestId: newId(), dayKey: monday });
    await addPrize(w.db, { amountCents: 2000, clientName: 'Ana', userId: w.owner.id, requestId: newId(), dayKey: monday });
    expect((await computeDay(w.db, monday)).totals).toMatchObject({ salesCents: 5000, prizesCents: 2000 });
    expect((await computeDay(w.db, today())).totals.salesCents).toBe(0);
    await expect(addLotterySale(w.db, { amountCents: 100, clientName: 'Ana', userId: w.owner.id, requestId: newId(), dayKey: tomorrow })).rejects.toThrow(
      /todavía no ha llegado/,
    );
    await closeDay(w.db, monday, w.owner.id);
    await expect(addLotterySale(w.db, { amountCents: 100, clientName: 'Ana', userId: w.owner.id, requestId: newId(), dayKey: monday })).rejects.toThrow(
      /ya se cerró/,
    );
    await reopenDay(w.db, monday, w.owner.id, 'faltó una jugada');
    await addLotterySale(w.db, { amountCents: 100, clientName: 'Ana', userId: w.owner.id, requestId: newId(), dayKey: monday });
    expect((await computeDay(w.db, monday)).totals.salesCents).toBe(5100);
  });
});

describe('actualizar la app', () => {
  it('lo que ya estaba guardado con la versión 1 (índices únicos) pasa intacto a la versión 2', async () => {
    const name = `vieja-${newId()}`;
    const old = new Dexie(name);
    old.version(1).stores({ users: 'id, name, role', products: 'id, &sku, &barcode, name, categoryId, supplierId, active, stock', settings: 'key' });
    await old.table('products').add({ id: 'p1', sku: 'P0001', barcode: '746', name: 'Pan', stock: 4, active: true });
    await old.table('settings').put({ key: 'main', businessName: 'Colmado', nextSaleNumber: 9 });
    old.close();

    const upgraded = new MartinaDb(name);
    expect(await upgraded.products.get('p1')).toMatchObject({ name: 'Pan', stock: 4 });
    expect((await getSettings(upgraded)).businessName).toBe('Colmado');
    // Ya no hay índice único: una copia que llegue de otro equipo con el mismo código no rompe la sincronización.
    await upgraded.products.add({ id: 'p2', sku: 'P0001', barcode: '746', name: 'Pan (otro equipo)', stock: 1, active: true } as never);
    expect(await upgraded.products.where('barcode').equals('746').count()).toBe(2);
    expect(await upgraded.local.count()).toBe(0);
  });
});

describe('usuarios, reportes y respaldo', () => {
  it('el PIN no se guarda tal cual y se comprueba bien', async () => {
    const w = await newWorld();
    expect(w.owner.pinHash).not.toContain('1234');
    expect(await verifyPin(w.owner, '1234')).toBe(true);
    expect(await verifyPin(w.owner, '4321')).toBe(false);
    expect((await ownerByPin(w.db, '1234'))?.id).toBe(w.owner.id);
    expect(await ownerByPin(w.db, '5678')).toBeUndefined();
  });

  it('reporte del período y alertas de existencia', async () => {
    const w = await newWorld();
    const pan = await addProduct(w, { name: 'Pan', costCents: 500, priceCents: 1000, minStock: 5 }, 6);
    await addProduct(w, { name: 'Leche', minStock: 1 }, 0);
    await addProduct(w, { name: 'Arroz', minStock: 2 }, 50);
    const sale = await createSale(w.db, { lines: [{ productId: pan.id, quantity: 4 }], payment: 'cash', requestId: newId(), userId: w.owner.id });
    await returnItems(w.db, sale.id, [{ productId: pan.id, quantity: 1 }], w.owner.id, 'devolvió');
    const report = await salesReport(w.db, today(), today());
    expect(report).toMatchObject({ salesCount: 1, salesCents: 3000, costCents: 1500, profitCents: 1500 });
    expect(report.top[0]).toMatchObject({ name: 'Pan', quantity: 3 });
    const alerts = await stockAlerts(w.db);
    expect(alerts.out.map(p => p.name)).toEqual(['Leche']);
    expect(alerts.low.map(p => p.name)).toEqual(['Pan']);
  });

  it('el respaldo guarda todo (con fotos y lotería) y se recupera igual', async () => {
    const w = await newWorld();
    const photo = new Blob([new Uint8Array([1, 2, 3, 250])], { type: 'image/jpeg' });
    const p = await addProduct(w, { photo }, 8);
    await createSale(w.db, { lines: [{ productId: p.id, quantity: 2 }], payment: 'cash', requestId: newId(), userId: w.owner.id });
    await addLotterySale(w.db, { amountCents: 5000, clientName: 'Ana', userId: w.owner.id, requestId: newId() });
    const file = await exportBackup(w.db);

    const other = await newWorld();
    await expect(importBackup(other.db, '{"hola":1}')).rejects.toThrow(/no es un respaldo/);
    const result = await importBackup(other.db, file);
    expect(result).toEqual({ products: 1, sales: 1 });
    const restored = await other.db.products.get(p.id);
    expect(restored?.stock).toBe(6);
    expect(restored?.photo).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await restored!.photo!.arrayBuffer())]).toEqual([1, 2, 3, 250]);
    expect(await other.db.users.count()).toBe(2);
    expect(await other.db.lottery.count()).toBe(1);
    expect(await verifyPin((await other.db.users.get(w.owner.id))!, '1234')).toBe(true);
  });
});
