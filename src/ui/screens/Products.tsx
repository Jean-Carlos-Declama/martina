import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useMemo, useState } from 'react';
import { db } from '../../db/database';
import type { Product } from '../../db/types';
import { saveCategory } from '../../domain/catalog';
import { createProduct, matchesSearch, setProductActive, updateProduct, type ProductInput } from '../../domain/products';
import { countCorrection, manualMovement, MOVEMENT_LABELS, type ManualMovementType } from '../../domain/stock';
import { useSession, useUi } from '../context';
import { formatDateTime, formatQty, moneyField, movementTone, parseMoney, parseQty, qtyWithUnit, UNITS } from '../format';
import { Icon } from '../icons';
import { Empty, Field, Modal, MoneyInput, PhotoThumb, Segmented } from '../kit';
import { shrinkPhoto, useBlobUrl } from '../photo';

const Scanner = lazy(() => import('../Scanner'));

type Filter = 'active' | 'low' | 'out' | 'archived';

export default function Products() {
  const { money, seesMoney, canEdit, requireOwner } = useSession();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('active');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const products = useLiveQuery(() => db.products.toArray(), []);
  const categories = useLiveQuery(() => db.categories.orderBy('name').toArray(), []);

  const shown = useMemo(() => {
    const list = (products ?? []).filter(p => {
      if (filter === 'archived' ? p.active : !p.active) return false;
      if (filter === 'low' && !(p.stock > 0 && p.stock <= p.minStock)) return false;
      if (filter === 'out' && p.stock > 0) return false;
      return (!category || p.categoryId === category) && matchesSearch(p, search);
    });
    return list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [products, filter, category, search]);
  const counts = useMemo(() => {
    const active = (products ?? []).filter(p => p.active);
    return { low: active.filter(p => p.stock > 0 && p.stock <= p.minStock).length, out: active.filter(p => p.stock <= 0).length };
  }, [products]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Productos</h1>
        {canEdit && (
          <button
            className="btn primary"
            onClick={async () => {
              if (await requireOwner('Agregar producto: autorización de la dueña')) setEditing('new');
            }}
          >
            <Icon name="plus" /> Nuevo producto
          </button>
        )}
      </header>
      <div className="toolbar">
        <div className="search-bar">
          <Icon name="search" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, código o marca" />
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'Todos' },
            { value: 'low', label: `Poca existencia${counts.low ? ` (${counts.low})` : ''}` },
            { value: 'out', label: `Agotados${counts.out ? ` (${counts.out})` : ''}` },
            { value: 'archived', label: 'Archivados' },
          ]}
        />
        {categories && categories.length > 0 && (
          <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Categoría">
            <option value="">Todas las categorías</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {shown.length === 0 ? (
        <Empty icon="box" text={products?.length ? 'Ningún producto con ese filtro.' : 'Todavía no hay productos.'} />
      ) : (
        <ul className="list card">
          {shown.map(p => (
            <li key={p.id}>
              <button className="row-button" onClick={() => setViewing(p.id)}>
                <PhotoThumb photo={p.photo} name={p.name} />
                <span className="grow">
                  <strong>{p.name}</strong>
                  <small className="muted">
                    {p.sku}
                    {p.barcode ? ` · ${p.barcode}` : ''}
                    {p.brand ? ` · ${p.brand}` : ''}
                  </small>
                </span>
                <span className="right">
                  <strong>{money(p.priceCents)}</strong>
                  <small className={p.stock <= 0 ? 'bad-text' : p.stock <= p.minStock ? 'warn-text' : 'muted'}>
                    {qtyWithUnit(p.stock, p.unit)}
                  </small>
                  {seesMoney && <small className="muted">costo {money(p.costCents)}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && <ProductForm product={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {viewing && (
        <ProductDetail
          id={viewing}
          onClose={() => setViewing(null)}
          onEdit={async product => {
            if (await requireOwner('Editar producto: autorización de la dueña')) {
              setViewing(null);
              setEditing(product);
            }
          }}
        />
      )}
    </div>
  );
}

function ProductForm({ product, onClose }: { product?: Product; onClose: () => void }) {
  const { settings, user } = useSession();
  const { run, askText } = useUi();
  const categories = useLiveQuery(() => db.categories.orderBy('name').toArray(), []);
  const suppliers = useLiveQuery(() => db.suppliers.orderBy('name').toArray(), []);
  const [name, setName] = useState(product?.name ?? '');
  const [barcode, setBarcode] = useState(product?.barcode ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [supplierId, setSupplierId] = useState(product?.supplierId ?? '');
  const [unit, setUnit] = useState(product?.unit ?? 'unidad');
  const [cost, setCost] = useState(moneyField(product?.costCents));
  const [price, setPrice] = useState(moneyField(product?.priceCents));
  const [taxed, setTaxed] = useState(product?.taxed ?? true);
  const [minStock, setMinStock] = useState(String(product?.minStock ?? 2));
  const [stock, setStock] = useState('');
  const [description, setDescription] = useState(product?.description ?? '');
  const [photo, setPhoto] = useState<Blob | undefined>(product?.photo);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const photoUrl = useBlobUrl(photo);

  const costCents = parseMoney(cost) ?? 0;
  const priceCents = parseMoney(price) ?? 0;
  const margin = priceCents > 0 && costCents > 0 ? Math.round(((priceCents - costCents) / priceCents) * 100) : null;

  const save = async () => {
    const input: ProductInput = {
      name,
      barcode,
      sku,
      brand,
      categoryId: categoryId || undefined,
      supplierId: supplierId || undefined,
      unit,
      costCents,
      priceCents,
      taxed,
      minStock: Number(minStock.replace(',', '.')) || 0,
      description,
      photo,
    };
    setBusy(true);
    const ok = await run(async () => {
      if (product) await updateProduct(db, product.id, input, user.id);
      else await createProduct(db, input, stock.trim() ? (parseQty(stock) ?? 0) : 0, user.id);
      return true;
    }, product ? 'Producto guardado' : 'Producto creado');
    setBusy(false);
    if (ok) onClose();
  };

  const newCategory = async () => {
    const text = await askText({ title: 'Categoría nueva', label: 'Nombre', placeholder: 'Ej. Bebidas', okText: 'Crear' });
    if (!text) return;
    const created = await run(() => saveCategory(db, text, user.id));
    if (created) setCategoryId(created.id);
  };

  return (
    <Modal
      title={product ? `Editar ${product.name}` : 'Producto nuevo'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            Guardar
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="photo-field">
          {photoUrl ? <img src={photoUrl} alt="" /> : <PhotoThumb name={name || '?'} size={120} />}
          <label className="btn small">
            <Icon name="camera" /> {photo ? 'Cambiar foto' : 'Poner foto'}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={async e => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) {
                  const small = await run(() => shrinkPhoto(file));
                  if (small) setPhoto(small);
                }
              }}
            />
          </label>
          {photo && (
            <button className="btn small link" onClick={() => setPhoto(undefined)}>
              Quitar foto
            </button>
          )}
        </div>
        <div className="form-fields">
          <Field label="Nombre">{id => <input id={id} value={name} onChange={e => setName(e.target.value)} autoFocus={!product} autoCapitalize="sentences" />}</Field>
          <div className="row2">
            <Field label="Código de barras">
              {id => (
                <div className="inline-form">
                  <input id={id} inputMode="numeric" value={barcode} onChange={e => setBarcode(e.target.value.trim())} />
                  <button className="btn" type="button" onClick={() => setScanning(true)} aria-label="Escanear código">
                    <Icon name="barcode" />
                  </button>
                </div>
              )}
            </Field>
            <Field label="Código interno" hint={product ? undefined : 'Si lo dejas vacío se pone solo (P0001...)'}>
              {id => <input id={id} value={sku} onChange={e => setSku(e.target.value.trim())} />}
            </Field>
          </div>
          <div className="row2">
            <Field label="Costo (lo que te cuesta)">{id => <MoneyInput id={id} value={cost} onChange={setCost} currency={settings.currency} />}</Field>
            <Field label="Precio de venta" hint={margin !== null ? `Ganas ${margin}% del precio` : undefined}>
              {id => <MoneyInput id={id} value={price} onChange={setPrice} currency={settings.currency} />}
            </Field>
          </div>
          <div className="row3">
            <Field label="Se vende por">
              {id => (
                <select id={id} value={unit} onChange={e => setUnit(e.target.value)}>
                  {[...new Set([...UNITS, unit])].map(u => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Avisar cuando queden" hint="Mínimo de existencia">
              {id => <input id={id} inputMode="decimal" value={minStock} onChange={e => setMinStock(e.target.value)} />}
            </Field>
            {!product && (
              <Field label="Existencia que hay ahora">{id => <input id={id} inputMode="decimal" value={stock} onChange={e => setStock(e.target.value)} placeholder="0" />}</Field>
            )}
          </div>
          <div className="row3">
            <Field label="Categoría">
              {id => (
                <select id={id} value={categoryId} onChange={e => (e.target.value === '+' ? void newCategory() : setCategoryId(e.target.value))}>
                  <option value="">—</option>
                  {categories?.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value="+">+ Nueva categoría…</option>
                </select>
              )}
            </Field>
            <Field label="Marca">{id => <input id={id} value={brand} onChange={e => setBrand(e.target.value)} />}</Field>
            <Field label="Proveedor">
              {id => (
                <select id={id} value={supplierId} onChange={e => setSupplierId(e.target.value)}>
                  <option value="">—</option>
                  {suppliers?.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          {settings.taxEnabled && (
            <label className="check">
              <input type="checkbox" checked={taxed} onChange={e => setTaxed(e.target.checked)} /> Lleva ITBIS ({settings.taxRate}%, ya incluido en el precio)
            </label>
          )}
          <Field label="Nota (opcional)">{id => <input id={id} value={description} onChange={e => setDescription(e.target.value)} />}</Field>
        </div>
      </div>
      {scanning && (
        <Suspense fallback={null}>
          <Scanner
            onClose={() => setScanning(false)}
            onCode={code => {
              setBarcode(code);
              setScanning(false);
            }}
          />
        </Suspense>
      )}
    </Modal>
  );
}

type StockAction = 'purchase' | 'out' | 'count';

function ProductDetail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (product: Product) => void }) {
  const { money, seesMoney, canEdit, requireOwner } = useSession();
  const { run } = useUi();
  const product = useLiveQuery(() => db.products.get(id), [id]);
  const movements = useLiveQuery(() => db.movements.where('[productId+date]').between([id, ''], [id, '￿']).reverse().limit(100).toArray(), [id]);
  const users = useLiveQuery(async () => new Map((await db.users.toArray()).map(u => [u.id, u.name])), []);
  const [action, setAction] = useState<{ kind: StockAction; ownerId: string } | null>(null);
  if (!product) return null;

  const start = async (kind: StockAction) => {
    const owner = await requireOwner('Mover inventario: autorización de la dueña');
    if (owner) setAction({ kind, ownerId: owner.id });
  };

  return (
    <Modal
      title={product.name}
      onClose={onClose}
      wide
      footer={
        canEdit && (
          <>
            <button
              className="btn"
              onClick={async () => {
                const owner = await requireOwner();
                if (owner) await run(() => setProductActive(db, product.id, !product.active, owner.id), product.active ? 'Producto archivado' : 'Producto reactivado');
              }}
            >
              {product.active ? 'Archivar' : 'Reactivar'}
            </button>
            <button className="btn" onClick={() => onEdit(product)}>
              <Icon name="edit" /> Editar
            </button>
          </>
        )
      }
    >
      <div className="detail-head">
        <PhotoThumb photo={product.photo} name={product.name} size={96} />
        <div className="stats grow">
          <div className="stat plain">
            <span className="stat-label">Existencia</span>
            <strong className={`stat-value ${product.stock <= 0 ? 'bad-text' : product.stock <= product.minStock ? 'warn-text' : ''}`}>
              {qtyWithUnit(product.stock, product.unit)}
            </strong>
            <span className="stat-sub">avisa con {formatQty(product.minStock)}</span>
          </div>
          <div className="stat plain">
            <span className="stat-label">Precio</span>
            <strong className="stat-value">{money(product.priceCents)}</strong>
            {seesMoney && <span className="stat-sub">costo {money(product.costCents)}</span>}
          </div>
        </div>
      </div>
      <p className="muted small-text">
        Código {product.sku}
        {product.barcode ? ` · barras ${product.barcode}` : ''}
        {product.brand ? ` · ${product.brand}` : ''}
        {product.description ? ` · ${product.description}` : ''}
      </p>
      {canEdit && (
        <div className="actions wrap">
          <button className="btn primary" onClick={() => void start('purchase')}>
            <Icon name="download" /> Entrada de mercancía
          </button>
          <button className="btn" onClick={() => void start('out')}>
            <Icon name="upload" /> Salida o ajuste
          </button>
          <button className="btn" onClick={() => void start('count')}>
            <Icon name="check" /> Conteo físico
          </button>
        </div>
      )}
      <h3>Historial</h3>
      {movements && movements.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Qué pasó</th>
                <th className="num">Cantidad</th>
                <th className="num">Quedó</th>
                <th>Quién / por qué</th>
              </tr>
            </thead>
            <tbody>
              {movements.map(m => (
                <tr key={m.id}>
                  <td>{formatDateTime(m.date)}</td>
                  <td>{MOVEMENT_LABELS[m.type]}</td>
                  <td className={`num ${movementTone(m.type, m.quantity) === 'in' ? 'good-text' : 'bad-text'}`}>
                    {m.quantity > 0 ? '+' : ''}
                    {formatQty(m.quantity)}
                  </td>
                  <td className="num">{formatQty(m.stockAfter)}</td>
                  <td className="small-text">
                    {users?.get(m.userId) ?? ''}
                    {m.reason ? ` · ${m.reason}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Sin movimientos.</p>
      )}
      {action && <StockModal product={product} kind={action.kind} ownerId={action.ownerId} onClose={() => setAction(null)} />}
    </Modal>
  );
}

const OUT_TYPES: { value: ManualMovementType; label: string }[] = [
  { value: 'damaged', label: MOVEMENT_LABELS.damaged },
  { value: 'internalUse', label: MOVEMENT_LABELS.internalUse },
  { value: 'supplierReturn', label: MOVEMENT_LABELS.supplierReturn },
  { value: 'adjustOut', label: 'Ajuste: falta (−)' },
  { value: 'adjustIn', label: 'Ajuste: sobra (+)' },
];

function StockModal({ product, kind, ownerId, onClose }: { product: Product; kind: StockAction; ownerId: string; onClose: () => void }) {
  const { money, settings } = useSession();
  const { run } = useUi();
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState(moneyField(product.costCents));
  const [type, setType] = useState<ManualMovementType>('damaged');
  const [reason, setReason] = useState('');
  const quantity = kind === 'count' ? Number(qty.replace(',', '.')) : parseQty(qty);
  const valid = qty.trim() !== '' && quantity !== null && Number.isFinite(quantity) && quantity >= 0 && (kind === 'count' || quantity > 0);
  const titles: Record<StockAction, string> = { purchase: 'Entrada de mercancía', out: 'Salida o ajuste', count: 'Conteo físico' };

  const save = async () => {
    if (!valid || quantity === null) return;
    const done = await run(async () => {
      if (kind === 'purchase')
        await manualMovement(db, { productId: product.id, type: 'purchase', quantity, unitCostCents: parseMoney(cost) ?? product.costCents, reason, userId: ownerId });
      else if (kind === 'out') await manualMovement(db, { productId: product.id, type, quantity, reason, userId: ownerId });
      else await countCorrection(db, product.id, quantity, ownerId, reason.trim() || 'Conteo físico');
      return true;
    }, 'Inventario actualizado');
    if (done) onClose();
  };

  return (
    <Modal
      title={`${titles[kind]}: ${product.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => void save()}>
            Guardar
          </button>
        </>
      }
    >
      <p className="muted">
        Hay {qtyWithUnit(product.stock, product.unit)}.
      </p>
      {kind === 'out' && (
        <Field label="Tipo">
          {id => (
            <select id={id} value={type} onChange={e => setType(e.target.value as ManualMovementType)}>
              {OUT_TYPES.map(t => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="row2">
        <Field label={kind === 'count' ? `Cuántos contaste (${product.unit})` : `Cantidad (${product.unit})`}>
          {id => <input id={id} inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} autoFocus />}
        </Field>
        {kind === 'purchase' && (
          <Field label="Costo de cada uno" hint={`Ahora: ${money(product.costCents)}. Si cambia, queda el promedio.`}>
            {id => <MoneyInput id={id} value={cost} onChange={setCost} currency={settings.currency} />}
          </Field>
        )}
      </div>
      {kind === 'count' && valid && quantity !== null && (
        <p className={quantity === product.stock ? 'muted' : quantity > product.stock ? 'good-text' : 'bad-text'}>
          {quantity === product.stock ? 'Cuadra, no hay diferencia.' : `Diferencia: ${quantity > product.stock ? '+' : ''}${formatQty(Math.round((quantity - product.stock) * 1000) / 1000)}`}
        </p>
      )}
      <Field label={kind === 'out' ? 'Motivo' : 'Nota (opcional)'} hint={kind === 'purchase' ? 'Ej. proveedor o número de factura' : undefined}>
        {id => <input id={id} value={reason} onChange={e => setReason(e.target.value)} />}
      </Field>
    </Modal>
  );
}
