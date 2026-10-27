import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../../db/database';
import { dayKeyOf } from '../../domain/common';
import { lotteryReport } from '../../domain/lottery';
import { inventorySummary, periodOf, salesReport } from '../../domain/reports';
import { useSession } from '../context';
import { dayLabel, formatQty, plural, shiftDay } from '../format';
import { Empty, Segmented, Stat } from '../kit';

type Period = 'today' | 'week' | 'month' | 'custom';

export default function Reports() {
  const { money } = useSession();
  const [period, setPeriod] = useState<Period>('week');
  const [custom, setCustom] = useState({ from: shiftDay(dayKeyOf(), -30), to: dayKeyOf() });
  const range = period === 'custom' ? custom : periodOf(period);
  const store = useLiveQuery(() => salesReport(db, range.from, range.to, 15), [range.from, range.to]);
  const lottery = useLiveQuery(() => lotteryReport(db, range.from, range.to), [range.from, range.to]);
  const inventory = useLiveQuery(() => inventorySummary(db), []);
  const debtors = useLiveQuery(() => db.clients.filter(c => c.balanceCents > 0).toArray(), []);
  const margin = store && store.salesCents > 0 ? Math.round((store.profitCents / store.salesCents) * 100) : null;
  const maxDay = Math.max(1, ...(store?.days.map(d => d.salesCents) ?? []));

  return (
    <div className="page">
      <header className="page-head">
        <h1>Reportes</h1>
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[
            { value: 'today', label: 'Hoy' },
            { value: 'week', label: 'Esta semana' },
            { value: 'month', label: 'Este mes' },
            { value: 'custom', label: 'Otras fechas' },
          ]}
        />
      </header>
      {period === 'custom' && (
        <div className="toolbar">
          <label className="field inline">
            Desde <input type="date" value={custom.from} max={custom.to} onChange={e => e.target.value && setCustom(c => ({ ...c, from: e.target.value }))} />
          </label>
          <label className="field inline">
            Hasta <input type="date" value={custom.to} min={custom.from} onChange={e => e.target.value && setCustom(c => ({ ...c, to: e.target.value }))} />
          </label>
        </div>
      )}

      <section className="card">
        <h2>Lotería</h2>
        {lottery && lottery.days.length > 0 ? (
          <>
            <div className="stats">
              <Stat label="Venta" value={money(lottery.totals.salesCents)} sub={plural(lottery.totals.salesCount, 'jugada', 'jugadas')} />
              <Stat label="Comisión ganada" value={money(lottery.totals.commissionCents)} tone="good" big />
              <Stat label="Premios" value={money(lottery.totals.prizesCents)} tone="bad" sub={plural(lottery.totals.prizesCount, 'pagado', 'pagados')} />
              <Stat label="A entregar" value={money(lottery.totals.deliverCents)} tone="accent" />
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Día</th>
                    <th className="num">Venta</th>
                    <th className="num">Comisión</th>
                    <th className="num">Premios</th>
                    <th className="num">A entregar</th>
                  </tr>
                </thead>
                <tbody>
                  {lottery.days.map(d => (
                    <tr key={d.dayKey}>
                      <td>
                        {dayLabel(d.dayKey, false)} {d.status === 'open' && <small className="warn-text">(abierto)</small>}
                      </td>
                      <td className="num">{money(d.totals.salesCents)}</td>
                      <td className="num good-text">
                        {money(d.totals.commissionCents)} <small className="muted">{d.totals.commissionPct}%</small>
                      </td>
                      <td className="num bad-text">{money(d.totals.prizesCents)}</td>
                      <td className="num">{money(d.totals.deliverCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <Empty icon="ticket" text="No hay lotería anotada en estas fechas." />
        )}
      </section>

      <section className="card">
        <h2>Tienda</h2>
        {store && store.salesCount > 0 ? (
          <>
            <div className="stats">
              <Stat label="Vendido" value={money(store.salesCents)} sub={plural(store.salesCount, 'venta', 'ventas')} />
              <Stat label="Costo de lo vendido" value={money(store.costCents)} />
              <Stat label="Ganancia" value={money(store.profitCents)} tone="good" big sub={margin !== null ? `${margin}% de lo vendido` : undefined} />
            </div>
            {store.days.length > 1 && (
              <div className="bars" role="table" aria-label="Venta de cada día">
                {store.days.map(d => (
                  <div className="bar-row" role="row" key={d.dayKey}>
                    <span role="cell">{dayLabel(d.dayKey, false)}</span>
                    <span role="cell" className="bar-track">
                      <span className="bar" style={{ width: `${Math.max(1, (d.salesCents / maxDay) * 100)}%` }} />
                    </span>
                    <span role="cell" className="num">
                      {money(d.salesCents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <h3>Lo que más se vende</h3>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th className="num">Cantidad</th>
                    <th className="num">Vendido</th>
                    <th className="num">Ganancia</th>
                  </tr>
                </thead>
                <tbody>
                  {store.top.map(p => (
                    <tr key={p.productId}>
                      <td>{p.name}</td>
                      <td className="num">{formatQty(p.quantity)}</td>
                      <td className="num">{money(p.revenueCents)}</td>
                      <td className="num good-text">{money(p.profitCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <Empty icon="cart" text="No hubo ventas de la tienda en estas fechas." />
        )}
      </section>

      <div className="two-cols">
        {inventory && (
          <section className="card">
            <h2>Inventario ahora</h2>
            <div className="stats">
              <Stat label="Productos" value={String(inventory.products)} sub={`${formatQty(inventory.units)} unidades`} />
              <Stat label="Vale (al costo)" value={money(inventory.valueAtCostCents)} />
              <Stat label="Vale (al precio)" value={money(inventory.valueAtPriceCents)} />
            </div>
          </section>
        )}
        <section className="card">
          <h2>Quién debe más</h2>
          {debtors && debtors.length > 0 ? (
            <ul className="list">
              {debtors
                .sort((a, b) => b.balanceCents - a.balanceCents)
                .slice(0, 10)
                .map(c => (
                  <li key={c.id}>
                    <span className="grow">{c.name}</span>
                    <span className="amount bad-text">{money(c.balanceCents)}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">Nadie debe. 🎉</p>
          )}
        </section>
      </div>
    </div>
  );
}
