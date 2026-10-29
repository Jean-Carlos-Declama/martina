import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { db } from '../../db/database';
import type { PaymentMethod, Product, Sale } from '../../db/types';
import { exactClient } from '../../domain/clients';
import { newId } from '../../domain/common';
import { passesCreditLimit } from '../../domain/credit';
import { matchesSearch } from '../../domain/products';
import { createSale, receiptNumber } from '../../domain/sales';
import { ClientSuggestions, CreditPreview, showsSuggestions, useCreditClient, type CreditTarget } from '../clientPick';
import { useSession, useUi } from '../context';
import { balanceLabel, formatQty, moneyField, parseMoney, parseQty, PAYMENT_LABELS, qtyWithUnit } from '../format';
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
  // Redondeado: 1.1 + 2.2 libras no da 3.3000000000000003.
  const units = Math.round(cart.reduce((sum, i) => sum + i.quantity, 0) * 1000) / 1000;

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
          Venta {cart.length > 0 && <small className="muted">({`${formatQty(units)} ${units === 1 ? 'artículo' : 'artículos'}`})</small>}
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
                      setCart(items =>
                        items.flatMap(i => (i.productId !== item.productId ? [i] : i.quantity > 1 ? [{ ...i, quantity: Math.round((i.quantity - 1) * 1000) / 1000 }] : [])),
                      )
                    }
                  >
                    <Icon name="minus" size={18} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="Uno más"
                    onClick={() => setCart(items => items.map(i => (i.productId === item.productId ? { ...i, quantity: Math.round((i.quantity + 1) * 1000) / 1000 } : i)))}
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
          <Icon name="cart" /> {`${formatQty(units)} ${units === 1 ? 'artículo' : 'artículos'}`}
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
            if (sale) {
              if (options.newClientName) toast(`Se registró a ${sale.clientName} como cliente`);
              finish(sale);
            }
          }}
        />
      )}
      {receipt && <ReceiptModal sale={receipt} onClose={() => (setReceipt(null), searchRef.current?.focus())} />}
    </div>
  );
}

function LineEditor({ item, onClose, onSave }: { item: CartItem; onClose: () => void; onSave: (item: CartItem | null) => void }) {
  const { settings, money } = useSession();
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
      {/* Por qué "Listo" está apagado. */}
      {quantity === null ? (
        <p className="error-text">Escribe una cantidad mayor que cero.</p>
      ) : !valid ? (
        <p className="error-text">El descuento no puede pasar de {money(Math.round(item.priceCents * quantity))}.</p>
      ) : null}
    </Modal>
  );
}

interface PayOptions {
  payment: PaymentMethod;
  clientId?: string;
  clientName?: string;
  /** Fiado a alguien nuevo: se registra como cliente junto con la venta. */
  newClientName?: string;
  discountCents?: number;
}

function Checkout({ subtotal, onClose, onPay }: { subtotal: number; onClose: () => void; onPay: (options: PayOptions) => Promise<void> }) {
  const { money, settings } = useSession();
  const { resolveClient, prompt, clients } = useCreditClient();
  const [payment, setPayment] = useState<PaymentMethod>('cash');
  const [name, setName] = useState('');
  const [discount, setDiscount] = useState('');
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const client = exactClient(name, clients);
  const fiado = payment === 'credit';
  const discountCents = parseMoney(discount) ?? 0;
  const total = subtotal - discountCents;
  const receivedCents = parseMoney(received);
  const change = receivedCents !== null ? receivedCents - total : null;
  const overLimit = fiado && !!client && passesCreditLimit(client, total);
  const problem =
    discountCents > subtotal
      ? 'El descuento es mayor que la venta.'
      : fiado && !name.trim()
        ? 'Para fiar, escribe o escoge a quién se le fía.'
        : overLimit
          ? `No se puede fiar: ${client.name} se pasaría de su límite de fiado.`
          : payment === 'cash' && change !== null && change < 0
            ? 'Lo recibido no alcanza.'
            : '';

  // Lo que debe el cliente, bien visible (y cómo queda si se le fía esta venta). Rojo si queda debiendo, verde si no.
  const owes = client ? (
    <p className={`owes-line${overLimit || (fiado ? client.balanceCents + total : client.balanceCents) > 0 ? '' : ' good'}`}>
      <CreditPreview client={client} amountCents={fiado && total > 0 ? total : undefined} what="esta venta" />
    </p>
  ) : null;

  return (
    <Modal
      title={`${fiado ? 'Fiar' : 'Cobrar'} ${money(total)}`}
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
              // Fiado a alguien que no es un cliente registrado: siempre pregunta (¿es uno de estos parecidos?, ¿cliente nuevo?).
              let target: CreditTarget | null = client ? { client } : null;
              if (fiado && !client) {
                target = await resolveClient(name, total);
                if (!target) return setBusy(false);
                if ('client' in target) {
                  setName(target.client.name);
                  // Si se pasa de su límite, no se fía: la línea de lo que debe lo dice y el botón se apaga.
                  if (passesCreditLimit(target.client, total)) return setBusy(false);
                }
              }
              await onPay({
                payment,
                clientId: target && 'client' in target ? target.client.id : undefined,
                newClientName: target && 'newClientName' in target ? target.newClientName : undefined,
                clientName: target ? undefined : name.trim() || undefined,
                discountCents,
              });
              setBusy(false);
            }}
          >
            <Icon name="check" /> {fiado ? 'Fiar' : 'Cobrar'} {money(total)}
          </button>
        </>
      }
    >
      <Segmented
        className="pay-tabs"
        value={payment}
        onChange={setPayment}
        options={(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map(p => ({ value: p, label: PAYMENT_LABELS[p] }))}
      />
      <div className="row2">
        <Field
          className={fiado ? 'full' : ''}
          label={fiado ? 'Cliente (a quién se le fía)' : 'Cliente (opcional)'}
          hint={
            !client && fiado && name.trim()
              ? showsSuggestions(name, clients)
                ? 'Si es uno de estos clientes, tócalo. Si no, al fiar te pregunta si registras el nombre nuevo.'
                : 'Nombre nuevo: al fiar te pregunta si lo registras como cliente.'
              : undefined
          }
        >
          {id => (
            <>
              <input id={id} list="sale-clients" autoComplete="off" autoCapitalize="words" value={name} onChange={e => setName(e.target.value)} placeholder="Nombre" />
              <datalist id="sale-clients">
                {clients
                  ?.filter(c => c.active || c.balanceCents > 0)
                  .map(c => (
                    <option key={c.id} value={c.name} label={balanceLabel(c.balanceCents, money)} />
                  ))}
              </datalist>
              <ClientSuggestions name={name} clients={clients} onPick={c => setName(c.name)} />
            </>
          )}
        </Field>
        <Field label="Descuento a toda la venta">{id => <MoneyInput id={id} value={discount} onChange={setDiscount} currency={settings.currency} />}</Field>
      </div>
      {owes}
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
      {prompt}
    </Modal>
  );
}


export function ReceiptModal({ sale, onClose, children }: { sale: Sale; onClose: () => void; children?: ReactNode }) {
  const { settings } = useSession();
  const client = useLiveQuery(() => (sale.clientId ? db.clients.get(sale.clientId) : undefined), [sale.clientId]);
  const text = receiptText(sale, settings, client?.balanceCents);
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
