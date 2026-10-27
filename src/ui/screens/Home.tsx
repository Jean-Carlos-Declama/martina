import { useLiveQuery } from 'dexie-react-hooks';
import type { Screen } from '../../App';
import { isLinked } from '../../db/cloud';
import { db } from '../../db/database';
import { dayKeyOf } from '../../domain/common';
import { computeDay } from '../../domain/lottery';
import { salesReport, stockAlerts } from '../../domain/reports';
import { useSession } from '../context';
import { dayLabel, formatQty, plural } from '../format';
import { Icon } from '../icons';
import { Stat } from '../kit';
import { SyncBadge } from './Devices';

const WEEK = 7 * 24 * 60 * 60 * 1000;

export function Home({ go }: { go: (screen: Screen) => void }) {
  const { user, isOwner, canEdit, seesMoney, money, settings } = useSession();
  const today = dayKeyOf();
  const lottery = useLiveQuery(() => computeDay(db, today), [today]);
  const store = useLiveQuery(() => salesReport(db, today, today, 5), [today]);
  const alerts = useLiveQuery(() => stockAlerts(db), []);
  const debt = useLiveQuery(async () => {
    const clients = await db.clients.filter(c => c.balanceCents > 0).toArray();
    return { count: clients.length, cents: clients.reduce((sum, c) => sum + c.balanceCents, 0) };
  }, []);
  // Vinculado, la nube ya guarda copia: el aviso de respaldo es para cuando todo vive solo en este equipo.
  const backupOld = !isLinked() && (!settings.lastBackupAt || Date.now() - Date.parse(settings.lastBackupAt) > WEEK);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Hola, {user.name}</h1>
          <p className="muted">{dayLabel(today)}</p>
          <SyncBadge />
        </div>
        {canEdit && (
          <div className="actions">
            <button className="btn primary" onClick={() => go('lottery')}>
              <Icon name="ticket" /> Anotar lotería
            </button>
            <button className="btn primary" onClick={() => go('sell')}>
              <Icon name="cart" /> Vender
            </button>
          </div>
        )}
      </header>

      {isOwner && backupOld && (
        <button className="notice warn" onClick={() => go('settings')}>
          <Icon name="alert" />
          <span>
            {settings.lastBackupAt ? 'Hace más de una semana que no se hace un respaldo.' : 'Todavía no se ha hecho ningún respaldo.'} Los datos viven solo en
            este iPad: toca aquí para guardar una copia.
          </span>
        </button>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Lotería de hoy</h2>
          {lottery?.status === 'closed' && <span className="badge">Cerrada</span>}
          <button className="btn small" onClick={() => go('lottery')}>
            Ver cuadre <Icon name="next" size={18} />
          </button>
        </div>
        {lottery && (
          <div className="stats">
            <Stat label="Venta" value={money(lottery.totals.salesCents)} sub={plural(lottery.totals.salesCount, 'jugada', 'jugadas')} />
            <Stat label={`Comisión ${lottery.totals.commissionPct}%`} value={money(lottery.totals.commissionCents)} tone="good" sub="lo que te ganas" />
            <Stat label="Premios" value={money(lottery.totals.prizesCents)} tone="bad" sub={plural(lottery.totals.prizesCount, 'pagado', 'pagados')} />
            <Stat label="A entregar" value={money(lottery.totals.deliverCents)} tone="accent" big />
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Tienda hoy</h2>
          <button className="btn small" onClick={() => go('sales')}>
            Ver ventas <Icon name="next" size={18} />
          </button>
        </div>
        {store && (
          <div className="stats">
            <Stat label="Vendido" value={money(store.salesCents)} sub={plural(store.salesCount, 'venta', 'ventas')} />
            {seesMoney && <Stat label="Ganancia" value={money(store.profitCents)} tone="good" />}
            {debt && <Stat label="Fiado por cobrar" value={money(debt.cents)} sub={plural(debt.count, 'cliente', 'clientes')} tone={debt.cents > 0 ? 'bad' : 'plain'} />}
          </div>
        )}
        {store && store.top.length > 0 && (
          <p className="muted small-text">Lo más vendido hoy: {store.top.map(t => `${t.name} (${formatQty(t.quantity)})`).join(', ')}</p>
        )}
      </section>

      {alerts && (alerts.out.length > 0 || alerts.low.length > 0) && (
        <section className="card">
          <div className="card-head">
            <h2>Hay que reponer</h2>
            <button className="btn small" onClick={() => go('products')}>
              Ver productos <Icon name="next" size={18} />
            </button>
          </div>
          <ul className="chips">
            {alerts.out.slice(0, 12).map(p => (
              <li key={p.id} className="chip bad">
                {p.name}: agotado
              </li>
            ))}
            {alerts.low.slice(0, 12).map(p => (
              <li key={p.id} className="chip warn">
                {p.name}: quedan {formatQty(p.stock)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
