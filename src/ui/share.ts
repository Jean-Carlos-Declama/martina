import type { Client, Sale, Settings } from '../db/types';
import type { DayReport } from '../domain/lottery';
import { receiptNumber } from '../domain/sales';
import { dayLabel, formatDateTime, formatMoney, formatQty, PAYMENT_LABELS } from './format';

// Textos para mandar por WhatsApp (recibo, cuadre de lotería, recordatorio de fiado) y cómo abrirlo.

export function receiptText(sale: Sale, settings: Settings): string {
  const money = (cents: number) => formatMoney(cents, settings.currency);
  const lines = [
    `*${settings.businessName}*`,
    `Recibo #${receiptNumber(sale)} · ${formatDateTime(sale.date)}`,
    sale.clientName ? `Cliente: ${sale.clientName}` : '',
    '',
    ...sale.lines.map(line => {
      const total = Math.round(line.priceCents * line.quantity) - line.discountCents;
      const discount = line.discountCents > 0 ? ` (desc. ${money(line.discountCents)})` : '';
      return `${formatQty(line.quantity)} x ${line.name} — ${money(total)}${discount}`;
    }),
    '',
    sale.discountCents > 0 ? `Descuento: -${money(sale.discountCents)}` : '',
    `*Total: ${money(sale.totalCents)}*`,
    sale.taxCents > 0 ? `ITBIS incluido: ${money(sale.taxCents)}` : '',
    `Pago: ${PAYMENT_LABELS[sale.payment]}`,
    sale.status === 'void' ? '*** VENTA ANULADA ***' : '',
    '',
    settings.receiptFooter,
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function lotteryDayText(report: DayReport, settings: Settings): string {
  const money = (cents: number) => formatMoney(cents, settings.currency);
  const t = report.totals;
  const rows = report.clients.map(c => {
    const prize = c.prizes > 0 ? ` · premio ${c.prizes}x ${money(c.prizesCents)}` : '';
    return `${c.name}: ${c.purchases}x ${money(c.purchasesCents)}${prize}`;
  });
  return [
    `*Lotería — ${settings.businessName}*`,
    dayLabel(report.dayKey),
    '',
    ...rows,
    '',
    `Venta: ${money(t.salesCents)} (${t.salesCount})`,
    `Comisión ${t.commissionPct}%: ${money(t.commissionCents)}`,
    `Premios: ${money(t.prizesCents)} (${t.prizesCount})`,
    `*A entregar: ${money(t.deliverCents)}*`,
    report.status === 'closed' ? '(día cerrado)' : '',
  ]
    .join('\n')
    .trim();
}

export function debtText(client: Client, settings: Settings): string {
  return `Hola ${client.name}, le saluda ${settings.businessName}. Le recordamos que tiene un balance pendiente de ${formatMoney(client.balanceCents, settings.currency)}. ¡Gracias!`;
}

/** Número de WhatsApp: los de RD (809/829/849) con el 1 delante. */
export function whatsappNumber(phone?: string): string | undefined {
  const digits = phone?.replace(/\D/g, '');
  if (!digits) return undefined;
  return digits.length === 10 ? `1${digits}` : digits;
}

/** Abre WhatsApp con el mensaje (si hay número, directo a esa persona; si no, ella escoge a quién). */
export function openWhatsApp(text: string, phone?: string): void {
  const number = whatsappNumber(phone);
  const url = `https://wa.me/${number ?? ''}?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
}

/** Guarda un archivo: el menú de compartir del iPad (Archivos, WhatsApp, AirDrop) o, si no hay, una descarga. */
export async function shareOrDownload(file: File): Promise<boolean> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

/** El menú de compartir del iPad (WhatsApp, Mensajes, Notas...). Devuelve false si no hay. */
export async function shareText(text: string, title?: string): Promise<boolean> {
  if (!navigator.share) return false;
  try {
    await navigator.share({ text, title });
  } catch {
    // Cerró el menú sin compartir: no es un error.
  }
  return true;
}
