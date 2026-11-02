import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db/database';
import type { Client } from '../db/types';
import { exactClient, nameKey, similarClients } from '../domain/clients';
import { passesCreditLimit } from '../domain/credit';
import { useSession } from './context';
import { balanceLabel } from './format';
import { Modal } from './kit';

// Escoger el cliente al anotar o vender fiado: que se vea lo que debe cada uno y que un nombre a medias ("Pedro") o mal
// escrito ("Pedro Gomes") no termine en una cuenta nueva mientras la deuda de "Pedro Gómez" se queda igual.

/** El color de lo que debe: rojo si debe, verde si tiene a favor. */
export const balanceTone = (cents: number) => (cents > 0 ? 'bad-text' : cents < 0 ? 'good-text' : 'muted');

/** ¿Salen clientes parecidos debajo del campo? (así la pista no dice "nombre nuevo" cuando a lo mejor no lo es). */
export function showsSuggestions(name: string, clients: Client[] | undefined): boolean {
  return !!name.trim() && !!clients && !exactClient(name, clients) && similarClients(name, clients, 1).length > 0;
}

/**
 * Debajo del campo Cliente, mientras se escribe: los clientes que empiezan o se parecen a lo escrito (aunque tenga una
 * letra mal), con lo que debe cada uno, y en la lotería también los nombres que ya se usaron. Tocar uno pone su nombre.
 * Va hecho a mano porque la lista del navegador (datalist) casi no sale en el iPad.
 */
export function ClientSuggestions({ name, clients, names = [], onPick }: { name: string; clients: Client[] | undefined; names?: string[]; onPick: (name: string) => void }) {
  const { money } = useSession();
  if (!clients || !name.trim() || exactClient(name, clients)) return null;
  const registered = new Set(clients.map(c => nameKey(c.name)));
  const others = [...new Set(names)]
    .filter(n => n.trim() && !registered.has(nameKey(n)))
    .map(n => ({ id: `nombre:${n}`, name: n, balanceCents: 0, active: true, createdAt: '' }) as Client);
  const matches = similarClients(name, [...clients, ...others], 5);
  if (matches.length === 0) return null;
  return (
    <div className="client-suggest" aria-label="Sugerencias">
      {matches.map(c => (
        <button type="button" key={c.id} className="chip" onClick={() => onPick(c.name)}>
          {c.name}
          {!c.id.startsWith('nombre:') && <small className={balanceTone(c.balanceCents)}>{balanceLabel(c.balanceCents, money)}</small>}
        </button>
      ))}
    </div>
  );
}

/**
 * Lo que debe un cliente y cómo queda si se le fía `amountCents` ("con esta venta quedará debiendo…", "le quedan … a
 * favor"), con su límite de fiado: si se pasa, lo dice y cuánto más se le puede fiar.
 */
export function CreditPreview({ client, amountCents, what }: { client: Client; amountCents?: number; what: string }) {
  const { money } = useSession();
  const balance = client.balanceCents;
  const after = balance + (amountCents ?? 0);
  const limit = client.creditLimitCents;
  return (
    <>
      {balance > 0 ? (
        <>
          {client.name} debe <strong className="bad-text">{money(balance)}</strong>
        </>
      ) : balance < 0 ? (
        <>
          {client.name} tiene <strong className="good-text">{money(-balance)}</strong> a favor
        </>
      ) : (
        <>{client.name} está al día (no debe nada)</>
      )}
      {amountCents ? (
        after > 0 ? (
          <>
            {' '}
            · con {what} quedará debiendo <strong className="bad-text">{money(after)}</strong>
          </>
        ) : after < 0 ? (
          <>
            {' '}
            · con {what} le quedan <strong className="good-text">{money(-after)}</strong> a favor
          </>
        ) : (
          <> · con {what} queda en cero</>
        )
      ) : null}
      {limit ? (
        amountCents && passesCreditLimit(client, amountCents) ? (
          <strong className="bad-text">
            {' '}
            · se pasa de su límite de {money(limit)}
            {limit - balance > 0 ? `: solo se le pueden fiar ${money(limit - balance)} más` : ''}
          </strong>
        ) : (
          <small> · límite {money(limit)}</small>
        )
      ) : null}
    </>
  );
}

/** A quién se le fía: un cliente que ya existe, o uno nuevo que se registra junto con el fiado (si no se anota, no queda registrado). */
export type CreditTarget = { client: Client } | { newClientName: string };

/**
 * Para fiar: `resolveClient(nombre, monto)` dice a quién se le fía. Si el nombre es de un cliente, ese. Si no, siempre
 * pregunta: si se parece a otros, "¿Es uno de estos?"; si no, "¿Lo registro como cliente nuevo?". null = se canceló.
 * `prompt` es la ventana de la pregunta: hay que ponerla en la pantalla.
 */
export function useCreditClient() {
  const { money } = useSession();
  const clients = useLiveQuery(() => db.clients.toArray(), []);
  const [ask, setAsk] = useState<{ name: string; amountCents: number; matches: Client[]; resolve: (choice: Client | 'new' | null) => void } | null>(null);

  const resolveClient = async (name: string, amountCents: number): Promise<CreditTarget | null> => {
    const all = clients ?? (await db.clients.toArray());
    const exact = exactClient(name, all);
    if (exact) return { client: exact };
    const matches = similarClients(name, all);
    const typed = name.trim().replace(/\s+/g, ' ');
    const choice = await new Promise<Client | 'new' | null>(resolve => setAsk({ name: typed, amountCents, matches, resolve }));
    setAsk(null);
    if (choice === null) return null;
    return choice === 'new' ? { newClientName: typed } : { client: choice };
  };

  const prompt =
    ask &&
    (ask.matches.length > 0 ? (
      <Modal title="¿A quién se le fía?" onClose={() => ask.resolve(null)}>
        <p>
          Escribiste «{ask.name}». ¿Es {ask.matches.length === 1 ? 'este cliente' : 'uno de estos clientes'}?
        </p>
        <div className="choice-list">
          {ask.matches.map(c => (
            <button key={c.id} className="btn block primary" onClick={() => ask.resolve(c)}>
              Sí, es {c.name}
              <small>{c.balanceCents === 0 ? 'no debe nada' : balanceLabel(c.balanceCents, money)}</small>
            </button>
          ))}
          <button className="btn block" onClick={() => ask.resolve('new')}>
            No, es otra persona: registrar a «{ask.name}»
          </button>
          <button className="btn link" onClick={() => ask.resolve(null)}>
            Cancelar
          </button>
        </div>
      </Modal>
    ) : (
      <Modal title="¿Cliente nuevo?" onClose={() => ask.resolve(null)}>
        <p>
          «{ask.name}» no está registrado. ¿Lo registro como cliente nuevo y le fío <strong>{money(ask.amountCents)}</strong>?
        </p>
        <div className="choice-list">
          <button className="btn block primary" onClick={() => ask.resolve('new')}>
            Sí, registrar y fiar
          </button>
          <button className="btn block" onClick={() => ask.resolve(null)}>
            No, voy a corregir el nombre
          </button>
        </div>
      </Modal>
    ));

  return { resolveClient, prompt, clients };
}
