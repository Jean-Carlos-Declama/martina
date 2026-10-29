import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db } from '../../db/database';
import type { Client, LotteryEntry, Prize } from '../../db/types';
import { dayKeyOf, newId } from '../../domain/common';
import {
  addLotterySale,
  addPrize,
  closeDay,
  computeDay,
  reopenDay,
  setDayCommission,
  updateLotterySale,
  updatePrize,
  voidLotterySale,
  voidPrize,
} from '../../domain/lottery';
import { normalize } from '../../domain/products';
import { useSession, useUi } from '../context';
import { dayLabel, formatTime, moneyField, parseMoney, plural, shiftDay } from '../format';
import { Icon } from '../icons';
import { Empty, Field, Modal, MoneyInput, Segmented, Stat } from '../kit';
import { lotteryDayText, openWhatsApp, shareText } from '../share';

const QUICK_AMOUNTS = [25, 50, 100, 200, 500];

type Play = LotteryEntry & { kind: 'play' };
type Win = Prize & { kind: 'prize' };
type Entry = Play | Win;

/** "A entregar" (o "Faltante" en rojo si los premios y la comisión pasaron la venta). */
export function DeliverStat({ cents, money, sub }: { cents: number; money: (cents: number) => string; sub?: string }) {
  return cents < 0 ? (
    <Stat label="Faltante" value={money(cents)} tone="bad" big sub={sub ?? 'los premios y la comisión pasaron la venta'} />
  ) : (
    <Stat label="A entregar" value={money(cents)} tone="accent" big sub={sub} />
  );
}

/** La libreta de la lotería: anotar jugadas y premios, y el cuadre del día. */
export function Lottery() {
  const { money, settings, isOwner, canEdit, user, requireOwner } = useSession();
  const { run, confirm, askText } = useUi();
  const today = dayKeyOf();
  const [dayKey, setDayKey] = useState(today);
  const [editing, setEditing] = useState<{ entry: Entry; ownerId: string } | null>(null);
  const report = useLiveQuery(() => computeDay(db, dayKey), [dayKey]);
  const entries = useLiveQuery(async () => {
    const plays: Play[] = (await db.lottery.where('dayKey').equals(dayKey).toArray()).map(e => ({ ...e, kind: 'play' }));
    const prizes: Win[] = (await db.prizes.where('dayKey').equals(dayKey).toArray()).map(p => ({ ...p, kind: 'prize' }));
    const byTime = (a: Entry, b: Entry) => b.date.localeCompare(a.date);
    return { plays: plays.sort(byTime), prizes: prizes.sort(byTime) };
  }, [dayKey]);

  const isToday = dayKey === today;
  const open = report?.status !== 'closed';
  // "Solo mirar" ve el cuadre pero no anota, no anula ni cierra.
  const editable = open && canEdit;
  const t = report?.totals;

  const voidEntry = async (entry: Entry) => {
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
    const deliver = report.totals.deliverCents;
    const ok = await confirm({
      title: `Cerrar ${dayLabel(dayKey, false)}`,
      message: `Venta: ${money(report.totals.salesCents)}\nComisión: ${money(report.totals.commissionCents)}\nPremios: ${money(report.totals.prizesCents)}\n${deliver < 0 ? 'Faltante' : 'A entregar'}: ${money(deliver)}\n\nDespués de cerrar ya no se puede anotar ni anular nada de este día.`,
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

  const startEdit = async (entry: Entry) => {
    const owner = await requireOwner('Corregir: autorización de la dueña');
    if (owner) setEditing({ entry, ownerId: owner.id });
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
            <label className="date-jump" title="Ir a otro día">
              <Icon name="calendar" size={20} />
              <input
                type="date"
                value={dayKey}
                max={today}
                onClick={e => e.currentTarget.showPicker?.()}
                onChange={e => e.target.value && e.target.value <= today && setDayKey(e.target.value)}
                aria-label="Ir a otro día"
              />
            </label>
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
          {open
            ? canEdit && (
                <button className="btn" onClick={() => void close()}>
                  <Icon name="lock" /> Cerrar el día
                </button>
              )
            : isOwner && (
                <button className="btn" onClick={() => void reopen()}>
                  Reabrir para corregir
                </button>
              )}
        </div>
      </header>

      {t && (
        <div className="stats">
          <Stat label="Venta" value={money(t.salesCents)} sub={plural(t.salesCount, 'jugada', 'jugadas')} />
          <button className="stat-button" onClick={() => editable && void changeCommission()} disabled={!editable} title="Cambiar el % de este día">
            <Stat label={`Comisión ${t.commissionPct}%`} value={money(t.commissionCents)} tone="good" sub={editable ? 'toca para cambiar el %' : 'lo que te ganas'} />
          </button>
          <Stat label="Premios" value={money(t.prizesCents)} tone="bad" sub={plural(t.prizesCount, 'premio pagado', 'premios pagados')} />
          <DeliverStat cents={t.deliverCents} money={money} sub={report.creditCents > 0 && t.deliverCents >= 0 ? `incluye ${money(report.creditCents)} fiado` : undefined} />
        </div>
      )}

      {!isToday && editable && (
        <p className="notice warn">
          <Icon name="alert" />
          <span>
            Estás anotando en el <strong>{dayLabel(dayKey, false)}</strong>, no en hoy: es para corregir el cuadre de ese día.
            {isOwner ? '' : ' Pide el PIN de la dueña.'}
          </span>
        </p>
      )}
      {!isToday && !open && canEdit && (
        <p className="notice">
          Este día está cerrado. Para agregar o corregir algo, {isOwner ? 'toca «Reabrir para corregir» arriba' : 'pídele a la dueña que lo reabra'}.
        </p>
      )}
      {/* La llave del día: al cambiar de día el formulario empieza limpio (nada se anota en otro día por error). */}
      {editable && <EntryForm key={dayKey} userId={user.id} dayKey={dayKey} />}

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
                  <th className="num">Se sacó</th>
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

      {entries && (
        <div className="two-cols">
          <EntryList title="Premios pagados" empty="No se ha pagado ningún premio." items={entries.prizes} prizes editable={editable} onEdit={startEdit} onVoid={voidEntry} />
          <EntryList title="Jugadas" empty="No hay jugadas." items={entries.plays} editable={editable} onEdit={startEdit} onVoid={voidEntry} />
        </div>
      )}
      {editing && <EditEntryModal entry={editing.entry} ownerId={editing.ownerId} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Lista de premios o de jugadas del día, con cuántos son, el total y para corregir o anular cada uno. */
function EntryList(props: {
  title: string;
  empty: string;
  items: Entry[];
  prizes?: boolean;
  editable: boolean;
  onEdit: (entry: Entry) => void;
  onVoid: (entry: Entry) => void;
}) {
  const { money } = useSession();
  const done = props.items.filter(e => e.status === 'done');
  const total = done.reduce((sum, e) => sum + e.amountCents, 0);
  const isPrize = !!props.prizes;
  return (
    <section className="card">
      <div className="card-head">
        <h2>{props.title}</h2>
        <span className={`amount ${isPrize ? 'bad-text' : ''}`}>
          {done.length} · {money(total)}
        </span>
      </div>
      {props.items.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <ul className="list">
          {props.items.map(e => (
            <li key={e.id} className={e.status === 'void' ? 'voided' : ''}>
              <span className="grow">
                <strong>{e.clientName}</strong>
                <small className="muted">
                  {formatTime(e.date)}
                  {e.lottery ? ` · ${e.lottery}` : ''}
                  {e.kind === 'play' && e.credit ? ' · fiado' : ''}
                  {e.status === 'void' ? ' · ANULADO' : ''}
                </small>
              </span>
              <span className={`amount ${isPrize ? 'bad-text' : ''}`}>{money(e.amountCents)}</span>
              {props.editable && e.status === 'done' && (
                <>
                  <button className="icon-btn" onClick={() => props.onEdit(e)} aria-label="Corregir">
                    <Icon name="edit" size={20} />
                  </button>
                  <button className="icon-btn" onClick={() => props.onVoid(e)} aria-label="Anular">
                    <Icon name="trash" size={20} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Nombres para sugerir: los clientes registrados y los que se han anotado en la lotería. */
function useNameSuggestions() {
  const clients = useLiveQuery(() => db.clients.filter(c => c.active).toArray(), []);
  const recentNames = useLiveQuery(async () => {
    const since = shiftDay(dayKeyOf(), -60);
    const rows = await db.lottery.where('dayKey').aboveOrEqual(since).toArray();
    return [...new Set(rows.map(r => r.clientName))];
  }, []);
  const suggestions = useMemo(() => [...new Set([...(clients ?? []).map(c => c.name), ...(recentNames ?? [])])].sort((a, b) => a.localeCompare(b, 'es')), [clients, recentNames]);
  const findClient = (name: string): Client | undefined => clients?.find(c => normalize(c.name) === normalize(name));
  return { suggestions, findClient };
}

function NameField({ value, onChange, hint, listId }: { value: string; onChange: (value: string) => void; hint?: string; listId: string }) {
  const { suggestions } = useNameSuggestions();
  return (
    <Field label="Cliente" hint={hint}>
      {id => (
        <>
          <input id={id} list={listId} autoComplete="off" autoCapitalize="words" value={value} onChange={e => onChange(e.target.value)} placeholder="Nombre" />
          <datalist id={listId}>
            {suggestions.map(s => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
    </Field>
  );
}

/** Anotar una jugada o un premio (lo de arriba de la libreta). En un día anterior pide el PIN de la dueña. */
function EntryForm({ userId, dayKey }: { userId: string; dayKey: string }) {
  const { settings, money, requireOwner } = useSession();
  const { run, toast } = useUi();
  const { findClient } = useNameSuggestions();
  const [kind, setKind] = useState<'play' | 'prize'>('play');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [lottery, setLottery] = useState(settings.lotteries[0] ?? '');
  const [credit, setCredit] = useState(false);
  const [requestId, setRequestId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const client = findClient(name);
  const pastDay = dayKey !== dayKeyOf();

  const submit = async () => {
    const cents = parseMoney(amount);
    if (!cents) return toast('Escribe cuánto.', 'error');
    if (!name.trim()) return toast('Escribe el nombre del cliente.', 'error');
    let byUser = userId;
    if (pastDay) {
      const owner = await requireOwner(`Anotar en el ${dayLabel(dayKey, false)}: autorización de la dueña`);
      if (!owner) return;
      byUser = owner.id;
    }
    setBusy(true);
    const base = { clientId: client?.id, clientName: name, amountCents: cents, lottery: lottery || undefined, userId: byUser, requestId, dayKey };
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
      {kind === 'prize' && <p className="muted small-text">Quién se sacó el premio y cuánto. Se paga del dinero del día y se resta de lo que entregas.</p>}
      <form
        onSubmit={e => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="row3">
          <NameField value={name} onChange={setName} listId="lottery-names" hint={client ? 'Cliente registrado' : name.trim() ? 'Nombre nuevo (se anota igual)' : undefined} />
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

/** Corregir una jugada o un premio: el cuadre (y lo que se entrega) se recalcula solo. */
function EditEntryModal({ entry, ownerId, onClose }: { entry: Entry; ownerId: string; onClose: () => void }) {
  const { settings, money } = useSession();
  const { run } = useUi();
  const { findClient } = useNameSuggestions();
  const [name, setName] = useState(entry.clientName);
  const [amount, setAmount] = useState(moneyField(entry.amountCents));
  const [lottery, setLottery] = useState(entry.lottery ?? '');
  const isPlay = entry.kind === 'play';
  const lockedClient = isPlay && entry.credit;

  const save = async () => {
    const cents = parseMoney(amount);
    if (!cents) return;
    const client = lockedClient ? undefined : findClient(name);
    const changes = { clientId: lockedClient ? entry.clientId : client?.id, clientName: lockedClient ? entry.clientName : name, amountCents: cents, lottery: lottery || undefined };
    const ok = await run(async () => {
      if (isPlay) await updateLotterySale(db, entry.id, changes, ownerId);
      else await updatePrize(db, entry.id, changes, ownerId);
      return true;
    }, isPlay ? 'Jugada corregida' : 'Premio corregido');
    if (ok) onClose();
  };

  return (
    <Modal
      title={isPlay ? 'Corregir jugada' : 'Corregir premio'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!parseMoney(amount) || !name.trim()} onClick={() => void save()}>
            Guardar
          </button>
        </>
      }
    >
      <p className="muted">
        Antes: {entry.clientName} · {money(entry.amountCents)}. Al guardar, el cuadre del día se recalcula solo.
      </p>
      <div className="row2">
        {lockedClient ? (
          <Field label="Cliente" hint="Jugada fiada: para cambiar el cliente, anúlala y anótala otra vez">
            {id => <input id={id} value={entry.clientName} disabled />}
          </Field>
        ) : (
          <NameField value={name} onChange={setName} listId="edit-names" />
        )}
        <Field label={isPlay ? 'Cuánto jugó' : 'Cuánto se sacó'}>{id => <MoneyInput id={id} value={amount} onChange={setAmount} currency={settings.currency} autoFocus />}</Field>
      </div>
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
    </Modal>
  );
}
