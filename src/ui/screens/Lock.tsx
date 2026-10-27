import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, getSettings, saveSettings } from '../../db/database';
import type { User } from '../../db/types';
import { createUser, verifyPin } from '../../domain/users';
import { useUi } from '../context';
import { Icon } from '../icons';
import { Field, PinPad } from '../kit';

/** Primera vez que se abre: se crea la dueña con su PIN. */
export function Setup({ onDone }: { onDone: (user: User) => void }) {
  const { run } = useUi();
  const [business, setBusiness] = useState('Martina');
  const [name, setName] = useState('Martina');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [commission, setCommission] = useState('10');
  const [error, setError] = useState('');

  const submit = async () => {
    const pct = Number(commission.replace(',', '.'));
    if (!/^\d{4,6}$/.test(pin)) return setError('El PIN tiene que ser de 4 a 6 números.');
    if (pin !== pin2) return setError('Los dos PIN no son iguales.');
    if (!(pct >= 0 && pct <= 100)) return setError('La comisión tiene que estar entre 0 y 100.');
    const user = await run(async () => {
      const owner = await createUser(db, name, 'owner', pin);
      await saveSettings({ ...(await getSettings()), businessName: business.trim() || 'Martina', commissionPct: pct });
      return owner;
    });
    if (user) onDone(user);
  };

  return (
    <main className="lock-screen">
      <form
        className="card setup"
        onSubmit={e => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>¡Bienvenida!</h1>
        <p className="muted">Vamos a preparar la app. Esto se hace una sola vez.</p>
        <Field label="Nombre del negocio">{id => <input id={id} value={business} onChange={e => setBusiness(e.target.value)} />}</Field>
        <Field label="Tu nombre (la dueña)">{id => <input id={id} value={name} onChange={e => setName(e.target.value)} />}</Field>
        <div className="row2">
          <Field label="Tu PIN (4 a 6 números)">
            {id => <input id={id} type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} />}
          </Field>
          <Field label="Repite el PIN">
            {id => <input id={id} type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin2} onChange={e => setPin2(e.target.value.replace(/\D/g, ''))} />}
          </Field>
        </div>
        <Field label="Comisión de la lotería (%)" hint="Lo que te ganas de la venta de lotería del día. Se puede cambiar después.">
          {id => <input id={id} inputMode="decimal" value={commission} onChange={e => setCommission(e.target.value)} />}
        </Field>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary block" type="submit">
          Empezar
        </button>
      </form>
    </main>
  );
}

/** Pantalla de entrada: escoger quién es y poner el PIN. */
export function Lock({ onUnlock }: { onUnlock: (user: User) => void }) {
  const users = useLiveQuery(() => db.users.filter(u => u.active).toArray(), []);
  const settings = useLiveQuery(() => getSettings(), []);
  const [chosen, setChosen] = useState<User | null>(null);
  const [fails, setFails] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const user = chosen ?? (users?.length === 1 ? users[0] : null);

  if (!users) return null;
  const waiting = waitUntil > Date.now();

  return (
    <main className="lock-screen">
      <div className="card lock">
        <div className="lock-logo">
          <Icon name="lock" size={30} />
        </div>
        <h1>{settings?.businessName ?? 'Martina'}</h1>
        {!user ? (
          <>
            <p className="muted">¿Quién va a usar la app?</p>
            <div className="user-list">
              {users.map(u => (
                <button key={u.id} className="btn block" onClick={() => setChosen(u)}>
                  {u.name} <small className="muted">{u.role === 'owner' ? 'dueña' : 'empleado'}</small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p>
              Hola, <strong>{user.name}</strong>. Pon tu PIN.
            </p>
            {waiting ? (
              <p className="error-text">Muchos intentos fallidos. Espera 30 segundos.</p>
            ) : (
              <PinPad
                onSubmit={async pin => {
                  if (await verifyPin(user, pin)) {
                    onUnlock(user);
                    return true;
                  }
                  const count = fails + 1;
                  setFails(count);
                  if (count >= 5) {
                    setFails(0);
                    setWaitUntil(Date.now() + 30_000);
                    setTimeout(() => setWaitUntil(0), 30_000);
                  }
                  return false;
                }}
              />
            )}
            {users.length > 1 && (
              <button className="btn link" onClick={() => setChosen(null)}>
                No soy {user.name}
              </button>
            )}
          </>
        )}
      </div>
    </main>
  );
}
