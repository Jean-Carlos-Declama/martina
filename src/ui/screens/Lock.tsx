import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, getSettings, saveSettings } from '../../db/database';
import type { User } from '../../db/types';
import { createUser, verifyPin } from '../../domain/users';
import { useUi } from '../context';
import { Icon } from '../icons';
import { ROLE_LABELS } from '../format';
import { Field, PinPad } from '../kit';
import { LinkFromSetup } from './Devices';

/**
 * Primera vez que se abre: los datos del negocio y luego el PIN de la dueña, con el teclado de números de la app
 * (no con campos de clave: el iPhone/iPad a veces los llena solo con una "contraseña segura" sin que ella lo vea).
 */
export function Setup({ onDone }: { onDone: (user: User) => void }) {
  const { run } = useUi();
  const [step, setStep] = useState<'data' | 'pin' | 'repeat'>('data');
  const [business, setBusiness] = useState('Martina');
  const [name, setName] = useState('Martina');
  const [commission, setCommission] = useState('10');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState('');
  const pct = Number(commission.replace(',', '.'));

  if (step === 'data')
    return (
      <main className="lock-screen">
        <form
          className="card setup"
          onSubmit={e => {
            e.preventDefault();
            if (!name.trim()) return setError('Escribe tu nombre.');
            if (!(pct >= 0 && pct <= 100)) return setError('La comisión tiene que estar entre 0 y 100.');
            setError('');
            setStep('pin');
          }}
        >
          <h1>¡Bienvenida!</h1>
          <p className="muted">Vamos a preparar la app. Esto se hace una sola vez.</p>
          <Field label="Nombre del negocio">{id => <input id={id} value={business} onChange={e => setBusiness(e.target.value)} autoComplete="off" />}</Field>
          <Field label="Tu nombre (la dueña)">{id => <input id={id} value={name} onChange={e => setName(e.target.value)} autoComplete="off" />}</Field>
          <Field label="Comisión de la lotería (%)" hint="Lo que te ganas de la venta de lotería del día. Se puede cambiar después.">
            {id => <input id={id} inputMode="decimal" value={commission} onChange={e => setCommission(e.target.value)} autoComplete="off" />}
          </Field>
          {error && <p className="error-text">{error}</p>}
          <button className="btn primary block" type="submit">
            Siguiente: crear mi PIN
          </button>
          <LinkFromSetup />
        </form>
      </main>
    );

  return (
    <main className="lock-screen">
      <div className="card lock">
        <div className="lock-logo">
          <Icon name="lock" size={30} />
        </div>
        <h1>{step === 'pin' ? 'Crea tu PIN' : 'Repite tu PIN'}</h1>
        <p className="muted">
          {step === 'pin'
            ? 'Escoge de 4 a 6 números y toca ✓. Es la clave para entrar a la app: apréndetela, no se puede recuperar.'
            : 'Ponlo otra vez para confirmar.'}
        </p>
        {error && <p className="error-text">{error}</p>}
        <PinPad
          key={step}
          onSubmit={async pin => {
            if (step === 'pin') {
              setFirstPin(pin);
              setError('');
              setStep('repeat');
              return true;
            }
            if (pin !== firstPin) {
              setError('No eran iguales. Créalo otra vez.');
              setStep('pin');
              return false;
            }
            const user = await run(async () => {
              const owner = await createUser(db, name, 'owner', pin);
              await saveSettings({ ...(await getSettings()), businessName: business.trim() || 'Martina', commissionPct: pct });
              return owner;
            });
            if (user) onDone(user);
            return !!user;
          }}
        />
        <button className="btn link" onClick={() => (setError(''), setStep('data'))}>
          Volver
        </button>
      </div>
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
                  {u.name} <small className="muted">{ROLE_LABELS[u.role]}</small>
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
