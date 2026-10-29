import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../../db/database';
import type { Sale } from '../../db/types';
import { dayKeyOf } from '../../domain/common';
import { receiptNumber, refundOf, refundsBetween, returnItems, voidSale } from '../../domain/sales';
import { useSession, useUi } from '../context';
import { dayLabel, formatQty, formatTime, parseQty, PAYMENT_LABELS, plural, shiftDay } from '../format';
import { Icon } from '../icons';
import { Empty, Modal, Stat } from '../kit';
import { ReceiptModal } from './Sell';

export default function SalesHistory() {
  const { money } = useSession();
  const today = dayKeyOf();
  const [dayKey, setDayKey] = useState(today);
  const [viewing, setViewing] = useState<string | null>(null);
  const sales = useLiveQuery(() => db.sales.where('dayKey').equals(dayKey).reverse().sortBy('number'), [dayKey]);
  const done = (sales ?? []).filter(s => s.status === 'done');
  const total = done.reduce((sum, s) => sum + s.totalCents, 0);
  const byPayment = done.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.payment]: (acc[s.payment] ?? 0) + s.totalCents }), {});
  // Lo devuelto este día se resta de lo vendido (igual que en Reportes).
  const refunds = useLiveQuery(() => refundsBetween(db, dayKey, dayKey), [dayKey]);
  const refunded = (refunds ?? []).reduce((sum, r) => sum + r.amountCents, 0);
  const sale = sales?.find(s => s.id === viewing);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Ventas de la tienda</h1>
          <div className="day-nav">
            <button className="icon-btn" onClick={() => setDayKey(shiftDay(dayKey, -1))} aria-label="Día anterior">
              <Icon name="back" />
            </button>
            <span className="day-label">{dayLabel(dayKey, dayKey.slice(0, 4) !== today.slice(0, 4))}</span>
            <button className="icon-btn" onClick={() => setDayKey(shiftDay(dayKey, 1))} disabled={dayKey === today} aria-label="Día siguiente">
              <Icon name="next" />
            </button>
            {dayKey !== today && (
              <button className="btn small" onClick={() => setDayKey(today)}>
                Hoy
              </button>
            )}
          </div>
        </div>
      </header>
      <div className="stats">
        <Stat label="Vendido" value={money(total - refunded)} sub={`${plural(done.length, 'venta', 'ventas')}${refunded > 0 ? ' · menos lo devuelto' : ''}`} big />
        {refunded > 0 && <Stat label="Devuelto" value={`−${money(refunded)}`} tone="bad" />}
        {Object.entries(byPayment).map(([payment, cents]) => (
          <Stat key={payment} label={PAYMENT_LABELS[payment as Sale['payment']]} value={money(cents)} />
        ))}
      </div>
      {sales && sales.length === 0 ? (
        <Empty icon="receipt" text="No hubo ventas este día." />
      ) : (
        <ul className="list card sales-list">
          {sales?.map(s => (
            <li key={s.id} className={s.status === 'void' ? 'voided' : ''}>
              <button className="row-button" onClick={() => setViewing(s.id)}>
                <span className="tag">#{receiptNumber(s)}</span>
                <span className="grow">
                  <strong>{s.clientName ?? 'Cliente general'}</strong>
                  <small className="muted">
                    {formatTime(s.date)}
                    {s.payment !== 'credit' ? ` · ${PAYMENT_LABELS[s.payment]}` : ''} · {plural(s.lines.length, 'producto', 'productos')}
                    {s.status === 'void' ? ' · ANULADA' : ''}
                  </small>
                </span>
                <span className="right">
                  <span className={`amount ${s.payment === 'credit' ? 'bad-text' : ''}`}>{money(s.totalCents)}</span>
                  {s.payment === 'credit' && <span className="tag out">Fiado</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {sale && <SaleDetail sale={sale} onClose={() => setViewing(null)} />}
    </div>
  );
}

function SaleDetail({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const { requireOwner, canEdit } = useSession();
  const { run, askText, confirm } = useUi();
  const { money } = useSession();
  const [returning, setReturning] = useState<string | null>(null);
  const users = useLiveQuery(async () => new Map((await db.users.toArray()).map(u => [u.id, u.name])), []);
  // Lo que ya se devolvió de esta venta (con "Devolver productos").
  const returned = useLiveQuery(() => db.movements.where('docId').equals(sale.id).filter(m => m.type === 'customerReturn').toArray(), [sale.id]);
  const refundedCents = (returned ?? []).reduce((sum, m) => {
    const line = sale.lines.find(l => l.productId === m.productId);
    return line ? sum + refundOf(sale, line, m.quantity) : sum;
  }, 0);

  const cancel = async () => {
    const owner = await requireOwner('Anular venta: autorización de la dueña');
    if (!owner) return;
    const reason = await askText({
      title: `Anular venta #${receiptNumber(sale)}`,
      message: returned?.length
        ? 'Ya se devolvió parte: solo se anula lo que falta. Esa mercancía vuelve al inventario y, si era fiada, se le quita al cliente.'
        : 'La mercancía vuelve al inventario y, si era fiada, se le quita al cliente.',
      label: '¿Por qué se anula?',
      okText: 'Anular',
      danger: true,
    });
    if (reason && (await confirm({ title: '¿Seguro?', message: 'Una venta anulada no se puede recuperar.', okText: 'Sí, anular', danger: true })))
      await run(() => voidSale(db, sale.id, owner.id, reason), 'Venta anulada');
  };

  const startReturn = async () => {
    const owner = await requireOwner('Devolución: autorización de la dueña');
    if (owner) setReturning(owner.id);
  };

  return (
    <ReceiptModal sale={sale} onClose={onClose}>
      {returned && returned.length > 0 && (
        <p className="warn-text small-text">
          Devuelto: {returned.map(m => `${formatQty(m.quantity)} × ${sale.lines.find(l => l.productId === m.productId)?.name ?? ''}`).join(', ')} (−{money(refundedCents)})
        </p>
      )}
      <p className="muted small-text">
        Cobró: {users?.get(sale.userId) ?? '—'}
        {sale.status === 'void' && ` · Anulada: ${sale.voidReason ?? ''}`}
      </p>
      {sale.status === 'done' && canEdit && (
        <div className="actions wrap">
          <button className="btn" onClick={() => void startReturn()}>
            Devolver productos
          </button>
          <button className="btn danger" onClick={() => void cancel()}>
            <Icon name="trash" /> Anular venta
          </button>
        </div>
      )}
      {returning && <ReturnModal sale={sale} ownerId={returning} onClose={() => setReturning(null)} />}
    </ReceiptModal>
  );
}

function ReturnModal({ sale, ownerId, onClose }: { sale: Sale; ownerId: string; onClose: () => void }) {
  const { run } = useUi();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const items = sale.lines.flatMap(line => {
    const qty = parseQty(quantities[line.productId] ?? '');
    return qty ? [{ productId: line.productId, quantity: qty }] : [];
  });

  return (
    <Modal
      title={`Devolución de la venta #${receiptNumber(sale)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn primary"
            disabled={items.length === 0 || !reason.trim()}
            onClick={async () => {
              if (await run(async () => (await returnItems(db, sale.id, items, ownerId, reason), true), 'Devolución registrada')) onClose();
            }}
          >
            Registrar devolución
          </button>
        </>
      }
    >
      <p className="muted">Escribe cuántos devuelve de cada uno. La mercancía vuelve al inventario y el dinero se descuenta de la venta de hoy.</p>
      <ul className="list">
        {sale.lines.map(line => (
          <li key={line.productId}>
            <span className="grow">
              {line.name} <small className="muted">(se vendieron {formatQty(line.quantity)})</small>
            </span>
            <input
              className="qty-input"
              inputMode="decimal"
              placeholder="0"
              value={quantities[line.productId] ?? ''}
              onChange={e => setQuantities(q => ({ ...q, [line.productId]: e.target.value }))}
            />
          </li>
        ))}
      </ul>
      <div className="field">
        <label htmlFor="return-reason">Motivo</label>
        <input id="return-reason" value={reason} onChange={e => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}
