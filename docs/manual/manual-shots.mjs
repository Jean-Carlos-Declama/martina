import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Capturas para el manual: un iPad acostado (1180x820) con datos de ejemplo de un colmado.
const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });
const URL = 'http://localhost:4173/martina/';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1.5, hasTouch: true, locale: 'es-DO', timezoneId: 'America/Santo_Domingo' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const shot = async (name, locator) => {
  await page.waitForTimeout(250);
  await (locator ?? page).screenshot({ path: `${OUT}\\${name}.png` });
};
const clearToasts = async () => {};
const nav = name => page.locator('nav').getByRole('button', { name, exact: true }).click();
const modal = () => page.locator('.modal').last();
const pin = async value => {
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
};

try {
// Bienvenida y PIN
await page.goto(URL);
await page.addStyleTag({ content: '.toasts { display: none !important; }' });
await page.getByLabel('Nombre del negocio').fill('Colmado Martina');
await shot('m01-bienvenida');
await page.getByRole('button', { name: 'Siguiente: crear mi PIN' }).click();
await page.keyboard.type('12');
await shot('m02-crear-pin');
await page.keyboard.type('34');
await page.keyboard.press('Enter');
await page.getByRole('heading', { name: 'Repite tu PIN' }).waitFor();
await pin('1234');
await page.getByText('Hola, Martina').waitFor();

// Productos
await nav('Productos');
const products = [
  { name: 'Refresco Coca-Cola 20oz', barcode: '7501055300075', cost: '30', price: '50', stock: '24', min: '6' },
  { name: 'Pan de agua', cost: '5', price: '10', stock: '3', min: '5' },
  { name: 'Arroz', cost: '32', price: '40', stock: '50', min: '10', unit: 'libra' },
  { name: 'Huevos', cost: '8', price: '10', stock: '60', min: '12' },
  { name: 'Aceite Crisol 16oz', cost: '90', price: '120', stock: '8', min: '3' },
  { name: 'Salami Induveca', cost: '120', price: '160', stock: '0', min: '2', unit: 'libra' },
];
for (const p of products) {
  await page.getByRole('button', { name: 'Nuevo producto' }).click();
  await page.getByLabel('Nombre', { exact: true }).fill(p.name);
  if (p.barcode) await page.getByLabel('Código de barras').fill(p.barcode);
  await page.getByLabel('Costo (lo que te cuesta)').fill(p.cost);
  await page.getByLabel('Precio de venta').fill(p.price);
  await page.getByLabel('Existencia que hay ahora').fill(p.stock);
  await page.getByLabel('Avisar cuando queden').fill(p.min);
  if (p.unit) await page.getByLabel('Se vende por').selectOption(p.unit);
  if (p.name === 'Aceite Crisol 16oz') await shot('m10-producto-nuevo');
  await modal().getByRole('button', { name: 'Guardar' }).click();
  await page.locator('.modal').waitFor({ state: 'detached' });
}
await clearToasts();
await shot('m09-productos');

// Clientes
await nav('Clientes');
for (const c of [
  { name: 'Doña Rosa', phone: '809-555-1234' },
  { name: 'Pedro Gómez', phone: '829-555-9876' },
]) {
  await page.getByRole('button', { name: 'Nuevo cliente' }).click();
  await page.getByLabel('Nombre', { exact: true }).fill(c.name);
  await page.getByLabel('Teléfono / WhatsApp').fill(c.phone);
  if (c.name === 'Pedro Gómez') await shot('m15-cliente-nuevo');
  await modal().getByRole('button', { name: 'Guardar' }).click();
  await page.locator('.modal').waitFor({ state: 'detached' });
}

// Lotería
await nav('Lotería');
const play = async (name, amount, credit = false) => {
  await page.getByLabel('Cliente').fill(name);
  await page.getByLabel('Cuánto jugó').fill(amount);
  if (credit) await page.getByLabel('Fiado').check();
  await page.getByRole('button', { name: 'Anotar jugada' }).click();
  await page.waitForTimeout(350);
};
await play('Ana', '400');
await play('Pedro Gómez', '300');
await play('Luis', '200');
await play('Pedro Gómez', '300');
await play('Doña Rosa', '150', true);
await page.getByLabel('Cliente').fill('Juana');
await page.getByLabel('Cuánto jugó').fill('100');
await clearToasts();
await shot('m05-loteria');
await page.getByLabel('Cliente').fill('');
await page.getByLabel('Cuánto jugó').fill('');
await page.getByRole('tab', { name: 'Pagar premio' }).click();
const prize = async (name, amount) => {
  await page.getByLabel('Cliente').fill(name);
  await page.getByLabel('Cuánto se sacó').fill(amount);
  await page.getByRole('button', { name: 'Pagar premio' }).click();
  await page.waitForTimeout(350);
};
await prize('Ana', '150');
await prize('Luis', '250');
await page.getByLabel('Cliente').fill('Ana');
await page.getByLabel('Cuánto se sacó').fill('50');
await clearToasts();
await shot('m06-loteria-premio');
await page.getByLabel('Cliente').fill('');
await page.getByLabel('Cuánto se sacó').fill('');
await page.mouse.wheel(0, 600);
await clearToasts();
await shot('m07-loteria-tabla');
await page.mouse.wheel(0, -2000);
await page.getByRole('button', { name: 'Cerrar el día' }).click();
await shot('m08-cerrar-dia');
await modal().getByRole('button', { name: 'Cancelar' }).click();

// Vender
await nav('Vender');
await page.locator('.product-tile', { hasText: 'Refresco' }).click();
await page.locator('.product-tile', { hasText: 'Refresco' }).click();
await page.locator('.product-tile', { hasText: 'Huevos' }).click();
await page.locator('.cart-line', { hasText: 'Huevos' }).click();
await modal().getByLabel(/^Cantidad/).fill('12');
await shot('m12-cantidad');
await modal().getByRole('button', { name: 'Listo' }).click();
await page.locator('.product-tile', { hasText: 'Pan de agua' }).click();
await clearToasts();
await shot('m11-vender');
await page.locator('.sell-cart').getByRole('button', { name: /Cobrar/ }).click();
await page.getByLabel('Recibido').fill('500');
await shot('m13-cobrar');
await modal().getByRole('button', { name: /Cobrar/ }).click();
await page.getByRole('heading', { name: /Recibo #/ }).waitFor();
await clearToasts();
await shot('m14-recibo');
await modal().getByRole('button', { name: 'Listo' }).click();
// Una venta fiada a Doña Rosa
await page.locator('.product-tile', { hasText: 'Aceite' }).click();
await page.locator('.product-tile', { hasText: 'Arroz' }).click();
await page.locator('.sell-cart').getByRole('button', { name: /Cobrar/ }).click();
await modal().getByRole('tab', { name: 'Fiado' }).click();
await page.getByLabel('Cliente (opcional)').fill('Doña Rosa');
await modal().getByRole('button', { name: /Cobrar/ }).click();
await modal().getByRole('button', { name: 'Listo' }).click();

// Ficha de producto y entrada de mercancía
await nav('Productos');
await page.getByRole('button', { name: /Pan de agua/ }).click();
await page.getByRole('button', { name: 'Entrada de mercancía' }).click();
await modal().getByLabel(/^Cantidad/).fill('40');
await modal().getByLabel('Costo de cada uno').fill('5');
await modal().getByLabel(/Nota/).fill('Panadería La Esperanza');
await shot('m17-entrada');
await modal().getByRole('button', { name: 'Guardar' }).click();
await page.waitForTimeout(400);
await clearToasts();
await shot('m16-ficha-producto');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// Cliente con fiado y abono
await nav('Clientes');
await page.getByRole('button', { name: /Doña Rosa/ }).click();
await page.getByRole('button', { name: 'Registrar abono' }).click();
await modal().getByLabel('Cuánto abona').fill('200');
await shot('m19-abono');
await modal().getByRole('button', { name: 'Registrar abono' }).click();
await page.waitForTimeout(400);
await clearToasts();
await shot('m18-cliente');
await page.keyboard.press('Escape');

// Ventas
await nav('Ventas');
await clearToasts();
await shot('m20-ventas');
await page.getByRole('button', { name: /Cliente general/ }).first().click();
await shot('m21-venta-detalle');
await page.keyboard.press('Escape');

// Inicio
await nav('Inicio');
await clearToasts();
await shot('m04-inicio');

// Reportes
await nav('Reportes');
await page.getByRole('tab', { name: 'Hoy' }).click();
await clearToasts();
await shot('m22-reportes');

// Ajustes
await nav('Ajustes');
await page.getByRole('heading', { name: 'Negocio' }).scrollIntoViewIfNeeded();
await clearToasts();
await shot('m24-ajustes-negocio');
await page.getByRole('button', { name: 'Agregar persona' }).click();
await modal().getByLabel('Nombre').fill('Juan');
await modal().getByLabel('Puede').selectOption('employee');
await shot('m25-agregar-persona');
await page.keyboard.press('Escape');

// Entrada con PIN (al final, para que se vea la dueña)
await page.locator('nav').getByRole('button', { name: 'Bloquear' }).click();
await page.keyboard.type('12');
await shot('m03-pin');

// iPad de pie
await page.keyboard.press('Backspace');
await page.keyboard.press('Backspace');
await pin('1234');
await page.getByText('Hola, Martina').waitFor();
await page.setViewportSize({ width: 820, height: 1180 });
await nav('Lotería');
await clearToasts();
await shot('m26-de-pie');

} catch (e) { await page.screenshot({ path: `${OUT}/fallo.png` }); console.log('FALLO:', String(e).slice(0,300)); console.log('PANTALLA:', (await page.locator('body').innerText()).slice(0,600)); }
console.log('ERRORES:', errors.length ? errors.join('\n') : 'ninguno');
await browser.close();
