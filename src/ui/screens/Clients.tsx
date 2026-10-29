import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useMemo, useState } from 'react';
import { db } from '../../db/database';
import type { Client, CreditEntry } from '../../db/types';
import { createClient, setClientActive, updateClient } from '../../domain/clients';
import { dayKeyOf } from '../../domain/common';
import { addCharge, clientAccount, registerPayment, updateCreditEntry, voidCreditEntry, type AccountLine } from '../../domain/credit';
import { normalize } from '../../domain/products';
import { useSession, useUi } from '../context';
import { formatPhone, formatWhen, moneyField, parseMoney, plural, shiftDay } from '../format';
import { Icon } from '../icons';
import { Empty, Field, Modal, MoneyInput, Segmented, Stat } from '../kit';
import { debtText, openWhatsApp } from '../share';

/** Qué fue cada línea de la cuenta. Las de ajuste dicen de dónde vienen (jugada corregida o anulada, devolución). */
function lineLabel(line: CreditEntry): { label: string; note?: string } {
  const note = line.note?.replace(/^(Anulación|Devolución) /, '');
  if (line.kind !== 'adjust') return { label: CREDIT_LABELS[line.kind], note: line.kind === 'saleVoid' ? note : line.note };
  if (line.note === 'Lotería corregida') return { label: line.amountCents > 0 ? 'Jugada corregida (se le sumó)' : 'Jugada corregida (se le rebajó)' };
  if (line.note === 'Lotería anulada') return { label: 'Jugada anulada' };
  if (line.note?.startsWith('Devolución ')) return { label: 'Devolución', note };
  return { label: CREDIT_LABELS.adjust, note: line.note };
}

const CREDIT_LABELS: Record<CreditEntry['kind'], string> = {
  sale: 'Fiado (tienda)',
  lottery: 'Fiado (lotería)',
  payment: 'Abono',
  charge: 'Deuda anotada a mano',
  saleVoid: 'Venta anulada',
  adjust: 'Devolución / anulación',
};

export default function Clients({ initialFilter = 'all' }: { initialFilter?: 'all' | 'debt' }) {
  const { money, canEdit, user } = useSession();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'debt' | 'archived'>(initialFilter);
  const [editing, setEditing] = useState<Client | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [paying, setPaying] = useState<Client | null>(null);
  const clients = useLiveQuery(() => db.clients.toArray(), []);

  // Quién sale en cada filtro. Un cliente que debe sale SIEMPRE en "Todos" y "Deben", aunque esté archivado.
  const inFilter = (c: Client, which: typeof filter) =>
    which === 'archived' ? !c.active : which === 'debt' ? c.balanceCents > 0 : c.active || c.balanceCents > 0;
  // El teléfono se busca solo por los números (así sirve "829-555", "829 555", "829555" o "+1 829-555-0101" de WhatsApp).
  const typedDigits = search.replace(/\D/g, '');
  const withCountry = /^\s*(\+\s*1|1[\s\-.(])/.test(search) || (typedDigits.length === 11 && typedDigits.startsWith('1'));
  const digits = withCountry ? typedDigits.slice(1) : typedDigits;
  const byPhone = digits.length >= 3 && !/\p{L}/u.test(search);
  const matches = (c: Client) => {
    const needle = normalize(search);
    return !needle || normalize(c.name).includes(needle) || (digits.length >= 3 && !!c.phone && c.phone.replace(/\D/g, '').includes(digits));
  };
  const shown = (clients ?? [])
    .filter(c => inFilter(c, filter) && matches(c))
    .sort((a, b) => (filter === 'debt' ? b.balanceCents - a.balanceCents || a.name.localeCompare(b.name, 'es') : a.name.localeCompare(b.name, 'es')));
  const debtors = (clients ?? []).filter(c => c.balanceCents > 0);
  const totalDebt = debtors.reduce((sum, c) => sum + c.balanceCents, 0);
  // Si la búsqueda no encuentra a nadie en este filtro, ¿está en otro?
  const elsewhere = shown.length === 0 && search.trim() ? (['all', 'debt', 'archived'] as const).find(f => f !== filter && (clients ?? []).some(c => inFilter(c, f) && matches(c))) : undefined;
  const filterNames = { all: 'Todos', debt: 'Deben', archived: 'Archivados' } as const;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Clientes</h1>
        {canEdit && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" /> Nuevo cliente
          </button>
        )}
      </header>
      <button className="stat-button" onClick={() => setFilter('debt')} title="Ver quién debe">
        <Stat
          label="Pendiente por cobrar"
          value={money(totalDebt)}
          tone={totalDebt > 0 ? 'bad' : 'plain'}
          big
          sub={totalDebt > 0 ? `${plural(debtors.length, 'cliente debe', 'clientes deben')} · toca para ver quiénes` : 'nadie debe'}
        />
      </button>
      <div className="toolbar">
        <div className="search-bar">
          <Icon name="search" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre o teléfono" />
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Todos' },
            { value: 'debt', label: `Deben${debtors.length ? ` (${debtors.length})` : ''}` },
            { value: 'archived', label: 'Archivados' },
          ]}
        />
      </div>
      {shown.length === 0 ? (
        <Empty
          icon="users"
          text={
            !clients?.length
              ? 'Todavía no hay clientes. Los que fían o juegan seguido conviene registrarlos.'
              : elsewhere
                ? `«${search.trim()}» no está en «${filterNames[filter]}», pero sí en «${filterNames[elsewhere]}».`
                : search.trim()
                  ? byPhone
                    ? `Nadie tiene el teléfono «${search.trim()}».`
                    : `No hay ningún cliente que se llame «${search.trim()}».`
                  : filter === 'debt'
                    ? 'Nadie debe nada.'
                    : 'Nadie con ese filtro.'
          }
        >
          {elsewhere && (
            <button className="btn" onClick={() => setFilter(elsewhere)}>
              Ver en «{filterNames[elsewhere]}»
            </button>
          )}
        </Empty>
      ) : (
        <ul className="list card clients-list">
          {shown.map(c => (
            <li key={c.id} className="client-row">
              <button className="row-button" onClick={() => setViewing(c.id)}>
                <span className="grow">
                  <strong>
                    {c.name} {!c.active && <span className="tag">archivado</span>}
                  </strong>
                  <small className="muted">{c.phone ? formatPhone(c.phone) : 'sin teléfono'}</small>
                </span>
                {/* Lo que debe, siempre a la vista y grande (en el teléfono los botones bajan a otra línea). */}
                <span className="debt">
                  <small className="muted">{c.balanceCents > 0 ? 'Debe' : c.balanceCents < 0 ? 'A favor' : 'Debe'}</small>
                  <strong className={c.balanceCents > 0 ? 'bad-text' : c.balanceCents < 0 ? 'good-text' : 'muted'}>
                    {c.balanceCents === 0 ? 'Nada (al día)' : money(Math.abs(c.balanceCents))}
                  </strong>
                </span>
              </button>
              {canEdit && (
                <span className="row-tools">
                  {c.balanceCents > 0 && (
                    <button className="btn small primary" onClick={() => setPaying(c)}>
                      Abonar
                    </button>
                  )}
                  <button className="icon-btn" onClick={() => setEditing(c)} aria-label={`Editar los datos de ${c.name}`} title="Editar datos">
                    <Icon name="edit" size={20} />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {paying && <PaymentModal client={paying} userId={user.id} onClose={() => setPaying(null)} />}
      {editing && <ClientForm client={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {viewing && (
        <ClientDetail
          id={viewing}
          onClose={() => setViewing(null)}
          onEdit={client => {
            setViewing(null);
            setEditing(client);
          }}
        />
      )}
    </div>
  );
}

function ClientForm({ client, onClose }: { client?: Client; onClose: () => void }) {
  const { user, settings } = useSession();
  const { run } = useUi();
  const [name, setName] = useState(client?.name ?? '');
  const [phone, setPhone] = useState(formatPhone(client?.phone));
  const [notes, setNotes] = useState(client?.notes ?? '');
  const [limit, setLimit] = useState(moneyField(client?.creditLimitCents));

  const save = async () => {
    const input = { name, phone, notes, creditLimitCents: parseMoney(limit) ?? undefined };
    const ok = await run(async () => {
      if (client) await updateClient(db, client.id, input, user.id);
      else await createClient(db, input, user.id);
      return true;
    }, 'Cliente guardado');
    if (ok) onClose();
  };

  return (
    <Modal
      title={client ? `Editar ${client.name}` : 'Cliente nuevo'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>
            Guardar
          </button>
        </>
      }
    >
      <Field label="Nombre">{id => <input id={id} value={name} onChange={e => setName(e.target.value)} autoFocus autoCapitalize="words" />}</Field>
      <div className="row2">
        <Field label="Teléfono / WhatsApp" hint="Para mandarle el recibo o recordarle lo que debe">
          {id => <input id={id} type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="809-000-0000" />}
        </Field>
        <Field label="Límite de fiado" hint="Vacío = sin límite">
          {id => <MoneyInput id={id} value={limit} onChange={setLimit} currency={settings.currency} />}
        </Field>
      </div>
      <Field label="Nota">{id => <input id={id} value={notes} onChange={e => setNotes(e.target.value)} />}</Field>
    </Modal>
  );
}

/** La ficha de un cliente encima de otra pantalla (ej. al tocar su nombre en la Lotería): su cuenta, abonar y editar sus datos. */
export function ClientSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const [editing, setEditing] = useState<Client | null>(null);
  return editing ? <ClientForm client={editing} onClose={() => setEditing(null)} /> : <ClientDetail id={id} onClose={onClose} onEdit={setEditing} />;
}

type Period = 'all' | 'month' | 'last';

/** El mes de una fecha (AAAA-MM) y el del mes pasado. */
const monthOf = (iso: string) => dayKeyOf(new Date(iso)).slice(0, 7);
function lastMonthKey(): string {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  return dayKeyOf(date).slice(0, 7);
}

function ClientDetail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (client: Client) => void }) {
  const { money, settings, user, canEdit, requireOwner } = useSession();
  const { run, askText, confirm } = useUi();
  const [paying, setPaying] = useState(false);
  const [charging, setCharging] = useState(false);
  const [editingEntry, setEditingEntry] = useState<{ entry: AccountLine; ownerId: string } | null>(null);
  const [period, setPeriod] = useState<Period>('all');
  const client = useLiveQuery(() => db.clients.get(id), [id]);
  const account = useLiveQuery(() => clientAccount(db, id), [id]);
  const lottery = useLiveQuery(async () => {
    const since = shiftDay(dayKeyOf(), -30);
    const plays = (await db.lottery.where('clientId').equals(id).toArray()).filter(e => e.status === 'done' && e.dayKey >= since);
    const prizes = (await db.prizes.where('clientId').equals(id).toArray()).filter(p => p.status === 'done' && p.dayKey >= since);
    return {
      plays: plays.length,
      playsCents: plays.reduce((s, e) => s + e.amountCents, 0),
      prizes: prizes.length,
      prizesCents: prizes.reduce((s, p) => s + p.amountCents, 0),
    };
  }, [id]);
  const shown = useMemo(() => {
    const thisMonth = dayKeyOf().slice(0, 7);
    const wanted = period === 'month' ? thisMonth : period === 'last' ? lastMonthKey() : null;
    return (account ?? []).filter(line => !wanted || monthOf(line.date) === wanted).reverse();
  }, [account, period]);
  // Viendo un mes: lo que venía debiendo (o tenía a favor) de antes, para que cuadre con lo de arriba.
  const carried = useMemo(() => {
    if (period === 'all') return 0;
    const wanted = period === 'month' ? dayKeyOf().slice(0, 7) : lastMonthKey();
    const before = (account ?? []).filter(line => monthOf(line.date) < wanted);
    return before.length ? before[before.length - 1].runningCents : 0;
  }, [account, period]);
  // Ventas y jugadas fiadas que ya se anularon (la cuenta tiene la línea que las quita): ya no hay nada que corregir.
  const voidedOrigins = useMemo(
    () => new Set((account ?? []).filter(l => l.kind === 'saleVoid' || (l.kind === 'adjust' && l.note === 'Lotería anulada')).map(l => l.saleId)),
    [account],
  );
  if (!client) return null;

  const startEdit = async (entry: AccountLine) => {
    const owner = await requireOwner('Corregir la cuenta: autorización de la dueña');
    if (owner) setEditingEntry({ entry, ownerId: owner.id });
  };
  const cancelEntry = async (entry: AccountLine) => {
    // Si anularla lo deja debiendo menos de cero, se dice antes (y no se pide el PIN ni el motivo para nada).
    const change = -entry.amountCents;
    if (change < 0 && client.balanceCents + change < 0) {
      await confirm({
        title: 'No se puede anular',
        message: `Si se anula, ${client.name} quedaría debiendo menos de cero. Corrige el monto con el lápiz, o anula primero el abono que lo compensa.`,
        okText: 'Entendido',
        noCancel: true,
      });
      return;
    }
    const owner = await requireOwner('Anular: autorización de la dueña');
    if (!owner) return;
    const reason = await askText({
      title: entry.kind === 'payment' ? 'Anular abono' : 'Anular deuda',
      message: `${formatWhen(entry.date)} · ${money(Math.abs(entry.amountCents))}`,
      label: '¿Por qué se anula?',
      okText: 'Anular',
      danger: true,
    });
    if (reason) await run(() => voidCreditEntry(db, entry.id, owner.id, reason), 'Anulado: la cuenta se recalculó');
  };

  return (
    <Modal
      title={client.name}
      onClose={onClose}
      wide
      footer={
        canEdit && (
          <>
            <button
              className="btn"
              onClick={async () => {
                const owner = await requireOwner();
                if (owner) await run(() => setClientActive(db, client.id, !client.active, owner.id), client.active ? 'Cliente archivado' : 'Cliente reactivado');
              }}
            >
              {client.active ? 'Archivar' : 'Reactivar'}
            </button>
            <button className="btn" onClick={() => onEdit(client)}>
              <Icon name="edit" /> Editar datos
            </button>
          </>
        )
      }
    >
      <div className="stats">
        {client.balanceCents < 0 ? (
          <Stat label="A favor del cliente" value={money(-client.balanceCents)} tone="good" big sub="pagó de más: no debe nada" />
        ) : (
          <Stat label="Pendiente por cobrar" value={money(client.balanceCents)} tone={client.balanceCents > 0 ? 'bad' : 'plain'} big sub={client.balanceCents > 0 ? undefined : 'no debe nada'} />
        )}
        {client.creditLimitCents ? <Stat label="Límite de fiado" value={money(client.creditLimitCents)} /> : null}
        {lottery && <Stat label="Lotería (30 días)" value={money(lottery.playsCents)} sub={`${plural(lottery.plays, 'jugada', 'jugadas')} · ${plural(lottery.prizes, 'premio', 'premios')} (${money(lottery.prizesCents)})`} />}
      </div>
      <p className="muted small-text">
        {client.phone ? `Tel. ${formatPhone(client.phone)}` : 'Sin teléfono'}
        {client.notes ? ` · ${client.notes}` : ''}
        {!client.active ? ' · archivado' : ''}
      </p>
      {canEdit && (
        <div className="actions wrap">
          <button className="btn primary" disabled={client.balanceCents <= 0} onClick={() => setPaying(true)}>
            <Icon name="download" /> Registrar abono
          </button>
          <button
            className="btn"
            onClick={async () => {
              if (await requireOwner('Anotar deuda: autorización de la dueña')) setCharging(true);
            }}
          >
            <Icon name="plus" /> Anotar deuda a mano
          </button>
          <button className="btn whatsapp" disabled={client.balanceCents <= 0} onClick={() => openWhatsApp(debtText(client, settings), client.phone)}>
            <Icon name="chat" /> Recordarle por WhatsApp
          </button>
        </div>
      )}
      <div className="card-head">
        <h3>Cuenta</h3>
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[
            { value: 'all', label: 'Todo' },
            { value: 'month', label: 'Este mes' },
            { value: 'last', label: 'Mes pasado' },
          ]}
        />
      </div>
      {shown.length > 0 ? (
        // En el teléfono cada línea de la cuenta se vuelve una tarjetita (qué y monto arriba, fecha y lo que quedó debiendo abajo).
        <div className="table-wrap account-wrap">
          <table className="table account">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Qué</th>
                <th className="num">Monto</th>
                <th className="num">Quedó debiendo</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {shown.map(h => {
                const manual = h.kind === 'payment' || h.kind === 'charge';
                return (
                  <tr key={h.id} className={h.status === 'void' ? 'voided' : ''}>
                    <td className="when">{formatWhen(h.date)}</td>
                    <td className="what">
                      {lineLabel(h).label}
                      {lineLabel(h).note ? <small className="muted"> · {lineLabel(h).note}</small> : null}
                      {h.status === 'void' ? <small className="muted"> · ANULADO</small> : null}
                      {(h.kind === 'sale' || h.kind === 'lottery') &&
                        h.status !== 'void' &&
                        (voidedOrigins.has(h.saleId) ? (
                          <small className="muted"> · anulada</small>
                        ) : (
                          canEdit && <small className="muted"> · se corrige en {h.kind === 'lottery' ? 'Lotería' : 'Ventas'}</small>
                        ))}
                    </td>
                    <td className={`num amt ${h.amountCents > 0 ? 'bad-text' : 'good-text'}`}>
                      {h.amountCents > 0 ? '+' : '−'}
                      {money(Math.abs(h.amountCents))}
                    </td>
                    <td className="num after">
                      {h.runningCents < 0 ? (
                        <span className="good-text">a favor {money(-h.runningCents)}</span>
                      ) : (
                        <>
                          <small className="mobile-only">quedó debiendo </small>
                          {money(h.runningCents)}
                        </>
                      )}
                    </td>
                    {canEdit && (
                      <td className="row-actions acts">
                        {manual && h.status !== 'void' && (
                          <>
                            <button className="icon-btn" onClick={() => void startEdit(h)} aria-label="Corregir">
                              <Icon name="edit" size={18} />
                            </button>
                            <button className="icon-btn" onClick={() => void cancelEntry(h)} aria-label="Anular">
                              <Icon name="trash" size={18} />
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {carried !== 0 && (
            <p className="muted small-text">{carried > 0 ? `Venía debiendo de antes: ${money(carried)}` : `Tenía a favor de antes: ${money(-carried)}`}</p>
          )}
        </div>
      ) : (
        <p className="muted">
          {!account?.length
            ? 'Nunca ha cogido fiado.'
            : client.balanceCents > 0
              ? `Nada en ese mes. Lo que debe (${money(client.balanceCents)}) viene de otros meses: toca «Todo».`
              : 'Nada en ese mes.'}
        </p>
      )}
      {paying && <PaymentModal client={client} userId={user.id} onClose={() => setPaying(false)} />}
      {charging && <ChargeModal client={client} userId={user.id} onClose={() => setCharging(false)} />}
      {editingEntry && <EditCreditModal entry={editingEntry.entry} client={client} ownerId={editingEntry.ownerId} onClose={() => setEditingEntry(null)} />}
    </Modal>
  );
}

/** Sugerencias de siempre (van después de las que ya se usaron). */
const COMMON_NOTES: Record<'payment' | 'charge', string[]> = {
  payment: ['Pagó en efectivo', 'Pagó por transferencia', 'Abono de la quincena'],
  charge: ['Lo que debía en la libreta', 'Fiado que no se anotó', 'Préstamo', 'Lotería fiada', 'Compra en la tienda'],
};

/**
 * Campo de nota con sugerencias: al escribir salen las notas que ya se usaron antes (de cualquier cliente), las más
 * nuevas primero, para no escribir lo mismo cada vez.
 */
function NoteField(props: { label: string; kind: 'payment' | 'charge'; value: string; onChange: (value: string) => void; placeholder?: string }) {
  const listId = useId();
  const notes = useLiveQuery(async () => {
    const rows = await db.credit
      .orderBy('date')
      .reverse()
      .filter(e => e.kind === props.kind && !!e.note?.trim())
      .limit(300)
      .toArray();
    return [...new Set([...rows.map(r => r.note!.trim()), ...COMMON_NOTES[props.kind]])].slice(0, 60);
  }, [props.kind]);
  return (
    <Field label={props.label} hint="Al escribir te sugiere lo que ya usaste antes">
      {id => (
        <>
          <input id={id} list={listId} autoComplete="off" value={props.value} onChange={e => props.onChange(e.target.value)} placeholder={props.placeholder} />
          <datalist id={listId}>
            {notes?.map(n => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </>
      )}
    </Field>
  );
}

/** El día de un abono o una deuda: hoy, o uno anterior (ayer, el mes pasado...). */
function DayField({ value, onChange }: { value: string; onChange: (dayKey: string) => void }) {
  const today = dayKeyOf();
  return (
    <Field label="Fecha" hint={value !== today ? 'Se anota con esa fecha' : undefined}>
      {id => <input id={id} type="date" value={value} max={today} onChange={e => e.target.value && e.target.value <= today && onChange(e.target.value)} />}
    </Field>
  );
}

function PaymentModal({ client, userId, onClose }: { client: Client; userId: string; onClose: () => void }) {
  const { money, settings } = useSession();
  const { run } = useUi();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [day, setDay] = useState(dayKeyOf());
  const cents = parseMoney(amount);
  const left = client.balanceCents - (cents ?? 0);
  return (
    <Modal
      title={`Abono de ${client.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn primary"
            disabled={!cents || left < 0}
            onClick={async () => {
              const done = await run(
                () => registerPayment(db, client.id, cents!, userId, note, day),
                left > 0 ? `Abono de ${money(cents!)}: ${client.name} queda debiendo ${money(left)}` : `${client.name} pagó todo`,
              );
              if (done) onClose();
            }}
          >
            Registrar abono
          </button>
        </>
      }
    >
      <div className="stats">
        <Stat label="Debe ahora" value={money(client.balanceCents)} tone="bad" />
        <Stat
          label="Después del abono"
          value={!cents ? '—' : left < 0 ? '—' : money(left)}
          tone={!cents ? 'plain' : left < 0 ? 'bad' : left === 0 ? 'good' : 'plain'}
          big
          sub={cents && left === 0 ? 'queda al día' : undefined}
        />
      </div>
      {cents !== null && left < 0 && (
        <p className="error-text">
          Son {money(-left)} de más: {client.name} solo debe {money(client.balanceCents)}.
        </p>
      )}
      <div className="row3">
        <Field label="Cuánto abona">{id => <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus currency={settings.currency} />}</Field>
        <DayField value={day} onChange={setDay} />
        <NoteField label="Nota (opcional)" kind="payment" value={note} onChange={setNote} />
      </div>
      <button className="btn small" onClick={() => setAmount((client.balanceCents / 100).toFixed(2))}>
        Lo paga todo
      </button>
    </Modal>
  );
}

/** Anotar a mano algo que el cliente debe (ej. lo que traía de la libreta), con su fecha. */
function ChargeModal({ client, userId, onClose }: { client: Client; userId: string; onClose: () => void }) {
  const { money, settings } = useSession();
  const { run } = useUi();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [day, setDay] = useState(dayKeyOf());
  const cents = parseMoney(amount);
  const after = client.balanceCents + (cents ?? 0);
  return (
    <Modal
      title={`Anotar deuda de ${client.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn primary"
            disabled={!cents || !note.trim()}
            onClick={async () => {
              const done = await run(
                () => addCharge(db, client.id, cents!, userId, note, day),
                after > 0 ? `Anotado: ${client.name} debe ${money(after)}` : after < 0 ? `Anotado: a ${client.name} le quedan ${money(-after)} a favor` : `Anotado: ${client.name} queda al día`,
              );
              if (done) onClose();
            }}
          >
            Anotar deuda
          </button>
        </>
      }
    >
      <p className="muted">Para lo que debía antes de usar la app, o algo que se fió y no se anotó. Lo de una venta o una jugada se anota allá.</p>
      <div className="stats">
        <BalanceStat labels={['Debe ahora', 'Tiene a favor']} cents={client.balanceCents} />
        <BalanceStat labels={['Con esta deuda queda debiendo', 'Con esta deuda le queda a favor']} cents={cents ? after : null} big />
      </div>
      <Field label="Cuánto se le anota (solo lo nuevo)">{id => <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus currency={settings.currency} />}</Field>
      <div className="row2">
        <DayField value={day} onChange={setDay} />
        <NoteField label="De qué es (obligatorio)" kind="charge" value={note} onChange={setNote} placeholder="Ej. lo de la libreta" />
      </div>
    </Modal>
  );
}

/** "Debe ahora RD$ X" en rojo, "Tiene a favor RD$ X" en verde, o "Nada (al día)"; "—" si todavía no hay monto. */
function BalanceStat({ labels: [owes, favor], cents, big }: { labels: [string, string]; cents: number | null; big?: boolean }) {
  const { money } = useSession();
  if (cents === null) return <Stat label={owes} value="—" big={big} />;
  return cents < 0 ? (
    <Stat label={favor} value={money(-cents)} tone="good" big={big} />
  ) : (
    <Stat label={owes} value={cents === 0 ? 'Nada (al día)' : money(cents)} tone={cents > 0 ? 'bad' : 'plain'} big={big} />
  );
}

/** Corregir un abono o una deuda a mano (monto, fecha, nota): lo que debe se recalcula solo. */
function EditCreditModal({ entry, client, ownerId, onClose }: { entry: AccountLine; client: Client; ownerId: string; onClose: () => void }) {
  const { money, settings } = useSession();
  const { run } = useUi();
  const isPayment = entry.kind === 'payment';
  const [amount, setAmount] = useState(moneyField(Math.abs(entry.amountCents)));
  const [day, setDay] = useState(dayKeyOf(new Date(entry.date)));
  const [note, setNote] = useState(entry.note ?? '');
  const cents = parseMoney(amount);
  const diff = cents ? (isPayment ? -cents : cents) - entry.amountCents : 0;
  const after = client.balanceCents + diff;
  // Solo se frena un cambio que baja lo que debe por debajo de cero (con saldo a favor se puede corregir la fecha o la nota).
  const blocked = diff < 0 && after < 0;
  return (
    <Modal
      title={isPayment ? 'Corregir abono' : 'Corregir deuda'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn primary"
            disabled={!cents || (!isPayment && !note.trim()) || blocked}
            onClick={async () => {
              const done = await run(async () => (await updateCreditEntry(db, entry.id, { amountCents: cents!, dayKey: day, note }, ownerId), true), 'Corregido: la cuenta se recalculó');
              if (done) onClose();
            }}
          >
            Guardar
          </button>
        </>
      }
    >
      <p className="muted">
        Antes: {formatWhen(entry.date)} · {money(Math.abs(entry.amountCents))}.
      </p>
      <div className="stats">
        <BalanceStat labels={['Debe ahora', 'Tiene a favor']} cents={client.balanceCents} />
        <BalanceStat labels={['Con el cambio queda debiendo', 'Con el cambio le queda a favor']} cents={cents && !blocked ? after : null} big />
      </div>
      {cents !== null && blocked && (
        <p className="error-text">
          Así a {client.name} le quedarían {money(-after)} a favor{client.balanceCents < 0 ? ` (ahora tiene ${money(-client.balanceCents)})` : ''}:{' '}
          {isPayment ? 'el abono no puede ser más de lo que debía' : 'la deuda no puede bajar tanto'}. Revisa el monto.
        </p>
      )}
      <Field label={isPayment ? 'Cuánto abonó' : 'Monto de esta deuda'}>{id => <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus currency={settings.currency} />}</Field>
      <div className="row2">
        <DayField value={day} onChange={setDay} />
        <NoteField label={isPayment ? 'Nota (opcional)' : 'De qué es (obligatorio)'} kind={isPayment ? 'payment' : 'charge'} value={note} onChange={setNote} />
      </div>
    </Modal>
  );
}
