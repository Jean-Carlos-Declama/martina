import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db } from '../../db/database';
import type { Client } from '../../db/types';
import { dayKeyOf, newId } from '../../domain/common';
import { addLotterySale, addPrize, closeDay, computeDay, reopenDay, setDayCommission, voidLotterySale, voidPrize } from '../../domain/lottery';
import { normalize } from '../../domain/products';
import { useSession, useUi } from '../context';
import { dayLabel, formatTime, parseMoney, plural, shiftDay } from '../format';
import { Icon } from '../icons';
import { Empty, Field, MoneyInput, Segmented, Stat } from '../kit';
import { lotteryDayText, openWhatsApp, shareText } from '../share';

const QUICK_AMOUNTS = [25, 50, 100, 200, 500];

/** La libreta de la lotería: anotar jugadas y premios, y el cuadre del día. */
export function Lottery() {
  const { money, settings, isOwner, canEdit, user, requireOwner } = useSession();
  const { run, confirm, askText } = useUi();
  const today = dayKeyOf();
  const [dayKey, setDayKey] = useState(today);
  const report = useLiveQuery(() => computeDay(db, dayKey), [dayKey]);
  const entries = useLiveQuery(async () => {
    const plays = (await db.lottery.where('dayKey').equals(dayKey).toArray()).map(e => ({ ...e, kind: 'play' as const }));
    const prizes = (await db.prizes.where('dayKey').equals(dayKey).toArray()).map(p => ({ ...p, kind: 'prize' as const, credit: false }));
    return [...plays, ...prizes].sort((a, b) => b.date.localeCompare(a.date));
  }, [dayKey]);

  const isToday = dayKey === today;
  const open = report?.status !== 'closed';
  // "Solo mirar" ve el cuadre pero no anota, no anula ni cierra.
  const editable = open && canEdit;
  const t = report?.totals;

  const voidEntry = async (entry: NonNullable<typeof entries>[number]) => {
    const owner = await requireOwner('Anular: autorización de la dueña');
    if (!owner) return;
    const reason = await askText({
      title: entry.kind === 'play' ? 'Anular jugada' : 'Anular premio',
      message: `${entry.clientName}: ${money(entry.amountCents)}`,
      label: '¿Por qué se anula?',
      okText: 'Anular',
      danger: true,
    });
    if (!reason) return;
    await run(() => (entry.kind === 'play' ? voidLotterySale(db, entry.id, owner.id, reason) : voidPrize(db, entry.id, owner.id, reason)), 'Anulado');
  };

  const close = async () => {
    if (!report) return;
    const owner = await requireOwner('Cerrar el día: autorización de la dueña');
    if (!owner) return;
    const ok = await confirm({
      title: `Cerrar ${dayLabel(dayKey, false)}`,
      message: `Venta: ${money(report.totals.salesCents)}\nComisión: ${money(report.totals.commissionCents)}\nPremios: ${money(report.totals.prizesCents)}\nA entregar: ${money(report.totals.deliverCents)}\n\nDespués de cerrar ya no se puede anotar ni anular nada de este día.`,
      okText: 'Cerrar el día',
    });
    if (ok) await run(() => closeDay(db, dayKey, owner.id), 'Día cerrado');
  };

  const reopen = async () => {
    const owner = await requireOwner('Reabrir el día: autorización de la dueña');
    if (!owner) return;
    const reason = await askText({ title: 'Reabrir el día', label: '¿Qué hay que corregir?', okText: 'Reabrir' });
    if (reason) await run(() => reopenDay(db, dayKey, owner.id, reason), 'Día reabierto');
  };

  const changeCommission = async () => {
    const owner = await requireOwner('Cambiar comisión: autorización de la dueña');
    if (!owner || !t) return;
    const text = await askText({ title: 'Comisión de este día', label: 'Porcentaje (%)', initial: String(t.commissionPct), okText: 'Guardar' });
    if (text === null) return;
    const pct = Number(text.replace(',', '.'));
    await run(() => setDayCommission(db, dayKey, pct, owner.id), 'Comisión cambiada');
  };

  const share = async () => {
    if (!report) return;
    const text = lotteryDayText(report, settings);
    if (!(await shareText(text, 'Cuadre de lotería'))) openWhatsApp(text);
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Lotería</h1>
          <div className="day-nav">
            <button className="icon-btn" onClick={() => setDayKey(shiftDay(dayKey, -1))} aria-label="Día anterior">
              <Icon name="back" />
            </button>
            <span className="day-label">{dayLabel(dayKey)}</span>
            <button className="icon-btn" onClick={() => setDayKey(shiftDay(dayKey, 1))} disabled={isToday} aria-label="Día siguiente">
              <Icon name="next" />
            </button>
            {!isToday && (
              <button className="btn small" onClick={() => setDayKey(today)}>
                Hoy
              </button>
            )}
            {!open && <span className="badge">Cerrado</span>}
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => void share()} disabled={!report || report.totals.salesCount + report.totals.prizesCount === 0}>
            <Icon name="share" /> Enviar cuadre
          </button>
          {open ? (
            canEdit && <button className="btn" onClick={() => void close()}>
              <Icon name="lock" /> Cerrar el día
            </button>
          ) : (
            isOwner && (
              <button className="btn" onClick={() => void reopen()}>
                Reabrir
              </button>
            )
          )}
        </div>
      </header>

      {t && (
        <div className="stats">
          <Stat label="Venta" value={money(t.salesCents)} sub={plural(t.salesCount, 'jugada', 'jugadas')} />
          <button className="stat-button" onClick={() => editable && void changeCommission()} disabled={!editable} title="Cambiar el % de este día">
            <Stat label={`Comisión ${t.commissionPct}%`} value={money(t.commissionCents)} tone="good" sub={editable ? 'toca para cambiar el %' : 'lo que te ganas'} />
          </button>
          <Stat label="Premios" value={money(t.prizesCents)} tone="bad" sub={plural(t.prizesCount, 'pagado', 'pagados')} />
          <Stat label="A entregar" value={money(t.deliverCents)} tone="accent" big sub={report.creditCents > 0 ? `incluye ${money(report.creditCents)} fiado` : undefined} />
        </div>
      )}

      {isToday && editable && <EntryForm userId={user.id} />}
      {!isToday && open && (
        <p className="notice">Este día quedó abierto. Las jugadas nuevas se anotan siempre en el día de hoy; aquí solo se puede revisar, anular o cerrar.</p>
      )}

      <section className="card">
        <h2>Clientes del día</h2>
        {report && report.clients.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th className="num">Jugó</th>
                  <th className="num">Monto</th>
                  <th className="num">Premios</th>
                  <th className="num">Cobró</th>
                </tr>
              </thead>
              <tbody>
                {report.clients.map(c => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td className="num">{c.purchases || ''}</td>
                    <td className="num">{c.purchasesCents ? money(c.purchasesCents) : ''}</td>
                    <td className="num">{c.prizes || ''}</td>
                    <td className="num bad-text">{c.prizesCents ? money(c.prizesCents) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="num">{report.totals.salesCount}</th>
                  <th className="num">{money(report.totals.salesCents)}</th>
                  <th className="num">{report.totals.prizesCount}</th>
                  <th className="num">{money(report.totals.prizesCents)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <Empty icon="ticket" text="Todavía no hay nada anotado este día." />
        )}
        {report && report.byLottery.length > 1 && (
          <ul className="chips">
            {report.byLottery.map(l => (
              <li key={l.name} className="chip">
                {l.name}: venta {money(l.salesCents)} · premios {money(l.prizesCents)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {entries && entries.length > 0 && (
        <section className="card">
          <h2>Anotaciones</h2>
          <ul className="list">
            {entries.map(e => (
              <li key={e.id} className={e.status === 'void' ? 'voided' : ''}>
                <span className={`tag ${e.kind === 'play' ? 'in' : 'out'}`}>{e.kind === 'play' ? 'Jugada' : 'Premio'}</span>
                <span className="grow">
                  <strong>{e.clientName}</strong>
                  <small className="muted">
                    {' '}
                    {formatTime(e.date)}
                    {e.lottery ? ` · ${e.lottery}` : ''}
                    {e.credit ? ' · fiado' : ''}
                    {e.status === 'void' ? ' · ANULADO' : ''}
                  </small>
                </span>
                <span className={`amount ${e.kind === 'prize' ? 'bad-text' : ''}`}>{money(e.amountCents)}</span>
                {editable && e.status === 'done' && (
                  <button className="icon-btn" onClick={() => void voidEntry(e)} aria-label="Anular">
                    <Icon name="trash" size={20} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Anotar una jugada o un premio (lo de arriba de la libreta). */
function EntryForm({ userId }: { userId: string }) {
  const { settings, money } = useSession();
  const { run, toast } = useUi();
  const [kind, setKind] = useState<'play' | 'prize'>('play');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [lottery, setLottery] = useState(settings.lotteries[0] ?? '');
  const [credit, setCredit] = useState(false);
  const [requestId, setRequestId] = useState(newId);
  const [busy, setBusy] = useState(false);

  const clients = useLiveQuery(() => db.clients.filter(c => c.active).toArray(), []);
  const recentNames = useLiveQuery(async () => {
    const since = shiftDay(dayKeyOf(), -60);
    const rows = await db.lottery.where('dayKey').aboveOrEqual(since).toArray();
    return [...new Set(rows.map(r => r.clientName))];
  }, []);
  const suggestions = useMemo(() => [...new Set([...(clients ?? []).map(c => c.name), ...(recentNames ?? [])])].sort((a, b) => a.localeCompare(b, 'es')), [clients, recentNames]);
  const client: Client | undefined = useMemo(() => clients?.find(c => normalize(c.name) === normalize(name)), [clients, name]);

  const submit = async () => {
    const cents = parseMoney(amount);
    if (!cents) return toast('Escribe cuánto.', 'error');
    if (!name.trim()) return toast('Escribe el nombre del cliente.', 'error');
    setBusy(true);
    const base = { clientId: client?.id, clientName: name, amountCents: cents, lottery: lottery || undefined, userId, requestId };
    const done = await run(() => (kind === 'play' ? addLotterySale(db, { ...base, credit: credit && !!client }) : addPrize(db, base)));
    setBusy(false);
    if (done) {
      toast(`${kind === 'play' ? 'Jugada' : 'Premio'} de ${done.clientName}: ${money(done.amountCents)}`);
      setName('');
      setAmount('');
      setCredit(false);
      setRequestId(newId());
    }
  };

  return (
    <section className="card entry-form">
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: 'play', label: 'Anotar jugada' },
          { value: 'prize', label: 'Pagar premio' },
        ]}
      />
      <form
        onSubmit={e => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="row3">
          <Field label="Cliente" hint={client ? 'Cliente registrado' : name.trim() ? 'Nombre nuevo (se anota igual)' : undefined}>
            {id => (
              <>
                <input id={id} list="lottery-names" autoComplete="off" autoCapitalize="words" value={name} onChange={e => setName(e.target.value)} placeholder="Nombre" />
                <datalist id="lottery-names">
                  {suggestions.map(s => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label={kind === 'play' ? 'Cuánto jugó' : 'Cuánto se sacó'}>{id => <MoneyInput id={id} value={amount} onChange={setAmount} currency={settings.currency} />}</Field>
          {settings.lotteries.length > 0 && (
            <Field label="Lotería">
              {id => (
                <select id={id} value={lottery} onChange={e => setLottery(e.target.value)}>
                  <option value="">—</option>
                  {settings.lotteries.map(l => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              )}
            </Field>
          )}
        </div>
        <div className="quick">
          {QUICK_AMOUNTS.map(v => (
            <button type="button" key={v} className="btn small" onClick={() => setAmount(String(v))}>
              {v}
            </button>
          ))}
          {kind === 'play' && (
            <label className={`check${client ? '' : ' disabled'}`} title={client ? '' : 'Solo a clientes registrados'}>
              <input type="checkbox" checked={credit && !!client} disabled={!client} onChange={e => setCredit(e.target.checked)} /> Fiado
            </label>
          )}
          <button className={`btn ${kind === 'play' ? 'primary' : 'danger'} grow`} type="submit" disabled={busy}>
            <Icon name={kind === 'play' ? 'plus' : 'prize'} /> {kind === 'play' ? 'Anotar jugada' : 'Pagar premio'}
          </button>
        </div>
      </form>
    </section>
  );
}
