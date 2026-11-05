import type { ReactNode } from 'react';
import type { PaymentMethod } from '../db/types';
import { PAYMENT_LABELS } from './format';

// El logo de cada forma de pago, dibujado aquí mismo (sin internet): Zelle morado, Cash App verde, el efectivo un
// billete verde, la transferencia flechas azules, la tarjeta una tarjeta ámbar y el fiado una libreta roja.

const LOGOS: Record<PaymentMethod, ReactNode> = {
  cash: (
    <>
      <rect x="1.5" y="5.5" width="21" height="13" rx="2" fill="#2e7d32" />
      <rect x="3.5" y="7.5" width="17" height="9" rx="1" fill="none" stroke="#a5d6a7" strokeWidth="1" />
      <circle cx="12" cy="12" r="2.8" fill="#c8e6c9" />
    </>
  ),
  zelle: (
    <>
      <rect width="24" height="24" rx="6" fill="#6d1ed4" />
      <path fill="#fff" d="M11 3.5h2v3h-2zM11 17.5h2v3h-2zM6.5 6.5h11v2.6l-7.4 6.3h7.4v2.1h-11v-2.6l7.4-6.3H6.5z" />
    </>
  ),
  cashapp: (
    <>
      <rect width="24" height="24" rx="6" fill="#00d632" />
      <text x="12" y="17.3" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontSize="15" fontWeight="700" fill="#fff">
        $
      </text>
    </>
  ),
  transfer: (
    <>
      <rect width="24" height="24" rx="6" fill="#1565c0" />
      <path d="M6.5 9h10M13.5 6l3 3-3 3M17.5 15h-10M10.5 12l-3 3 3 3" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  card: (
    <>
      <rect x="1.5" y="4.5" width="21" height="15" rx="2.5" fill="#b45309" />
      <rect x="1.5" y="8" width="21" height="2.6" fill="#7c3a06" />
      <rect x="4.5" y="13" width="4.5" height="3.2" rx="0.7" fill="#fcd34d" />
    </>
  ),
  credit: (
    <>
      <rect width="24" height="24" rx="6" fill="#c4321f" />
      <path d="M7 8h10M7 12h10M7 16h6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
};

/** El logo de una forma de pago. */
export function PayLogo({ payment, size = 20 }: { payment: PaymentMethod; size?: number }) {
  return (
    <svg className="pay-logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {LOGOS[payment] ?? LOGOS.cash}
    </svg>
  );
}

/** Las formas de pago para escoger (Cobrar y Lotería), cada una con su logo. */
export function payOptions() {
  return (Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map(p => ({ value: p, label: PAYMENT_LABELS[p], icon: <PayLogo payment={p} /> }));
}

/** Etiqueta con el logo y el nombre de la forma de pago (listas de ventas y jugadas). */
export function PayTag({ payment }: { payment: PaymentMethod }) {
  return (
    <span className={`tag pay pay-${payment}`}>
      <PayLogo payment={payment} size={14} />
      {PAYMENT_LABELS[payment]}
    </span>
  );
}
