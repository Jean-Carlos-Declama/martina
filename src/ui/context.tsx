import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Settings, User } from '../db/types';
import { db } from '../db/database';
import { BusinessError, formatMoney } from '../domain/common';
import { ownerByPin } from '../domain/users';
import { Modal, PinPad } from './kit';

// Lo que todas las pantallas comparten: quién está usando la app, los ajustes, avisos y preguntas.

type Tone = 'ok' | 'error';
interface ConfirmOptions {
  title: string;
  message?: string;
  okText?: string;
  danger?: boolean;
}
interface TextOptions extends ConfirmOptions {
  label: string;
  placeholder?: string;
  initial?: string;
}

type Dialog =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ kind: 'text'; resolve: (value: string | null) => void } & TextOptions)
  | { kind: 'owner'; title: string; resolve: (owner: User | null) => void };

interface Ui {
  toast: (text: string, tone?: Tone) => void;
  /** Corre una acción: si falla, muestra el porqué. Devuelve su resultado (o undefined si falló). */
  run: <T>(action: () => Promise<T>, okText?: string) => Promise<T | undefined>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  askText: (options: TextOptions) => Promise<string | null>;
  /** Pide el PIN de la dueña (para lo que el empleado no puede hacer solo). */
  askOwner: (title?: string) => Promise<User | null>;
}

const UiContext = createContext<Ui | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: Tone }[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const counter = useRef(0);

  const toast = useCallback((text: string, tone: Tone = 'ok') => {
    const id = ++counter.current;
    setToasts(list => [...list.slice(-1), { id, text, tone }]);
    setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), tone === 'error' ? 5000 : 2000);
  }, []);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      try {
        const result = await action();
        if (okText) toast(okText);
        return result;
      } catch (error) {
        if (error instanceof BusinessError) toast(error.message, 'error');
        else {
          console.error(error);
          toast(`Algo falló: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
        return undefined;
      }
    },
    [toast],
  );

  const ui = useMemo<Ui>(
    () => ({
      toast,
      run,
      confirm: options => new Promise(resolve => setDialog({ kind: 'confirm', ...options, resolve })),
      askText: options => new Promise(resolve => setDialog({ kind: 'text', ...options, resolve })),
      askOwner: (title = 'Autorización de la dueña') => new Promise(resolve => setDialog({ kind: 'owner', title, resolve })),
    }),
    [toast, run],
  );

  const close = () => setDialog(null);
  return (
    <UiContext.Provider value={ui}>
      {children}
      {dialog?.kind === 'confirm' && <ConfirmDialog dialog={dialog} close={close} />}
      {dialog?.kind === 'text' && <TextDialog dialog={dialog} close={close} />}
      {dialog?.kind === 'owner' && (
        <Modal title={dialog.title} onClose={() => (dialog.resolve(null), close())}>
          <p className="center">Que la dueña ponga su PIN.</p>
          <PinPad
            onSubmit={async pin => {
              const owner = await ownerByPin(db, pin);
              if (!owner) return false;
              dialog.resolve(owner);
              close();
              return true;
            }}
          />
        </Modal>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
            {t.text}
          </div>
        ))}
      </div>
    </UiContext.Provider>
  );
}

function ConfirmDialog({ dialog, close }: { dialog: Extract<Dialog, { kind: 'confirm' }>; close: () => void }) {
  const answer = (ok: boolean) => {
    dialog.resolve(ok);
    close();
  };
  return (
    <Modal
      title={dialog.title}
      onClose={() => answer(false)}
      footer={
        <>
          <button className="btn" onClick={() => answer(false)}>
            Cancelar
          </button>
          <button className={`btn ${dialog.danger ? 'danger' : 'primary'}`} onClick={() => answer(true)} autoFocus>
            {dialog.okText ?? 'Sí'}
          </button>
        </>
      }
    >
      {dialog.message && <p className="pre">{dialog.message}</p>}
    </Modal>
  );
}

function TextDialog({ dialog, close }: { dialog: Extract<Dialog, { kind: 'text' }>; close: () => void }) {
  const [value, setValue] = useState(dialog.initial ?? '');
  const answer = (text: string | null) => {
    dialog.resolve(text);
    close();
  };
  return (
    <Modal
      title={dialog.title}
      onClose={() => answer(null)}
      footer={
        <>
          <button className="btn" onClick={() => answer(null)}>
            Cancelar
          </button>
          <button className={`btn ${dialog.danger ? 'danger' : 'primary'}`} disabled={!value.trim()} onClick={() => answer(value.trim())}>
            {dialog.okText ?? 'Aceptar'}
          </button>
        </>
      }
    >
      {dialog.message && <p className="pre">{dialog.message}</p>}
      <form
        onSubmit={e => {
          e.preventDefault();
          if (value.trim()) answer(value.trim());
        }}
      >
        <div className="field">
          <label htmlFor="ask-text">{dialog.label}</label>
          <input id="ask-text" value={value} placeholder={dialog.placeholder} onChange={e => setValue(e.target.value)} autoFocus />
        </div>
      </form>
    </Modal>
  );
}

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('useUi fuera de UiProvider');
  return ui;
}

interface Session {
  user: User;
  settings: Settings;
  isOwner: boolean;
  money: (cents: number) => string;
  lock: () => void;
  /** La dueña: si es ella la que está, enseguida; si es el empleado, pide el PIN de ella. */
  requireOwner: (title?: string) => Promise<User | null>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider(props: { user: User; settings: Settings; lock: () => void; children: ReactNode }) {
  const { askOwner } = useUi();
  const { user, settings, lock } = props;
  const session = useMemo<Session>(
    () => ({
      user,
      settings,
      isOwner: user.role === 'owner',
      money: cents => formatMoney(cents, settings.currency),
      lock,
      requireOwner: async title => (user.role === 'owner' ? user : askOwner(title)),
    }),
    [user, settings, lock, askOwner],
  );
  return <SessionContext.Provider value={session}>{props.children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession fuera de SessionProvider');
  return session;
}
