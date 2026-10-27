import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type ChangeEvent } from 'react';
import { db, saveSettings } from '../../db/database';
import type { Role, Settings as AppSettings } from '../../db/types';
import { audit } from '../../domain/audit';
import { exportBackup, importBackup } from '../../domain/backup';
import { deleteCategory, saveCategory, saveSupplier } from '../../domain/catalog';
import { BusinessError, dayKeyOf, nowIso } from '../../domain/common';
import { changePin, createUser, resetPin, setUserActive } from '../../domain/users';
import { useSession, useUi } from '../context';
import { formatDateTime } from '../format';
import { Icon } from '../icons';
import { Field, Modal } from '../kit';
import { shareOrDownload } from '../share';

export default function Settings() {
  const { isOwner, settings } = useSession();
  return (
    <div className="page">
      <header className="page-head">
        <h1>Ajustes</h1>
      </header>
      {isOwner && <BackupSection />}
      {/* La llave hace que el formulario se vuelva a llenar cuando los ajustes guardados cambian. */}
      {isOwner && <BusinessSection key={JSON.stringify(settings)} />}
      <SecuritySection />
      {isOwner && <CatalogSection />}
      {isOwner && <AuditSection />}
      <AboutSection />
    </div>
  );
}

function BusinessSection() {
  const { settings, user } = useSession();
  const { run } = useUi();
  const [form, setForm] = useState<AppSettings>(settings);
  const [newLottery, setNewLottery] = useState('');
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setForm(f => ({ ...f, [key]: value }));
  const changed = JSON.stringify(form) !== JSON.stringify(settings);

  const save = () =>
    run(async () => {
      if (!form.businessName.trim()) throw new BusinessError('Ponle nombre al negocio.');
      if (!(form.commissionPct >= 0 && form.commissionPct <= 100)) throw new BusinessError('La comisión tiene que estar entre 0 y 100.');
      await saveSettings({ ...form, businessName: form.businessName.trim() });
      await audit(db, user.id, 'cambiar', 'ajustes', undefined, `comisión ${form.commissionPct}%, ITBIS ${form.taxEnabled ? `${form.taxRate}%` : 'no'}`);
    }, 'Ajustes guardados');

  const addLottery = () => {
    const name = newLottery.trim();
    if (name && !form.lotteries.includes(name)) set('lotteries', [...form.lotteries, name]);
    setNewLottery('');
  };

  return (
    <section className="card">
      <h2>Negocio</h2>
      <div className="row2">
        <Field label="Nombre del negocio">{id => <input id={id} value={form.businessName} onChange={e => set('businessName', e.target.value)} />}</Field>
        <Field label="Al final del recibo">{id => <input id={id} value={form.receiptFooter} onChange={e => set('receiptFooter', e.target.value)} />}</Field>
      </div>
      <h3>Lotería</h3>
      <div className="row2">
        <Field label="Comisión (%)" hint="El % de la venta de lotería que te ganas. Se usa en cada día nuevo; un día abierto se cambia en su cuadre.">
          {id => <input id={id} inputMode="decimal" value={String(form.commissionPct)} onChange={e => set('commissionPct', Number(e.target.value.replace(',', '.')) || 0)} />}
        </Field>
        <Field label="Loterías que vendes (opcional)" hint="Si pones la lista, al anotar se escoge de cuál es y el cuadre las separa.">
          {id => (
            <div className="inline-form">
              <input
                id={id}
                value={newLottery}
                placeholder="Ej. Nacional"
                onChange={e => setNewLottery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addLottery();
                  }
                }}
              />
              <button className="btn" onClick={addLottery} disabled={!newLottery.trim()}>
                <Icon name="plus" />
              </button>
            </div>
          )}
        </Field>
      </div>
      {form.lotteries.length > 0 && (
        <ul className="chips">
          {form.lotteries.map(l => (
            <li key={l} className="chip">
              {l}
              <button
                className="chip-x"
                aria-label={`Quitar ${l}`}
                onClick={() =>
                  set(
                    'lotteries',
                    form.lotteries.filter(x => x !== l),
                  )
                }
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>Tienda</h3>
      <label className="check">
        <input type="checkbox" checked={form.taxEnabled} onChange={e => set('taxEnabled', e.target.checked)} /> Mostrar el ITBIS en los recibos
      </label>
      {form.taxEnabled && (
        <Field label="ITBIS (%)">{id => <input id={id} inputMode="decimal" value={String(form.taxRate)} onChange={e => set('taxRate', Number(e.target.value) || 0)} />}</Field>
      )}
      <label className="check">
        <input type="checkbox" checked={form.allowNegativeStock} onChange={e => set('allowNegativeStock', e.target.checked)} /> Dejar vender aunque la app diga que no hay
        existencia
      </label>
      <div className="actions">
        <button className="btn primary" disabled={!changed} onClick={() => void save()}>
          Guardar cambios
        </button>
      </div>
    </section>
  );
}

function SecuritySection() {
  const { settings, user, isOwner } = useSession();
  const { run, askText } = useUi();
  const users = useLiveQuery(() => db.users.toArray(), []);
  const [changing, setChanging] = useState(false);
  const [adding, setAdding] = useState(false);

  return (
    <section className="card">
      <h2>Seguridad</h2>
      <div className="actions wrap">
        <button className="btn" onClick={() => setChanging(true)}>
          <Icon name="lock" /> Cambiar mi PIN
        </button>
        {isOwner && (
          <label className="field inline">
            Bloquear sola después de
            <select
              value={settings.lockMinutes}
              onChange={e => void run(() => saveSettings({ ...settings, lockMinutes: Number(e.target.value) }), 'Guardado')}
            >
              {[2, 5, 10, 15, 30, 60].map(m => (
                <option key={m} value={m}>
                  {m} minutos sin usar
                </option>
              ))}
              <option value={0}>Nunca</option>
            </select>
          </label>
        )}
      </div>
      {isOwner && (
        <>
          <h3>Quién usa la app</h3>
          <ul className="list">
            {users?.map(u => (
              <li key={u.id} className={u.active ? '' : 'voided'}>
                <span className="grow">
                  <strong>{u.name}</strong> <small className="muted">{u.role === 'owner' ? 'dueña' : 'empleado'}</small>
                </span>
                {u.id !== user.id && (
                  <>
                    <button
                      className="btn small"
                      onClick={async () => {
                        const pin = await askText({ title: `PIN nuevo para ${u.name}`, label: 'PIN (4 a 6 números)', okText: 'Cambiar' });
                        if (pin) await run(() => resetPin(db, u.id, pin, user.id), 'PIN cambiado');
                      }}
                    >
                      Nuevo PIN
                    </button>
                    <button className="btn small" onClick={() => void run(() => setUserActive(db, u.id, !u.active, user.id))}>
                      {u.active ? 'Desactivar' : 'Activar'}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <button className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Agregar persona
          </button>
        </>
      )}
      {changing && <ChangePinModal onClose={() => setChanging(false)} />}
      {adding && <AddUserModal onClose={() => setAdding(false)} />}
    </section>
  );
}

function ChangePinModal({ onClose }: { onClose: () => void }) {
  const { user } = useSession();
  const { run } = useUi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const numeric = (set: (v: string) => void) => (e: ChangeEvent<HTMLInputElement>) => set(e.target.value.replace(/\D/g, '').slice(0, 6));
  return (
    <Modal
      title="Cambiar mi PIN"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!current || next.length < 4 || next !== again}
          onClick={async () => {
            if (await run(async () => (await changePin(db, user.id, current, next), true), 'PIN cambiado')) onClose();
          }}
        >
          Cambiar
        </button>
      }
    >
      <Field label="PIN actual">{id => <input id={id} className="pin-field" inputMode="numeric" autoComplete="off" value={current} onChange={numeric(setCurrent)} autoFocus />}</Field>
      <div className="row2">
        <Field label="PIN nuevo">{id => <input id={id} className="pin-field" inputMode="numeric" autoComplete="off" value={next} onChange={numeric(setNext)} />}</Field>
        <Field label="Repite el nuevo" hint={again && next !== again ? 'No son iguales' : undefined}>
          {id => <input id={id} className="pin-field" inputMode="numeric" autoComplete="off" value={again} onChange={numeric(setAgain)} />}
        </Field>
      </div>
    </Modal>
  );
}

function AddUserModal({ onClose }: { onClose: () => void }) {
  const { user } = useSession();
  const { run } = useUi();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [pin, setPin] = useState('');
  return (
    <Modal
      title="Agregar persona"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!name.trim() || pin.length < 4}
          onClick={async () => {
            if (await run(() => createUser(db, name, role, pin, user.id), `${name} agregado`)) onClose();
          }}
        >
          Agregar
        </button>
      }
    >
      <Field label="Nombre">{id => <input id={id} value={name} onChange={e => setName(e.target.value)} autoFocus />}</Field>
      <div className="row2">
        <Field label="Puede">
          {id => (
            <select id={id} value={role} onChange={e => setRole(e.target.value as Role)}>
              <option value="employee">Empleado: vender, anotar lotería, cobrar fiado</option>
              <option value="owner">Dueña: todo</option>
            </select>
          )}
        </Field>
        <Field label="Su PIN (4 a 6 números)">
          {id => <input id={id} className="pin-field" inputMode="numeric" autoComplete="off" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} />}
        </Field>
      </div>
      <p className="hint">El empleado no ve costos ni ganancias, y para anular, devolver, cerrar el día o mover inventario necesita el PIN de la dueña.</p>
    </Modal>
  );
}

function CatalogSection() {
  const { user } = useSession();
  const { run, askText, confirm } = useUi();
  const categories = useLiveQuery(() => db.categories.orderBy('name').toArray(), []);
  const suppliers = useLiveQuery(() => db.suppliers.orderBy('name').toArray(), []);

  return (
    <div className="two-cols">
      <section className="card">
        <h2>Categorías</h2>
        <ul className="list">
          {categories?.map(c => (
            <li key={c.id}>
              <span className="grow">{c.name}</span>
              <button
                className="icon-btn"
                aria-label="Cambiar nombre"
                onClick={async () => {
                  const name = await askText({ title: 'Cambiar nombre', label: 'Nombre', initial: c.name, okText: 'Guardar' });
                  if (name) await run(() => saveCategory(db, name, user.id, c.id));
                }}
              >
                <Icon name="edit" size={18} />
              </button>
              <button
                className="icon-btn"
                aria-label="Borrar"
                onClick={async () => {
                  if (await confirm({ title: `¿Borrar "${c.name}"?`, okText: 'Borrar', danger: true })) await run(() => deleteCategory(db, c.id, user.id), 'Categoría borrada');
                }}
              >
                <Icon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
        <button
          className="btn"
          onClick={async () => {
            const name = await askText({ title: 'Categoría nueva', label: 'Nombre', placeholder: 'Ej. Bebidas', okText: 'Crear' });
            if (name) await run(() => saveCategory(db, name, user.id), 'Categoría creada');
          }}
        >
          <Icon name="plus" /> Categoría
        </button>
      </section>
      <section className="card">
        <h2>Proveedores</h2>
        <ul className="list">
          {suppliers?.map(s => (
            <li key={s.id}>
              <span className="grow">
                {s.name} {s.phone && <small className="muted">{s.phone}</small>}
              </span>
              <button
                className="icon-btn"
                aria-label="Cambiar"
                onClick={async () => {
                  const phone = await askText({ title: s.name, label: 'Teléfono', initial: s.phone ?? '', okText: 'Guardar' });
                  if (phone !== null) await run(() => saveSupplier(db, { ...s, phone }, user.id, s.id));
                }}
              >
                <Icon name="edit" size={18} />
              </button>
            </li>
          ))}
        </ul>
        <button
          className="btn"
          onClick={async () => {
            const name = await askText({ title: 'Proveedor nuevo', label: 'Nombre', okText: 'Crear' });
            if (name) await run(() => saveSupplier(db, { name }, user.id), 'Proveedor creado');
          }}
        >
          <Icon name="plus" /> Proveedor
        </button>
      </section>
    </div>
  );
}

function BackupSection() {
  const { settings, lock } = useSession();
  const { run, confirm } = useUi();

  const save = () =>
    run(async () => {
      const json = await exportBackup(db);
      const stamp = `${dayKeyOf()}-${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
      const file = new File([json], `martina-respaldo-${stamp}.json`, { type: 'application/json' });
      if (await shareOrDownload(file)) {
        await saveSettings({ ...settings, lastBackupAt: nowIso() });
        return true;
      }
      return false;
    }, 'Respaldo listo');

  const restore = async (file: File) => {
    const ok = await confirm({
      title: 'Recuperar respaldo',
      message: `Esto BORRA todo lo que hay ahora en este iPad y pone lo del archivo "${file.name}".\n\n¿Seguro?`,
      okText: 'Sí, recuperar',
      danger: true,
    });
    if (!ok) return;
    const result = await run(async () => importBackup(db, await file.text()));
    if (result) {
      await confirm({ title: 'Respaldo recuperado', message: `${result.products} productos y ${result.sales} ventas. Entra otra vez con tu PIN.`, okText: 'Entrar' });
      lock();
    }
  };

  return (
    <section className="card">
      <h2>Respaldo</h2>
      <p className="muted">
        Todo se guarda solo en este iPad. Si se pierde, se daña o se borra el ícono de la app, se pierde todo, menos lo que esté en un respaldo. Guarda uno cada
        semana en Archivos (iCloud) o mándatelo por WhatsApp.
      </p>
      <p>
        Último respaldo: <strong>{settings.lastBackupAt ? formatDateTime(settings.lastBackupAt) : 'nunca'}</strong>
      </p>
      <div className="actions wrap">
        <button className="btn primary" onClick={() => void save()}>
          <Icon name="download" /> Guardar respaldo
        </button>
        <label className="btn">
          <Icon name="upload" /> Recuperar un respaldo
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void restore(file);
            }}
          />
        </label>
      </div>
    </section>
  );
}

function AuditSection() {
  const [open, setOpen] = useState(false);
  const entries = useLiveQuery(() => (open ? db.audit.orderBy('date').reverse().limit(200).toArray() : []), [open]);
  const users = useLiveQuery(async () => new Map((await db.users.toArray()).map(u => [u.id, u.name])), []);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Bitácora</h2>
        <button className="btn small" onClick={() => setOpen(o => !o)}>
          {open ? 'Ocultar' : 'Ver lo último que se hizo'}
        </button>
      </div>
      {open && entries && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Quién</th>
                <th>Qué</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(a => (
                <tr key={a.id}>
                  <td>{formatDateTime(a.date)}</td>
                  <td>{users?.get(a.userId) ?? ''}</td>
                  <td>
                    {a.action} {a.entity}
                  </td>
                  <td className="small-text">{a.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AboutSection() {
  const storage = useLiveQuery(async () => {
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    const estimate = await navigator.storage?.estimate?.();
    return { persisted, usedMb: estimate?.usage ? estimate.usage / 1024 / 1024 : null };
  }, []);
  return (
    <section className="card">
      <h2>Acerca de</h2>
      <p>
        Martina versión <strong>{__APP_VERSION__}</strong>
      </p>
      {storage && (
        <p className="muted small-text">
          Espacio usado: {storage.usedMb !== null ? `${storage.usedMb.toFixed(1)} MB` : 'no se sabe'} ·{' '}
          {storage.persisted ? 'el iPad no borrará los datos por falta de espacio' : 'el iPad podría borrar datos si se llena: usa la app desde el ícono de la pantalla de inicio'}
        </p>
      )}
      <p className="muted small-text">Cuando haya una versión nueva, aparece un aviso abajo para actualizar. Los datos no se pierden al actualizar.</p>
    </section>
  );
}
