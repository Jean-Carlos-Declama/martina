import { useLiveQuery, useObservable } from 'dexie-react-hooks';
import { lazy, Suspense, useEffect, useState } from 'react';
import { db, getDeviceLocal } from '../../db/database';
import {
  activateMainDevice,
  blockDevice,
  cloudEnabled,
  defaultDeviceName,
  isLinked,
  linkToBusiness,
  linkUrl,
  parseLinkCode,
  unlinkThisDevice,
} from '../../db/cloud';
import { useSession, useUi } from '../context';
import { formatDateTime } from '../format';
import { Icon } from '../icons';
import { Field, Modal } from '../kit';

const Scanner = lazy(() => import('../Scanner'));

/** ¿Está la app abierta desde el ícono de la pantalla de inicio (y no en Safari)? */
export function isInstalledApp(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Cómo va la sincronización: un puntito con texto en el menú. */
export function SyncBadge() {
  return isLinked() ? <SyncState /> : null;
}

function SyncState() {
  const state = useObservable(db.cloud.syncState);
  if (!state) return null;
  const { text, tone } =
    state.phase === 'in-sync'
      ? { text: 'Al día', tone: 'good' }
      : state.phase === 'offline' || state.status === 'offline'
        ? { text: 'Sin internet', tone: 'warn' }
        : state.phase === 'error'
          ? { text: 'Error al sincronizar', tone: 'bad' }
          : { text: 'Sincronizando…', tone: 'plain' };
  return (
    <span className={`sync-badge ${tone}`} title={state.error?.message}>
      <span className="dot" /> {text}
    </span>
  );
}

/** Ventana para escanear el QR de vinculación (o pegar el código). */
function LinkCodeModal(props: { title: string; message: string; okText: string; danger?: boolean; onCode: (code: string, name: string) => Promise<void>; onClose: () => void }) {
  const { toast } = useUi();
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName());
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const parsed = parseLinkCode(code);
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancelar
          </button>
          <button
            className={`btn ${props.danger ? 'danger' : 'primary'}`}
            disabled={!parsed || busy}
            onClick={async () => {
              if (!parsed) return;
              setBusy(true);
              try {
                await props.onCode(parsed, name);
              } catch (error) {
                toast(error instanceof Error ? error.message : String(error), 'error');
              }
              setBusy(false);
            }}
          >
            {busy ? 'Conectando…' : props.okText}
          </button>
        </>
      }
    >
      <p className="pre">{props.message}</p>
      <button className="btn primary" onClick={() => setScanning(true)}>
        <Icon name="camera" /> Escanear el código QR
      </button>
      <Field label="O pega el código">{id => <input id={id} value={code} onChange={e => setCode(e.target.value)} autoComplete="off" placeholder="Código de vinculación" />}</Field>
      {parsed && <p className="good-text">✓ Código leído.</p>}
      <Field label="¿Cómo se llama este equipo?" hint="Para reconocerlo en la lista. Ej.: Teléfono de Martina">
        {id => <input id={id} value={name} onChange={e => setName(e.target.value)} />}
      </Field>
      {scanning && (
        <Suspense fallback={null}>
          <Scanner
            onClose={() => setScanning(false)}
            onCode={text => {
              setScanning(false);
              setCode(text);
              if (!parseLinkCode(text)) toast('Ese código no es de Martina.', 'error');
            }}
          />
        </Suspense>
      )}
    </Modal>
  );
}

/** Botón de la bienvenida: "ya uso Martina en otro equipo". */
export function LinkFromSetup() {
  const [open, setOpen] = useState(false);
  if (!cloudEnabled) return null;
  return (
    <>
      <button type="button" className="btn block" onClick={() => setOpen(true)}>
        <Icon name="camera" /> Ya uso Martina en otro equipo: escanear su QR
      </button>
      {open && (
        <LinkCodeModal
          title="Vincular con el otro equipo"
          message={'En el equipo que ya tiene Martina: Ajustes › Equipos › «Mostrar QR para vincular». Luego escanéalo aquí.'}
          okText="Vincular"
          onCode={linkToBusiness}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Cuando alguien escaneó el QR con la cámara normal: se abrió esta página con la llave en la dirección. */
export function LinkLanding({ code, onDone }: { code: string; onDone: () => void }) {
  const installed = isInstalledApp();
  const [busy, setBusy] = useState(false);
  return (
    <main className="lock-screen">
      <div className="card setup">
        <h1>Vincular este equipo</h1>
        {!installed && (
          <>
            <p>Para usar Martina en este equipo:</p>
            <ol className="steps">
              <li>Toca el botón Compartir y luego «Agregar a pantalla de inicio».</li>
              <li>Abre Martina desde el ícono nuevo.</li>
              <li>En la bienvenida toca «Ya uso Martina en otro equipo» y escanea el QR otra vez desde ahí.</li>
            </ol>
            <p className="muted small-text">
              En iPhone y iPad, la app del ícono guarda sus datos aparte de Safari: por eso el QR se escanea desde dentro de la app.
            </p>
          </>
        )}
        <div className="actions">
          <button className="btn" onClick={onDone}>
            Entendido
          </button>
          {cloudEnabled && (
            <button
              className={installed ? 'btn primary' : 'btn'}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await linkToBusiness(code, defaultDeviceName());
              }}
            >
              {installed ? 'Vincular este equipo' : 'Vincular aquí de todas formas'}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

/** Ajustes › Equipos: activar, mostrar el QR, ver y quitar equipos. */
export function DevicesSection() {
  const { isOwner, requireOwner } = useSession();
  const { run, confirm } = useUi();
  const devices = useLiveQuery(() => db.devices.orderBy('letter').toArray(), []);
  const thisId = useLiveQuery(async () => (await getDeviceLocal(db)).deviceId, []);
  const [showQr, setShowQr] = useState(false);
  const [mode, setMode] = useState<'activate' | 'link' | null>(null);
  if (!cloudEnabled) return null;
  const linked = isLinked();

  return (
    <section className="card">
      <div className="card-head">
        <h2>Equipos</h2>
        <SyncBadge />
      </div>
      {!linked ? (
        <>
          <p className="muted">
            Este equipo guarda sus datos solo. Vinculado, Martina, sus empleados y quien ella quiera ven y anotan lo mismo desde varios equipos, y queda copia en la nube.
          </p>
          <div className="actions wrap">
            {isOwner && (
              <button className="btn primary" onClick={() => setMode('activate')}>
                Activar en este equipo (el principal)
              </button>
            )}
            <button className="btn" onClick={() => setMode('link')}>
              <Icon name="camera" /> Vincular a otro equipo (escanear su QR)
            </button>
          </div>
        </>
      ) : (
        <>
          <ul className="list">
            {devices?.map(d => (
              <li key={d.id} className={d.blocked ? 'voided' : ''}>
                <span className="tag">{d.letter}</span>
                <span className="grow">
                  <strong>
                    {d.name}
                    {d.id === thisId ? ' (este)' : ''}
                  </strong>
                  <small className="muted">{d.blocked ? 'Quitado' : `Usado por última vez: ${formatDateTime(d.lastSeenAt)}`}</small>
                </span>
                {isOwner && d.id !== thisId && !d.blocked && (
                  <button
                    className="btn small"
                    onClick={async () => {
                      if (await confirm({ title: `¿Quitar «${d.name}»?`, message: 'Cuando ese equipo se conecte, se le borra todo lo de Martina y ya no podrá entrar. Úsalo si se perdió o es de alguien que ya no trabaja.', okText: 'Quitar', danger: true }))
                        await run(() => blockDevice(d.id), 'Equipo quitado');
                    }}
                  >
                    Quitar
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="actions wrap">
            <button
              className="btn primary"
              onClick={async () => {
                if (await requireOwner('Mostrar el QR: autorización de la dueña')) setShowQr(true);
              }}
            >
              Mostrar QR para vincular otro equipo
            </button>
            <button
              className="btn"
              onClick={async () => {
                const owner = await requireOwner('Desvincular: autorización de la dueña');
                if (owner && (await confirm({ title: 'Desvincular este equipo', message: 'Se borra todo lo de Martina en ESTE equipo (en los otros y en la nube queda). Para volver a usarlo hay que vincularlo otra vez.', okText: 'Desvincular', danger: true })))
                  await unlinkThisDevice();
              }}
            >
              Desvincular este equipo
            </button>
          </div>
        </>
      )}
      {showQr && <QrModal onClose={() => setShowQr(false)} />}
      {mode === 'activate' && (
        <LinkCodeModal
          title="Activar la sincronización"
          message={'Esto se hace UNA sola vez, en el equipo principal: todo lo que ya está anotado aquí se sube a la nube.\nEscanea el código de activación que te dio quien instaló la app.'}
          okText="Activar"
          onCode={async (code, name) => {
            await run(() => activateMainDevice(code, name), 'Sincronización activada');
            setMode(null);
          }}
          onClose={() => setMode(null)}
        />
      )}
      {mode === 'link' && (
        <LinkCodeModal
          title="Vincular a otro equipo"
          message={'En el equipo que ya tiene el negocio: Ajustes › Equipos › «Mostrar QR para vincular».\n⚠️ Lo que haya anotado en ESTE equipo se borra y se reemplaza por lo del negocio.'}
          okText="Borrar y vincular"
          danger
          onCode={linkToBusiness}
          onClose={() => setMode(null)}
        />
      )}
    </section>
  );
}

/** El QR con la llave del negocio. */
function QrModal({ onClose }: { onClose: () => void }) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let alive = true;
    void import('qrcode').then(QR => QR.toDataURL(linkUrl(), { margin: 1, width: 320, errorCorrectionLevel: 'M' })).then(url => alive && setImage(url));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Modal title="Vincular otro equipo" onClose={onClose}>
      <ol className="steps">
        <li>En el otro equipo, abre Safari en la dirección de Martina y agrégala a la pantalla de inicio.</li>
        <li>Ábrela desde el ícono y toca «Ya uso Martina en otro equipo».</li>
        <li>Escanea este código.</li>
      </ol>
      <div className="qr-box">{image ? <img src={image} alt="Código QR para vincular" width={320} height={320} /> : <p className="muted">Preparando…</p>}</div>
      <p className="notice warn">
        <Icon name="alert" />
        <span>Este código es la llave del negocio: quien lo escanee entra. No lo mandes por foto ni lo dejes a la vista.</span>
      </p>
    </Modal>
  );
}
