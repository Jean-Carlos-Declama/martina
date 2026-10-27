import { useEffect, useId, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { useBlobUrl } from './photo';

// Piezas de pantalla que se repiten: ventanas, campos, teclado del PIN, tarjetas de números.

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onPointerDown={e => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <header className="modal-head">
          <h2>{props.title}</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label="Cerrar">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer && <footer className="modal-foot">{props.footer}</footer>}
      </div>
    </div>
  );
}

export function Field(props: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={`field ${props.className ?? ''}`}>
      <label htmlFor={id}>{props.label}</label>
      {props.children(id)}
      {props.hint && <small className="hint">{props.hint}</small>}
    </div>
  );
}

/** Campo de dinero: el teclado numérico del iPad y "RD$" delante. Guarda el texto; se convierte al guardar. */
export function MoneyInput(props: { id?: string; value: string; onChange: (text: string) => void; placeholder?: string; autoFocus?: boolean; currency?: string }) {
  return (
    <div className="money-input">
      <span>{props.currency ?? 'RD$'}</span>
      <input
        id={props.id}
        inputMode="decimal"
        autoComplete="off"
        value={props.value}
        placeholder={props.placeholder ?? '0.00'}
        autoFocus={props.autoFocus}
        onChange={e => props.onChange(e.target.value.replace(/[^\d.,]/g, ''))}
      />
    </div>
  );
}

export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {props.options.map(o => (
        <button key={o.value} role="tab" aria-selected={props.value === o.value} className={props.value === o.value ? 'on' : ''} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat(props: { label: string; value: string; tone?: 'good' | 'bad' | 'accent' | 'plain'; sub?: string; big?: boolean }) {
  return (
    <div className={`stat ${props.tone ?? 'plain'}${props.big ? ' big' : ''}`}>
      <span className="stat-label">{props.label}</span>
      <strong className="stat-value">{props.value}</strong>
      {props.sub && <span className="stat-sub">{props.sub}</span>}
    </div>
  );
}

export function Empty(props: { icon: IconName; text: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={props.icon} size={40} />
      <p>{props.text}</p>
      {props.children}
    </div>
  );
}

export function PhotoThumb(props: { photo?: Blob; name: string; size?: number }) {
  const url = useBlobUrl(props.photo);
  const size = props.size ?? 48;
  return url ? (
    <img className="thumb" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className="thumb placeholder" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {props.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/**
 * Teclado para el PIN (4 a 6 números). También sirve el teclado físico. `onSubmit` dice si se aceptó; si no, vibra
 * y se borra.
 */
export function PinPad(props: { onSubmit: (pin: string) => Promise<boolean>; busyText?: string; autoLength?: number }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  const submit = async (value: string) => {
    if (value.length < 4 || busy) return;
    setBusy(true);
    const ok = await props.onSubmit(value);
    setBusy(false);
    if (!ok) {
      setShake(true);
      setPin('');
      setTimeout(() => setShake(false), 400);
    }
  };
  const press = (digit: string) => {
    if (busy) return;
    const next = (pin + digit).slice(0, 6);
    setPin(next);
    if (props.autoLength && next.length === props.autoLength) void submit(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin(p => p.slice(0, -1));
      else if (e.key === 'Enter') void submit(pin);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="pinpad">
      <div className={`pin-dots${shake ? ' shake' : ''}`} aria-live="polite" aria-label={`${pin.length} números escritos`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span key={i} className={i < pin.length ? 'on' : ''} />
        ))}
      </div>
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
          <button key={d} onClick={() => press(d)} disabled={busy}>
            {d}
          </button>
        ))}
        <button className="muted" onClick={() => setPin(p => p.slice(0, -1))} disabled={busy} aria-label="Borrar">
          ⌫
        </button>
        <button onClick={() => press('0')} disabled={busy}>
          0
        </button>
        <button className="go" onClick={() => void submit(pin)} disabled={busy || pin.length < 4} aria-label="Entrar">
          <Icon name="check" />
        </button>
      </div>
      {busy && props.busyText && <p className="hint center">{props.busyText}</p>}
    </div>
  );
}
