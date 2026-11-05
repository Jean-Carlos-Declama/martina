import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { db } from '../../db/database';
import type { Client, LotteryEntry, PaymentMethod, Prize } from '../../db/types';
import { exactClient, nameKey } from '../../domain/clients';
import { dayKeyOf, newId } from '../../domain/common';
import {
  addLotterySale,
  addPrize,
  closeDay,
  computeDay,
  lotteryReport,
  playPayment,
  reopenDay,
  setDayCommission,
  updateLotterySale,
  updatePrize,
  voidLotterySale,
  voidPrize,
} from '../../domain/lottery';
import { normalize } from '../../domain/products';
import { passesCreditLimit } from '../../domain/credit';
import { weekOf } from '../../domain/reports';
import { balanceTone, ClientSuggestions, CreditPreview, showsSuggestions, useCreditClient } from '../clientPick';
import { useSession, useUi } from '../context';
import { balanceLabel, dayLabel, formatTime, moneyField, parseMoney, PAYMENT_LABELS, plural, rangeLabel, shiftDay } from '../format';
import { Icon } from '../icons';
import { Empty, Field, Modal, MoneyInput, Segmented, Stat } from '../kit';
import { lotteryDayText, lotteryWeekText, openWhatsApp, shareText } from '../share';

const QUICK_AMOUNTS = [25, 50, 100, 200, 500];

// La ficha del cliente (su cuenta, abonar) se abre encima de la Lotería al tocar su nombre; se carga cuando hace falta.
const ClientSheet = lazy(() => import('./Clients').then(m => ({ default: m.ClientSheet })));

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
  const { run, confirm, askText, toast } = useUi();
  const today = dayKeyOf();
  const [dayKey, setDayKey] = useState(today);
  const [editing, setEditing] = useState<{ entry: Entry; ownerId: string } | null>(null);
  const report = useLiveQuery(() => computeDay(db, dayKey), [dayKey]);
  const clientOf = useClientOf();
  const [viewingClient, setViewingClient] = useState<string | null>(null);
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

  // Un día cerrado se reabre para quitar o corregir algo (después se puede cerrar otra vez).
  const ensureOpen = async (): Promise<boolean> => {
    if (open) return true;
    if (!isOwner) {
      toast('Este día está cerrado: pídele a la dueña que lo reabra para corregir.', 'error');
      return false;
    }
    const ok = await confirm({
      title: 'Este día está cerrado',
      message: 'Para quitar o corregir algo hay que reabrirlo. Cuando termines, lo cierras otra vez con «Cerrar el día».',
      okText: 'Reabrir y seguir',
    });
    if (!ok) return false;
    const owner = await requireOwner('Reabrir el día: autorización de la dueña');
    return !!owner && !!(await run(async () => (await reopenDay(db, dayKey, owner.id, 'Para quitar o corregir un premio o una jugada'), true)));
  };

  const voidEntry = async (entry: Entry) => {
    if (!(await ensureOpen())) return;
    const owner = await requireOwner('Quitar: autorización de la dueña');
    if (!owner) return;
    let message = `${entry.clientName}: ${money(entry.amountCents)}`;
    // Una jugada fiada sale de la cuenta del cliente: que se vea cómo queda.
    const client = entry.kind === 'play' && entry.credit && entry.clientId ? await db.clients.get(entry.clientId) : undefined;
    if (client)
      message += `\nEra fiada: se le quita de su cuenta. ${client.name}: ahora ${balanceLabel(client.balanceCents, money)}; después ${balanceLabel(client.balanceCents - entry.amountCents, money)}.`;
    const reason = await askText({
      title: entry.kind === 'play' ? 'Quitar jugada' : 'Quitar premio',
      message,
      label: '¿Por qué lo quitas?',
      placeholder: entry.kind === 'play' ? 'Ej. se anotó dos veces' : 'Ej. se lo puse a otra persona',
      okText: 'Quitar',
      danger: true,
    });
    if (!reason) return;
    await run(() => (entry.kind === 'play' ? voidLotterySale(db, entry.id, owner.id, reason) : voidPrize(db, entry.id, owner.id, reason)), 'Quitado: el cuadre se recalculó');
  };

  const close = async () => {
    if (!report) return;
    const owner = await requireOwner('Cerrar el día: autorización de la dueña');
    if (!owner) return;
    const deliver = report.totals.deliverCents;
    const ok = await confirm({
      title: `Cerrar ${dayLabel(dayKey, false)}`,
      message: `Venta: ${money(report.totals.salesCents)}\nComisión: ${money(report.totals.commissionCents)}\nPremios: ${money(report.totals.prizesCents)}\n${deliver < 0 ? 'Faltante' : 'A entregar'}: ${money(deliver)}${report.creditCents > 0 ? `\n(incluye ${money(report.creditCents)} fiado, por cobrar)` : ''}\n\nDespués de cerrar ya no se puede anotar ni anular nada de este día.`,
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
    if (!(await ensureOpen())) return;
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
      {report && <PaymentSplit rows={report.byPayment} />}
      <WeekCard dayKey={dayKey} onPickDay={setDayKey} />

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
            {/* En el teléfono se esconden las columnas de "cuántas veces" y la cantidad va junto al monto: así cabe sin deslizar. */}
            <table className="table day-clients">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th className="num count">Jugó</th>
                  <th className="num">Monto</th>
                  <th className="num count">Premios</th>
                  <th className="num won">Se sacó</th>
                </tr>
              </thead>
              <tbody>
                {report.clients.map(c => {
                  const client = clientOf(c);
                  const balance = client?.balanceCents ?? 0;
                  // Lo que debe (o tiene a favor) hoy; en un día anterior se aclara que es lo de hoy.
                  const owes = balance !== 0 && (
                    <small className={`owes ${balanceTone(balance)}`}>
                      {balance > 0 ? 'debe' : 'a favor'}
                      {isToday ? '' : ' hoy'} {money(Math.abs(balance))}
                    </small>
                  );
                  return (
                    <tr key={c.name}>
                      <td>
                        {client ? (
                          // Tocar el nombre abre su cuenta (abonar, ver lo que debe) sin salir de la Lotería.
                          <button type="button" className="cell-link" onClick={() => setViewingClient(client.id)}>
                            <span className="cell-link-name">{c.name}</span>
                            {owes}
                          </button>
                        ) : (
                          c.name
                        )}
                      </td>
                      <td className="num count">{c.purchases || ''}</td>
                      <td className="num">
                        {c.purchasesCents ? money(c.purchasesCents) : ''}
                        {c.purchases > 1 && <small className="count-inline"> ({c.purchases})</small>}
                        {c.creditCents > 0 && <small className="owes">fiado {money(c.creditCents)}</small>}
                        {c.prizesCents > 0 && (
                          <small className="prize-inline">
                            premio {money(c.prizesCents)}
                            {c.prizes > 1 ? ` (${c.prizes})` : ''}
                          </small>
                        )}
                      </td>
                      <td className="num count">{c.prizes || ''}</td>
                      <td className="num bad-text won">
                        {c.prizesCents ? money(c.prizesCents) : ''}
                        {c.prizes > 1 && <small className="count-inline"> ({c.prizes})</small>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="num count">{report.totals.salesCount}</th>
                  <th className="num">
                    {money(report.totals.salesCents)}
                    {report.totals.prizesCents > 0 && <small className="prize-inline">premios {money(report.totals.prizesCents)}</small>}
                  </th>
                  <th className="num count">{report.totals.prizesCount}</th>
                  <th className="num won">{money(report.totals.prizesCents)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <Empty icon="ticket" text="Todavía no hay nada anotado este día." />
        )}
        {report && report.byLottery.length > 1 && (
          <ul className="chips lottery-chips">
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
          <EntryList title="Premios pagados" empty="No se ha pagado ningún premio." items={entries.prizes} prizes editable={canEdit} clientOf={clientOf} onEdit={startEdit} onVoid={voidEntry} />
          <EntryList title="Jugadas" empty="No hay jugadas." items={entries.plays} editable={canEdit} clientOf={clientOf} onEdit={startEdit} onVoid={voidEntry} />
        </div>
      )}
      {editing && (
        <EditEntryModal
          entry={editing.entry}
          ownerId={editing.ownerId}
          onClose={() => setEditing(null)}
          onRemove={() => {
            const entry = editing.entry;
            setEditing(null);
            void voidEntry(entry);
          }}
        />
      )}
      {viewingClient && (
        <Suspense fallback={null}>
          <ClientSheet id={viewingClient} onClose={() => setViewingClient(null)} />
        </Suspense>
      )}
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
  clientOf: (row: { clientId?: string; name: string }) => Client | undefined;
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
            <li key={e.id} className={`entry-row ${e.status === 'void' ? 'voided' : ''}`}>
              <span className="grow">
                <strong>{e.clientName}</strong>
                <small className="muted">
                  {formatTime(e.date)}
                  {e.lottery ? ` · ${e.lottery}` : ''}
                  {e.status === 'void' ? ` · QUITADO${e.voidReason ? `: ${e.voidReason}` : ''}` : ''}
                </small>
                {e.note && e.status === 'done' && <small className="muted">Nota: {e.note}</small>}
                {e.status === 'done' && <EntryOwes balance={props.clientOf({ clientId: e.clientId, name: e.clientName })?.balanceCents ?? 0} />}
              </span>
              <span className="right">
                <span className={`amount ${isPrize || (e.kind === 'play' && e.credit) ? 'bad-text' : ''}`}>{money(e.amountCents)}</span>
                {e.kind === 'play' && e.credit && <span className="tag out">Fiado</span>}
                {e.kind === 'play' && !e.credit && playPayment(e) !== 'cash' && <span className="tag">{PAYMENT_LABELS[playPayment(e)]}</span>}
              </span>
              {props.editable && e.status === 'done' && (
                <span className="row-tools">
                  <button className="icon-btn" onClick={() => props.onEdit(e)} aria-label="Corregir">
                    <Icon name="edit" size={20} />
                  </button>
                  <button className="icon-btn" onClick={() => props.onVoid(e)} aria-label="Quitar">
                    <Icon name="trash" size={20} />
                  </button>
                </span>
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

/** El cliente de una fila del cuadre (por su ficha, o por su nombre si se anotó sin escogerlo de la lista). */
function useClientOf() {
  const clients = useLiveQuery(() => db.clients.toArray(), []);
  return useMemo(() => {
    const byId = new Map((clients ?? []).map(c => [c.id, c]));
    const byName = new Map((clients ?? []).map(c => [normalize(c.name), c]));
    return (row: { clientId?: string; name: string }): Client | undefined => (row.clientId && byId.get(row.clientId)) || byName.get(normalize(row.name));
  }, [clients]);
}

/** "debe RD$ X" (o "a favor") debajo del nombre en las listas de jugadas y premios. */
function EntryOwes({ balance }: { balance: number }) {
  const { money } = useSession();
  return balance === 0 ? null : <small className={`owes ${balanceTone(balance)}`}>{balanceLabel(balance, money)}</small>;
}

/** El campo del nombre: mientras se escribe salen los clientes (con lo que deben) y los nombres que ya se usaron. */
function NameField({ value, onChange, hint }: { value: string; onChange: (value: string) => void; hint?: ReactNode }) {
  const { suggestions } = useNameSuggestions();
  const clients = useLiveQuery(() => db.clients.toArray(), []);
  return (
    <Field label="Cliente" hint={hint}>
      {id => (
        <>
          <input id={id} autoComplete="off" autoCapitalize="words" value={value} onChange={e => onChange(e.target.value)} placeholder="Nombre" />
          <ClientSuggestions name={value} clients={clients} names={suggestions} onPick={onChange} />
        </>
      )}
    </Field>
  );
}

/** Anotar una jugada o un premio (lo de arriba de la libreta). En un día anterior pide el PIN de la dueña. */
function EntryForm({ userId, dayKey }: { userId: string; dayKey: string }) {
  const { settings, money, requireOwner } = useSession();
  const { run, toast } = useUi();
  const { resolveClient, prompt, clients } = useCreditClient();
  const [kind, setKind] = useState<'play' | 'prize'>('play');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [lottery, setLottery] = useState(settings.lotteries[0] ?? '');
  const [payment, setPayment] = useState<PaymentMethod>('cash');
  const [requestId, setRequestId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const client = exactClient(name, clients);
  const cents = parseMoney(amount);
  const pastDay = dayKey !== dayKeyOf();
  const fiado = kind === 'play' && payment === 'credit';
  const overLimit = fiado && !!client && !!cents && passesCreditLimit(client, cents);

  const submit = async () => {
    if (!cents) return toast('Escribe cuánto.', 'error');
    if (!name.trim()) return toast('Escribe el nombre del cliente.', 'error');
    let byUser = userId;
    if (pastDay) {
      const owner = await requireOwner(`Anotar en el ${dayLabel(dayKey, false)}: autorización de la dueña`);
      if (!owner) return;
      byUser = owner.id;
    }
    setBusy(true);
    // Fiado a alguien que no es un cliente registrado: siempre pregunta (¿es uno de estos parecidos?, ¿cliente nuevo?).
    let clientId = client?.id;
    let newClientName: string | undefined;
    if (fiado && !client) {
      const target = await resolveClient(name, cents);
      if (!target) return setBusy(false);
      if ('client' in target) {
        setName(target.client.name);
        // Si se pasa de su límite, no se anota: la pista lo dice y el botón se apaga.
        if (passesCreditLimit(target.client, cents)) return setBusy(false);
        clientId = target.client.id;
      } else newClientName = target.newClientName;
    }
    const base = { clientId, clientName: name, amountCents: cents, lottery: lottery || undefined, userId: byUser, requestId, dayKey };
    const done = await run(() => (kind === 'play' ? addLotterySale(db, { ...base, credit: fiado, payment, newClientName }) : addPrize(db, base)));
    setBusy(false);
    if (done) {
      toast(`${kind === 'play' ? 'Jugada' : 'Premio'} de ${done.clientName}: ${money(done.amountCents)}${newClientName ? ' (se registró como cliente)' : ''}`);
      setName('');
      setAmount('');
      setPayment('cash');
      setRequestId(newId());
    }
  };

  const hint = client ? (
    <>
      Cliente registrado · <CreditPreview client={client} amountCents={fiado && cents ? cents : undefined} what="esta jugada" />
    </>
  ) : showsSuggestions(name, clients) ? (
    fiado ? (
      'Si es uno de estos clientes, tócalo. Si no, al fiar te pregunta si registras el nombre nuevo.'
    ) : (
      'Si es uno de estos clientes, tócalo (si no, se anota con este nombre).'
    )
  ) : name.trim() ? (
    fiado ? (
      'Nombre nuevo: al fiar te pregunta si lo registras como cliente.'
    ) : (
      'Nombre nuevo (se anota igual)'
    )
  ) : undefined;

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
        <div className={settings.lotteries.length > 0 ? 'row3' : 'row2'}>
          <NameField value={name} onChange={setName} hint={hint} />
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
        {kind === 'play' && (
          <div className="field pay-field">
            <span className="field-label">Cómo pagó</span>
            <Segmented
              className="pay-tabs"
              value={payment}
              onChange={setPayment}
              options={(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map(p => ({ value: p, label: PAYMENT_LABELS[p] }))}
            />
          </div>
        )}
        <div className="quick">
          {QUICK_AMOUNTS.map(v => (
            <button type="button" key={v} className="btn small" onClick={() => setAmount(String(v))}>
              {v}
            </button>
          ))}
          <button className={`btn ${kind === 'play' ? 'primary' : 'danger'} grow`} type="submit" disabled={busy || overLimit}>
            <Icon name={kind === 'play' ? 'plus' : 'prize'} /> {kind === 'play' ? 'Anotar jugada' : 'Pagar premio'}
          </button>
        </div>
      </form>
      {prompt}
    </section>
  );
}

/** Corregir una jugada o un premio: el cuadre (y lo que se entrega) se recalcula solo. */
function EditEntryModal({ entry, ownerId, onClose, onRemove }: { entry: Entry; ownerId: string; onClose: () => void; onRemove: () => void }) {
  const { settings, money } = useSession();
  const { run } = useUi();
  const { findClient } = useNameSuggestions();
  const { resolveClient, prompt } = useCreditClient();
  const [name, setName] = useState(entry.clientName);
  const [amount, setAmount] = useState(moneyField(entry.amountCents));
  const [lottery, setLottery] = useState(entry.lottery ?? '');
  const [note, setNote] = useState('');
  const [payment, setPayment] = useState<PaymentMethod>(entry.kind === 'play' ? playPayment(entry) : 'cash');
  const isPlay = entry.kind === 'play';
  const fiada = isPlay && entry.credit;
  // Jugada fiada con el nombre corregido: la deuda pasa de la cuenta del primero a la del nombre correcto.
  const changedClient = fiada && !!name.trim() && nameKey(name) !== nameKey(entry.clientName);
  // Jugada fiada: corregir el monto también cambia lo que debe el cliente.
  const creditClient = useLiveQuery(() => (fiada && entry.clientId ? db.clients.get(entry.clientId) : undefined), [fiada, entry.clientId]);
  const cents = parseMoney(amount);
  // Cómo queda la cuenta del cliente con el monto corregido (puede quedarle saldo a favor).
  const after = creditClient && cents && !changedClient ? creditClient.balanceCents + cents - entry.amountCents : null;

  const save = async () => {
    if (!cents) return;
    let clientId = fiada ? entry.clientId : findClient(name)?.id;
    let newClientName: string | undefined;
    if (changedClient) {
      // ¿A quién pasa? Si no es exactamente un cliente, pregunta (¿es uno de estos parecidos?, ¿cliente nuevo?).
      const target = await resolveClient(name, cents);
      if (!target) return;
      if ('client' in target) clientId = target.client.id;
      else {
        clientId = undefined;
        newClientName = target.newClientName;
      }
    }
    const changes = { clientId, newClientName, clientName: name, amountCents: cents, lottery: lottery || undefined, note, payment: isPlay && !fiada ? payment : undefined };
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
          <button className="btn primary" disabled={!cents || !name.trim()} onClick={() => void save()}>
            Guardar
          </button>
        </>
      }
    >
      <p className="muted">
        Antes: {entry.clientName} · {money(entry.amountCents)}. Al guardar, el cuadre del día se recalcula solo.
      </p>
      {changedClient && (
        <p className="warn-text">
          Esta jugada fiada ({money(cents ?? entry.amountCents)}) sale de la cuenta de {entry.clientName} y pasa a la de {name.trim()}.
        </p>
      )}
      {creditClient && !changedClient && (
        <div className="stats">
          <Stat
            label={creditClient.balanceCents < 0 ? `${creditClient.name} tiene a favor` : `${creditClient.name} debe ahora`}
            value={money(Math.abs(creditClient.balanceCents))}
            tone={creditClient.balanceCents > 0 ? 'bad' : creditClient.balanceCents < 0 ? 'good' : 'plain'}
          />
          <Stat
            label={after !== null && after < 0 ? 'Con el cambio le queda a favor' : 'Con el cambio debe'}
            value={after === null ? '—' : money(Math.abs(after))}
            tone={after === null || after === 0 ? 'plain' : after > 0 ? 'bad' : 'good'}
            big
          />
        </div>
      )}
      {creditClient?.creditLimitCents && after !== null && cents && cents > entry.amountCents && after > creditClient.creditLimitCents ? (
        <p className="warn-text">
          Con este cambio {creditClient.name} se pasa de su límite de fiado ({money(creditClient.creditLimitCents)}).
        </p>
      ) : null}
      <div className="row2">
        <NameField
          value={name}
          onChange={setName}
          hint={fiada ? 'Si el nombre está mal, corrígelo: la deuda pasa a la cuenta correcta.' : isPlay ? undefined : 'Si se lo pusiste a otra persona, escribe el nombre correcto.'}
        />
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
      {isPlay && !fiada && (
        <Field label="Cómo pagó">
          {id => (
            <select id={id} value={payment} onChange={e => setPayment(e.target.value as PaymentMethod)}>
              {(Object.keys(PAYMENT_LABELS) as PaymentMethod[])
                .filter(p => p !== 'credit')
                .map(p => (
                  <option key={p} value={p}>
                    {PAYMENT_LABELS[p]}
                  </option>
                ))}
            </select>
          )}
        </Field>
      )}
      <Field label="Comentario (opcional)" hint="Por qué lo corriges; se queda anotado.">
        {id => <input id={id} value={note} onChange={e => setNote(e.target.value)} placeholder="Ej. se lo puse a otra persona" />}
      </Field>
      <button className="btn danger small" onClick={onRemove}>
        <Icon name="trash" size={18} /> {isPlay ? 'Quitar esta jugada' : 'Quitar este premio'}
      </button>
      {prompt}
    </Modal>
  );
}

/**
 * La semana de cierre (lunes a domingo) del día que se está viendo: lo que se va sumando, cada día (tocarlo lo abre),
 * y la comisión de cada lotería. Se puede mandar por WhatsApp.
 */
function WeekCard({ dayKey, onPickDay }: { dayKey: string; onPickDay: (dayKey: string) => void }) {
  const { money, settings } = useSession();
  const [showDays, setShowDays] = useState(false);
  const week = weekOf(dayKey);
  const report = useLiveQuery(() => lotteryReport(db, week.from, week.to), [week.from, week.to]);
  const today = dayKeyOf();
  if (!report) return null;
  const t = report.totals;
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(week.from, i));
  const share = async () => {
    const text = lotteryWeekText(report, settings);
    if (!(await shareText(text, 'Cuadre de la semana'))) openWhatsApp(text);
  };
  return (
    <section className="card week-card">
      <div className="card-head">
        <h2>
          Semana <small className="muted">{rangeLabel(week.from, week.to)}</small>
        </h2>
        <button className="btn small" onClick={() => setShowDays(v => !v)}>
          {showDays ? 'Ocultar días' : 'Ver día por día'}
        </button>
      </div>
      <div className="stats">
        <Stat label="Venta de la semana" value={money(t.salesCents)} sub={plural(t.salesCount, 'jugada', 'jugadas')} />
        <Stat label="Comisión" value={money(t.commissionCents)} tone="good" sub="lo que te ganas" />
        <Stat label="Premios" value={money(t.prizesCents)} tone="bad" sub={plural(t.prizesCount, 'premio', 'premios')} />
        <DeliverStat cents={t.deliverCents} money={money} sub={report.creditCents > 0 && t.deliverCents >= 0 ? `incluye ${money(report.creditCents)} fiado` : undefined} />
      </div>
      <PaymentSplit rows={report.byPayment} />
      {showDays && (
        <>
          <div className="table-wrap">
            <table className="table stack week-days">
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
                {days.map(d => {
                  const r = report.days.find(x => x.dayKey === d);
                  return (
                    <tr key={d} className={`${d === dayKey ? 'on' : ''}${d > today ? ' future' : ''}`}>
                      <td>
                        <button type="button" className="cell-link" disabled={d > today} onClick={() => onPickDay(d)}>
                          <span className="cell-link-name">{dayLabel(d, false)}</span>
                          {r?.status === 'closed' && <small className="muted"> (cerrado)</small>}
                        </button>
                      </td>
                      <td className="num" data-label="Venta">
                        {r ? money(r.totals.salesCents) : '—'}
                      </td>
                      <td className="num good-text" data-label={r ? `Comisión ${r.totals.commissionPct}%` : 'Comisión'}>
                        {r ? money(r.totals.commissionCents) : '—'}
                      </td>
                      <td className="num bad-text" data-label="Premios">
                        {r ? money(r.totals.prizesCents) : '—'}
                      </td>
                      <td className={`num ${r && r.totals.deliverCents < 0 ? 'bad-text' : ''}`} data-label={r && r.totals.deliverCents < 0 ? 'Faltante' : 'A entregar'}>
                        {r ? money(r.totals.deliverCents) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.byLottery.length > 1 && <LotteryBreakdown rows={report.byLottery} />}
        </>
      )}
      <div className="actions wrap">
        <button className="btn small" onClick={() => onPickDay(shiftDay(week.from, -1))}>
          <Icon name="back" size={18} /> Semana anterior
        </button>
        {week.to < today && (
          <button className="btn small" onClick={() => onPickDay(shiftDay(week.to, 7) > today ? today : shiftDay(week.to, 7))}>
            Semana siguiente <Icon name="next" size={18} />
          </button>
        )}
        <button className="btn small" onClick={() => void share()} disabled={t.salesCount + t.prizesCount === 0}>
          <Icon name="share" size={18} /> Enviar la semana
        </button>
      </div>
    </section>
  );
}

/** "Cómo pagaron": cuánto entró en efectivo, por Zelle, Cash App... (solo si no fue todo en efectivo). */
export function PaymentSplit({ rows }: { rows: { payment: PaymentMethod; cents: number }[] }) {
  const { money } = useSession();
  if (!rows.some(p => p.payment !== 'cash')) return null;
  return (
    <ul className="chips lottery-chips" aria-label="Cómo pagaron">
      {rows.map(p => (
        <li key={p.payment} className={`chip ${p.payment === 'credit' ? 'bad' : ''}`}>
          {PAYMENT_LABELS[p.payment]}: <strong>{money(p.cents)}</strong>
        </li>
      ))}
    </ul>
  );
}

/** Cada lotería (banca) con su venta, su comisión y sus premios. */
export function LotteryBreakdown({ rows }: { rows: { name: string; salesCents: number; commissionCents: number; prizesCents: number }[] }) {
  const { money } = useSession();
  return (
    <div className="table-wrap">
      <table className="table stack">
        <thead>
          <tr>
            <th>Lotería</th>
            <th className="num">Venta</th>
            <th className="num">Comisión</th>
            <th className="num">Premios</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(l => (
            <tr key={l.name}>
              <td>{l.name}</td>
              <td className="num" data-label="Venta">
                {money(l.salesCents)}
              </td>
              <td className="num good-text" data-label="Comisión">
                {money(l.commissionCents)}
              </td>
              <td className="num bad-text" data-label="Premios">
                {money(l.prizesCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
