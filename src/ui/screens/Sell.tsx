import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { db } from '../../db/database';
import type { PaymentMethod, Product, Sale } from '../../db/types';
import { newId } from '../../domain/common';
import { matchesSearch, normalize } from '../../domain/products';
import { createSale, receiptNumber } from '../../domain/sales';
import { useSession, useUi } from '../context';
import { formatQty, moneyField, parseMoney, parseQty, PAYMENT_LABELS, plural, qtyWithUnit } from '../format';
import { Icon } from '../icons';
import { Empty, Field, Modal, MoneyInput, PhotoThumb, Segmented } from '../kit';
import { openWhatsApp, receiptText, shareText } from '../share';

const Scanner = lazy(() => import('../Scanner'));

interface CartItem {
  productId: string;
  name: string;
  unit: string;
  priceCents: number;
  quantity: number;
  discountCents: number;
}

// El carrito se guarda aquí afuera para que no se pierda si cambia de pantalla o se bloquea la app a mitad de venta.
let savedCart: CartItem[] = [];
let savedRequestId = newId();

export function Sell() {
  const { money, user, settings } = useSession();
  const { run, toast } = useUi();
  const [cart, setCart] = useState<CartItem[]>(savedCart);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState<CartItem | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cartRef = useRef<HTMLElement>(null);

  useEffect(() => {
    savedCart = cart;
  }, [cart]);

  const products = useLiveQuery(() => db.products.filter(p => p.active).toArray(), []);
  const categories = useLiveQuery(() => db.categories.orderBy('name').toArray(), []);
  const shown = useMemo(
    () =>
      (products ?? [])
        .filter(p => (!category || p.categoryId === category) && matchesSearch(p, search))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        .slice(0, 120),
    [products, search, category],
  );

  const add = (product: Product, quantity = 1) => {
    setCart(items => {
      const found = items.find(i => i.productId === product.id);
      if (found) return items.map(i => (i === found ? { ...i, quantity: Math.round((i.quantity + quantity) * 1000) / 1000 } : i));
      return [...items, { productId: product.id, name: product.name, unit: product.unit, priceCents: product.priceCents, quantity, discountCents: 0 }];
    });
    if (product.stock - (cart.find(i => i.productId === product.id)?.quantity ?? 0) < quantity && !settings.allowNegativeStock)
      toast(`Ojo: de "${product.name}" quedan ${formatQty(product.stock)}.`, 'error');
  };

  /** Un código leído (cámara o lector): busca el producto por código de barras o código interno. */
  const addByCode = async (code: string) => {
    const product = (await db.products.where('barcode').equals(code).first()) ?? (await db.products.where('sku').equals(code).first());
    if (product?.active) {
      add(product);
      toast(`+1 ${product.name}`);
      return true;
    }
    toast(`No hay ningún producto con el código ${code}.`, 'error');
    return false;
  };

  const subtotal = cart.reduce((sum, i) => sum + Math.round(i.priceCents * i.quantity) - i.discountCents, 0);
  const units = cart.reduce((sum, i) => sum + i.quantity, 0);

  const finish = (sale: Sale) => {
    setCart([]);
    savedRequestId = newId();
    setCheckout(false);
    setReceipt(sale);
  };

  return (
    <div className="sell">
      <section className="sell-products">
        <form
          className="search-bar"
          onSubmit={async e => {
            e.preventDefault();
            const text = search.trim();
            if (!text) return;
            // El lector de códigos escribe el código y da Enter; si no es un código, se agrega si hay un solo resultado.
            const exact = products?.find(p => p.barcode === text || p.sku === text);
            if (exact) {
              add(exact);
              toast(`+1 ${exact.name}`);
              setSearch('');
            } else if (shown.length === 1) {
              add(shown[0]);
              setSearch('');
            } else if (/^\d{6,}$/.test(text) && (await addByCode(text))) setSearch('');
          }}
        >
          <Icon name="search" />
          <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar o escanear producto" autoComplete="off" />
          {search && (
            <button type="button" className="icon-btn" onClick={() => setSearch('')} aria-label="Borrar búsqueda">
              <Icon name="close" size={18} />
            </button>
          )}
          <button type="button" className="btn" onClick={() => setScanning(true)}>
            <Icon name="barcode" /> Escanear
          </button>
        </form>
        {categories && categories.length > 0 && (
          <div className="chips scroll">
            <button className={`chip${!category ? ' on' : ''}`} onClick={() => setCategory('')}>
              Todos
            </button>
            {categories.map(c => (
              <button key={c.id} className={`chip${category === c.id ? ' on' : ''}`} onClick={() => setCategory(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        {products && products.length === 0 ? (
          <Empty icon="box" text="Todavía no hay productos. Agrégalos en la pantalla Productos." />
        ) : (
          <div className="product-grid">
            {shown.map(p => (
              <button key={p.id} className={`product-tile${p.stock <= 0 ? ' out' : ''}`} onClick={() => add(p)}>
                <PhotoThumb photo={p.photo} name={p.name} size={64} />
                <span className="tile-name">{p.name}</span>
                <strong>{money(p.priceCents)}</strong>
                <small className={p.stock <= p.minStock ? 'bad-text' : 'muted'}>
                  {qtyWithUnit(p.stock, p.unit)}
                </small>
              </button>
            ))}
          </div>
        )}
      </section>

      <aside className="sell-cart card" ref={cartRef}>
        <h2>
          Venta {cart.length > 0 && <small className="muted">({formatQty(units)} artículos)</small>}
        </h2>
        {cart.length === 0 ? (
          <Empty icon="cart" text="Toca un producto o escanea su código." />
        ) : (
          <ul className="cart-list">
            {cart.map(item => (
              <li key={item.productId}>
                <button className="cart-line" onClick={() => setEditing(item)}>
                  <span className="grow">
                    <strong>{item.name}</strong>
                    <small className="muted">
                      {formatQty(item.quantity)} × {money(item.priceCents)}
                      {item.discountCents > 0 ? ` − ${money(item.discountCents)}` : ''}
                    </small>
                  </span>
                  <span className="amount">{money(Math.round(item.priceCents * item.quantity) - item.discountCents)}</span>
                </button>
                <div className="stepper">
                  <button
                    className="icon-btn"
                    aria-label="Quitar uno"
                    onClick={() =>
                      setCart(items => items.flatMap(i => (i.productId !== item.productId ? [i] : i.quantity > 1 ? [{ ...i, quantity: i.quantity - 1 }] : [])))
                    }
                  >
                    <Icon name="minus" size={18} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="Uno más"
                    onClick={() => setCart(items => items.map(i => (i.productId === item.productId ? { ...i, quantity: i.quantity + 1 } : i)))}
                  >
                    <Icon name="plus" size={18} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="cart-total">
          <span>Total</span>
          <strong>{money(subtotal)}</strong>
        </div>
        <div className="cart-actions">
          <button className="btn" disabled={cart.length === 0} onClick={() => setCart([])}>
            Vaciar
          </button>
          <button className="btn primary grow big" disabled={cart.length === 0} onClick={() => setCheckout(true)}>
            Cobrar {money(subtotal)}
          </button>
        </div>
      </aside>

      {/* iPad de pie: la venta queda abajo de los productos; esta barra deja cobrar sin bajar. */}
      <div className="sell-bar">
        <button className="btn" disabled={cart.length === 0} onClick={() => cartRef.current?.scrollIntoView({ behavior: 'smooth' })}>
          <Icon name="cart" /> {plural(units, 'artículo', 'artículos')}
        </button>
        <button className="btn primary grow big" disabled={cart.length === 0} onClick={() => setCheckout(true)}>
          Cobrar {money(subtotal)}
        </button>
      </div>

      {scanning && (
        <Suspense fallback={null}>
          <Scanner
            onClose={() => setScanning(false)}
            onCode={code => {
              setScanning(false);
              void addByCode(code);
            }}
          />
        </Suspense>
      )}
      {editing && (
        <LineEditor
          item={editing}
          onClose={() => setEditing(null)}
          onSave={changed => {
            setCart(items => (changed ? items.map(i => (i.productId === changed.productId ? changed : i)) : items.filter(i => i.productId !== editing.productId)));
            setEditing(null);
          }}
        />
      )}
      {checkout && (
        <Checkout
          subtotal={subtotal}
          onClose={() => setCheckout(false)}
          onPay={async options => {
            const sale = await run(() =>
              createSale(db, {
                lines: cart.map(i => ({ productId: i.productId, quantity: i.quantity, discountCents: i.discountCents })),
                requestId: savedRequestId,
                userId: user.id,
                ...options,
              }),
            );
            if (sale) finish(sale);
          }}
        />
      )}
      {receipt && <ReceiptModal sale={receipt} onClose={() => (setReceipt(null), searchRef.current?.focus())} />}
    </div>
  );
}

function LineEditor({ item, onClose, onSave }: { item: CartItem; onClose: () => void; onSave: (item: CartItem | null) => void }) {
  const { settings } = useSession();
  const [qty, setQty] = useState(formatQty(item.quantity).replace(/,/g, ''));
  const [discount, setDiscount] = useState(moneyField(item.discountCents));
  const quantity = parseQty(qty);
  const discountCents = parseMoney(discount) ?? 0;
  const valid = quantity !== null && discountCents <= Math.round(item.priceCents * quantity);
  return (
    <Modal
      title={item.name}
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={() => onSave(null)}>
            <Icon name="trash" /> Quitar
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => quantity && onSave({ ...item, quantity, discountCents })}>
            Listo
          </button>
        </>
      }
    >
      <div className="row2">
        <Field label={`Cantidad (${item.unit})`} hint={item.unit === 'unidad' ? undefined : 'Puede llevar decimales, ej. 1.5'}>
          {id => <input id={id} inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} autoFocus />}
        </Field>
        <Field label="Descuento a este producto">{id => <MoneyInput id={id} value={discount} onChange={setDiscount} currency={settings.currency} />}</Field>
      </div>
    </Modal>
  );
}

interface PayOptions {
  payment: PaymentMethod;
  clientId?: string;
  clientName?: string;
  discountCents?: number;
}

function Checkout({ subtotal, onClose, onPay }: { subtotal: number; onClose: () => void; onPay: (options: PayOptions) => Promise<void> }) {
  const { money, settings } = useSession();
  const [payment, setPayment] = useState<PaymentMethod>('cash');
  const [name, setName] = useState('');
  const [discount, setDiscount] = useState('');
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const clients = useLiveQuery(() => db.clients.filter(c => c.active).toArray(), []);
  const client = clients?.find(c => normalize(c.name) === normalize(name));
  const discountCents = parseMoney(discount) ?? 0;
  const total = subtotal - discountCents;
  const receivedCents = parseMoney(received);
  const change = receivedCents !== null ? receivedCents - total : null;
  const problem =
    discountCents > subtotal
      ? 'El descuento es mayor que la venta.'
      : payment === 'credit' && !client
        ? 'Para fiar, escribe el nombre de un cliente registrado.'
        : payment === 'cash' && change !== null && change < 0
          ? 'Lo recibido no alcanza.'
          : '';

  return (
    <Modal
      title={`Cobrar ${money(total)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Seguir vendiendo
          </button>
          <button
            className="btn primary big"
            disabled={busy || !!problem}
            onClick={async () => {
              setBusy(true);
              await onPay({ payment, clientId: client?.id, clientName: client ? undefined : name.trim() || undefined, discountCents });
              setBusy(false);
            }}
          >
            <Icon name="check" /> Cobrar {money(total)}
          </button>
        </>
      }
    >
      <Segmented value={payment} onChange={setPayment} options={(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map(p => ({ value: p, label: PAYMENT_LABELS[p] }))} />
      <div className="row2">
        <Field label="Cliente (opcional)" hint={client ? `Debe ${money(client.balanceCents)}` : undefined}>
          {id => (
            <>
              <input id={id} list="sale-clients" autoComplete="off" value={name} onChange={e => setName(e.target.value)} placeholder="Nombre" />
              <datalist id="sale-clients">
                {clients?.map(c => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Descuento a toda la venta">{id => <MoneyInput id={id} value={discount} onChange={setDiscount} currency={settings.currency} />}</Field>
      </div>
      {payment === 'cash' && (
        <div className="row2">
          <Field label="Recibido">{id => <MoneyInput id={id} value={received} onChange={setReceived} currency={settings.currency} />}</Field>
          <div className="change">
            <span>Devuelta</span>
            <strong className={change !== null && change < 0 ? 'bad-text' : ''}>{change !== null ? money(change) : '—'}</strong>
          </div>
        </div>
      )}
      {problem && <p className="error-text">{problem}</p>}
    </Modal>
  );
}

export function ReceiptModal({ sale, onClose, children }: { sale: Sale; onClose: () => void; children?: ReactNode }) {
  const { settings } = useSession();
  const client = useLiveQuery(() => (sale.clientId ? db.clients.get(sale.clientId) : undefined), [sale.clientId]);
  const text = receiptText(sale, settings);
  return (
    <Modal
      title={`Recibo #${receiptNumber(sale)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => void shareText(text, `Recibo #${receiptNumber(sale)}`)}>
            <Icon name="share" /> Compartir
          </button>
          <button className="btn whatsapp" onClick={() => openWhatsApp(text, client?.phone)}>
            <Icon name="chat" /> WhatsApp{client?.phone ? ` a ${client.name}` : ''}
          </button>
          <button className="btn primary" onClick={onClose}>
            Listo
          </button>
        </>
      }
    >
      <pre className="receipt">{text.replace(/\*/g, '')}</pre>
      {children}
    </Modal>
  );
}
