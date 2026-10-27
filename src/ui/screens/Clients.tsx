import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db } from '../../db/database';
import type { Client, CreditEntry } from '../../db/types';
import { createClient, setClientActive, updateClient } from '../../domain/clients';
import { dayKeyOf } from '../../domain/common';
import { registerPayment } from '../../domain/credit';
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
  saleVoid: 'Venta anulada',
  adjust: 'Devolución / anulación',
};

export default function Clients() {
  const { money } = useSession();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'debt' | 'archived'>('all');
  const [editing, setEditing] = useState<Client | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const clients = useLiveQuery(() => db.clients.toArray(), []);

  const shown = useMemo(() => {
    const needle = normalize(search);
    return (clients ?? [])
      .filter(c => (filter === 'archived' ? !c.active : c.active) && (filter !== 'debt' || c.balanceCents > 0))
      .filter(c => !needle || normalize(c.name).includes(needle) || c.phone?.includes(needle))
      .sort((a, b) => (filter === 'debt' ? b.balanceCents - a.balanceCents : a.name.localeCompare(b.name, 'es')));
  }, [clients, search, filter]);
  const totalDebt = (clients ?? []).reduce((sum, c) => sum + Math.max(0, c.balanceCents), 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Clientes</h1>
          <p className="muted">Fiado por cobrar: {money(totalDebt)}</p>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Icon name="plus" /> Nuevo cliente
        </button>
      </header>
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
            { value: 'debt', label: 'Deben' },
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
            </li>
          ))}
        </ul>
      )}
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

function ClientDetail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (client: Client) => void }) {
  const { money, settings, user, requireOwner } = useSession();
  const { run } = useUi();
  const [paying, setPaying] = useState(false);
  const client = useLiveQuery(() => db.clients.get(id), [id]);
  const history = useLiveQuery(() => db.credit.where('[clientId+date]').between([id, ''], [id, '￿']).reverse().limit(100).toArray(), [id]);
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
  if (!client) return null;

  return (
    <Modal
      title={client.name}
      onClose={onClose}
      wide
      footer={
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
            <Icon name="edit" /> Editar
          </button>
        </>
      }
    >
      <div className="stats">
        <Stat label="Debe" value={money(Math.max(0, client.balanceCents))} tone={client.balanceCents > 0 ? 'bad' : 'plain'} big />
        {client.creditLimitCents && <Stat label="Límite de fiado" value={money(client.creditLimitCents)} />}
        {lottery && <Stat label="Lotería (30 días)" value={money(lottery.playsCents)} sub={`${plural(lottery.plays, 'jugada', 'jugadas')} · ${plural(lottery.prizes, 'premio', 'premios')} (${money(lottery.prizesCents)})`} />}
      </div>
      <p className="muted small-text">
        {client.phone ? `Tel. ${client.phone}` : 'Sin teléfono'}
        {client.notes ? ` · ${client.notes}` : ''}
      </p>
      <div className="actions wrap">
        <button className="btn primary" disabled={client.balanceCents <= 0} onClick={() => setPaying(true)}>
          <Icon name="download" /> Registrar abono
        </button>
        <button className="btn whatsapp" disabled={client.balanceCents <= 0} onClick={() => openWhatsApp(debtText(client, settings), client.phone)}>
          <Icon name="chat" /> Recordarle por WhatsApp
        </button>
      </div>
      <h3>Cuenta</h3>
      {history && history.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Qué</th>
                <th className="num">Monto</th>
                <th className="num">Quedó debiendo</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id}>
                  <td>{formatDateTime(h.date)}</td>
                  <td>
                    {CREDIT_LABELS[h.kind]}
                    {h.note ? <small className="muted"> · {h.note}</small> : null}
                  </td>
                  <td className={`num ${h.amountCents > 0 ? 'bad-text' : 'good-text'}`}>
                    {h.amountCents > 0 ? '+' : '−'}
                    {money(Math.abs(h.amountCents))}
                  </td>
                  <td className="num">{money(h.balanceAfterCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Nunca ha cogido fiado.</p>
      )}
      {paying && <PaymentModal client={client} userId={user.id} onClose={() => setPaying(false)} />}
    </Modal>
  );
}

function PaymentModal({ client, userId, onClose }: { client: Client; userId: string; onClose: () => void }) {
  const { money, settings } = useSession();
  const { run } = useUi();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const cents = parseMoney(amount);
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
            disabled={!cents}
            onClick={async () => {
              if (cents && (await run(() => registerPayment(db, client.id, cents, userId, note), `Abono de ${money(cents)} registrado`))) onClose();
            }}
          >
            Registrar abono
          </button>
        </>
      }
    >
      <p>Debe {money(client.balanceCents)}.</p>
      <div className="row2">
        <Field label="Cuánto abona">{id => <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus currency={settings.currency} />}</Field>
        <Field label="Nota (opcional)">{id => <input id={id} value={note} onChange={e => setNote(e.target.value)} />}</Field>
      </div>
      <button className="btn small" onClick={() => setAmount((client.balanceCents / 100).toFixed(2))}>
        Lo paga todo
      </button>
    </Modal>
  );
}
