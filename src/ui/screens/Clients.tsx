import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db } from '../../db/database';
import type { Client, CreditEntry } from '../../db/types';
import { createClient, setClientActive, updateClient } from '../../domain/clients';
import { dayKeyOf } from '../../domain/common';
import { addCharge, clientAccount, registerPayment, updateCreditEntry, voidCreditEntry, type AccountLine } from '../../domain/credit';
import { normalize } from '../../domain/products';
import { useSession, useUi } from '../context';
import { formatDateTime, moneyField, parseMoney, plural, shiftDay } from '../format';
import { Icon } from '../icons';
import { Empty, Field, Modal, MoneyInput, Segmented, Stat } from '../kit';
import { debtText, openWhatsApp } from '../share';

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

  const shown = useMemo(() => {
    const needle = normalize(search);
    return (clients ?? [])
      .filter(c => (filter === 'archived' ? !c.active : c.active) && (filter !== 'debt' || c.balanceCents > 0))
      .filter(c => !needle || normalize(c.name).includes(needle) || c.phone?.includes(needle))
      .sort((a, b) => (filter === 'debt' ? b.balanceCents - a.balanceCents : a.name.localeCompare(b.name, 'es')));
  }, [clients, search, filter]);
  const debtors = (clients ?? []).filter(c => c.active && c.balanceCents > 0);
  const totalDebt = debtors.reduce((sum, c) => sum + c.balanceCents, 0);

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
        <Empty icon="users" text={clients?.length ? 'Nadie con ese filtro.' : 'Todavía no hay clientes. Los que fían o juegan seguido conviene registrarlos.'} />
      ) : (
        <ul className="list card">
          {shown.map(c => (
            <li key={c.id}>
              <button className="row-button" onClick={() => setViewing(c.id)}>
                <span className="grow">
                  <strong>{c.name}</strong>
                  <small className="muted">{c.phone ?? 'sin teléfono'}</small>
                </span>
                <span className={`amount ${c.balanceCents > 0 ? 'bad-text' : c.balanceCents < 0 ? 'good-text' : 'muted'}`}>
                  {c.balanceCents > 0 ? `debe ${money(c.balanceCents)}` : c.balanceCents < 0 ? `a favor ${money(-c.balanceCents)}` : 'al día'}
                </span>
              </button>
              {canEdit && c.balanceCents > 0 && (
                <button className="btn small primary" onClick={() => setPaying(c)}>
                  Abonar
                </button>
              )}
              {canEdit && (
                <button className="icon-btn" onClick={() => setEditing(c)} aria-label={`Editar los datos de ${c.name}`} title="Editar datos">
                  <Icon name="edit" size={20} />
                </button>
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
  const [phone, setPhone] = useState(client?.phone ?? '');
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
  const { run, askText } = useUi();
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
  if (!client) return null;

  const startEdit = async (entry: AccountLine) => {
    const owner = await requireOwner('Corregir la cuenta: autorización de la dueña');
    if (owner) setEditingEntry({ entry, ownerId: owner.id });
  };
  const cancelEntry = async (entry: AccountLine) => {
    const owner = await requireOwner('Anular: autorización de la dueña');
    if (!owner) return;
    const reason = await askText({
      title: entry.kind === 'payment' ? 'Anular abono' : 'Anular deuda',
      message: `${formatDateTime(entry.date)} · ${money(Math.abs(entry.amountCents))}`,
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
        <Stat label="Pendiente por cobrar" value={money(Math.max(0, client.balanceCents))} tone={client.balanceCents > 0 ? 'bad' : 'plain'} big />
        {client.creditLimitCents && <Stat label="Límite de fiado" value={money(client.creditLimitCents)} />}
        {lottery && <Stat label="Lotería (30 días)" value={money(lottery.playsCents)} sub={`${plural(lottery.plays, 'jugada', 'jugadas')} · ${plural(lottery.prizes, 'premio', 'premios')} (${money(lottery.prizesCents)})`} />}
      </div>
      <p className="muted small-text">
        {client.phone ? `Tel. ${client.phone}` : 'Sin teléfono'}
        {client.notes ? ` · ${client.notes}` : ''}
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
        <div className="table-wrap">
          <table className="table">
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
                    <td>{formatDateTime(h.date)}</td>
                    <td>
                      {CREDIT_LABELS[h.kind]}
                      {h.note ? <small className="muted"> · {h.note}</small> : null}
                      {h.status === 'void' ? <small className="muted"> · ANULADO</small> : null}
                      {canEdit && !manual && h.status !== 'void' && <small className="muted"> · se corrige en {h.kind === 'lottery' ? 'Lotería' : 'Ventas'}</small>}
                    </td>
                    <td className={`num ${h.amountCents > 0 ? 'bad-text' : 'good-text'}`}>
                      {h.amountCents > 0 ? '+' : '−'}
                      {money(Math.abs(h.amountCents))}
                    </td>
                    <td className="num">{money(h.runningCents)}</td>
                    {canEdit && (
                      <td className="row-actions">
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
        </div>
      ) : (
        <p className="muted">{account?.length ? 'Nada en ese mes.' : 'Nunca ha cogido fiado.'}</p>
      )}
      {paying && <PaymentModal client={client} userId={user.id} onClose={() => setPaying(false)} />}
      {charging && <ChargeModal client={client} userId={user.id} onClose={() => setCharging(false)} />}
      {editingEntry && <EditCreditModal entry={editingEntry.entry} client={client} ownerId={editingEntry.ownerId} onClose={() => setEditingEntry(null)} />}
    </Modal>
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
        <Stat label="Después del abono" value={cents ? money(Math.max(0, left)) : '—'} tone={cents && left === 0 ? 'good' : 'plain'} big sub={left < 0 ? 'Es más de lo que debe' : undefined} />
      </div>
      <div className="row3">
        <Field label="Cuánto abona">{id => <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus currency={settings.currency} />}</Field>
        <DayField value={day} onChange={setDay} />
        <Field label="Nota (opcional)">{id => <input id={id} value={note} onChange={e => setNote(e.target.value)} />}</Field>
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
              const done = await run(() => addCharge(db, client.id, cents!, userId, note, day), `Anotado: ${client.name} debe ${money(client.balanceCents + cents!)}`);
              if (done) onClose();
            }}
          >
            Anotar deuda
          </button>
        </>
      }
    >
      <p className="muted">Para lo que debía antes de usar la app, o algo que se fió y no se anotó. Lo de una venta o una jugada se anota allá.</p>
      <div className="row3">
        <Field label="Cuánto debe">{id => <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus currency={settings.currency} />}</Field>
        <DayField value={day} onChange={setDay} />
        <Field label="De qué es">{id => <input id={id} value={note} onChange={e => setNote(e.target.value)} placeholder="Ej. lo que debía en la libreta" />}</Field>
      </div>
    </Modal>
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
            disabled={!cents || (!isPayment && !note.trim())}
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
        Antes: {formatDateTime(entry.date)} · {money(Math.abs(entry.amountCents))}.{' '}
        {cents ? `Con el cambio, ${client.name} queda debiendo ${money(client.balanceCents + diff)}.` : ''}
      </p>
      <div className="row3">
        <Field label={isPayment ? 'Cuánto abonó' : 'Cuánto debe'}>{id => <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus currency={settings.currency} />}</Field>
        <DayField value={day} onChange={setDay} />
        <Field label={isPayment ? 'Nota (opcional)' : 'De qué es'}>{id => <input id={id} value={note} onChange={e => setNote(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}
