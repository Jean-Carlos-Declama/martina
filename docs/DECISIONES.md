# Martina: decisiones técnicas

Una app para el iPad de Martina con dos partes:

- **Tienda (colmadito):** inventario, ventas, fiado, recibos por WhatsApp y reportes de ganancia.
- **Lotería:** lo que antes anotaba en la libreta. Cada día lleva los clientes, lo que jugó cada uno, los premios que cobraron, la venta, su comisión y lo que tiene que entregar.

## 1. Cómo se instala: app web instalable (PWA), no App Store

- **Para una app nativa (App Store o TestFlight) hace falta:** una Mac con Xcode, la cuenta Apple Developer (US$99 al año) y firmar la app. Sin eso, no hay manera legal de instalar una app nativa en un iPad que no es de quien la programa.
- **Lo que se eligió:** una PWA servida por HTTPS desde GitHub Pages (`https://jean-carlos-declama.github.io/martina/`). Se instala desde **Safari** con *Compartir › Agregar a pantalla de inicio* y abre a pantalla completa, como una app.
- **Requisitos:** iPadOS 14 o más nuevo, porque la app se compila para Safari 14 (`build.target`). Solo funciona instalada desde Safari: otros navegadores del iPad no la dejan instalar.
- **Qué está probado y qué no:** se probó en Chrome de escritorio con el tamaño de un iPad, acostado (1180×820) y de pie (820×1180), en modo claro y oscuro. **Falta probarla en el iPad real**, sobre todo la cámara para los códigos de barras y el menú de compartir.
- **Actualizaciones:** un *service worker* (vite-plugin-pwa, `registerType: 'prompt'`) busca una versión nueva cada vez que se abre la app y cada hora. Cuando hay una, sale el aviso «Hay una versión nueva» y se instala cuando ella toca *Actualizar ahora*. Así nunca se recarga a mitad de una venta. Los datos no se tocan al actualizar.
- **Sin internet:** todo lo de la app queda guardado en el iPad, así que funciona sin conexión.

## 2. Dónde viven los datos

- **En el iPad, en IndexedDB** (con la librería Dexie). No hay servidor ni nube: nada sale del iPad.
- Al arrancar se llama `navigator.storage.persist()`. Además, Safari no le aplica el borrado de 7 días a las apps agregadas a la pantalla de inicio.
- 🔴 **Si se borra el ícono de la app, se borran los datos.** Por eso existe el **respaldo**: un archivo JSON con todo, fotos incluidas, que se guarda en Archivos o iCloud o se manda por WhatsApp, y se recupera desde Ajustes. La pantalla de inicio avisa si pasó más de una semana sin respaldo.
- **Cambios de tablas:** si en el futuro cambian, se agrega `this.version(2)` en `src/db/database.ts`. Una versión ya publicada nunca se modifica.

## 3. Dinero y cantidades

- **Dinero:** siempre en **centavos enteros**, para que no haya errores de decimales. Se muestra como `RD$ 1,234.50`.
- **Cantidades:** pueden llevar hasta 3 decimales (libras, litros) y se redondean después de cada operación.
- **ITBIS:** los precios ya lo incluyen. El recibo muestra cuánto ITBIS va dentro, y solo si se activa en Ajustes.

## 4. Inventario

- **La existencia no se edita a mano.** Solo cambia con un **movimiento** (`recordMovement`), y cada movimiento guarda qué pasó, cuánto, quién, por qué y cuánto quedó.
- **Tipos de movimiento:**
  - Existencia inicial, entrada (compra) y venta.
  - Devolución de cliente y devolución al proveedor.
  - Ajuste + y ajuste −, dañado o vencido, y uso de la casa.
  - Conteo físico, que anota solo la diferencia.
  - Venta anulada.
- **Costo:** en una entrada con otro costo, el producto queda con el **costo promedio**, así la ganancia es real. El cambio queda en la bitácora.
- **Sin repetidos:** no puede haber dos productos con el mismo código interno ni con el mismo código de barras, porque la base de datos tiene índices únicos.
- **Alertas:** se avisa de lo agotado y de lo que está en el mínimo o por debajo.

## 5. Ventas de la tienda

- **Todo o nada:** cobrar es **una sola transacción**. Revisa la existencia, descuenta el inventario, anota el fiado y numera el recibo. Si algo falla, no queda nada a medias (lo cubre una prueba).
- **Sin doble cobro:** cada venta lleva una llave única (`requestId`). Si tocan dos veces o se reintenta, devuelve la misma venta y no la duplica (también lo cubre una prueba).
- **Anular y devolver:** solo lo puede hacer la dueña o alguien con su PIN. Se pide el motivo y se hacen movimientos contrarios, así que nunca se borra nada. Si la venta era fiada, se le rebaja al cliente.
- **Reportes:** las devoluciones restan el día en que se devolvió el dinero.

## 6. Lotería

- **Qué se anota:** cada jugada lleva cliente, monto, lotería (si hay lista en Ajustes) y si fue fiada. Los premios llevan cliente y monto.
- **El cuadre del día:**
  - **Comisión** = % de la venta del día. Ese % se guarda **en cada día**, para que cambiarlo después no altere los días viejos.
  - **A entregar** = venta − comisión − premios.
  - La tabla de clientes junta los nombres aunque se escriban distinto («Pedro», «pedro »).
- **Cierre:** solo la dueña cierra el día. Se guardan los totales y ya no se puede anotar ni anular nada de ese día. Para corregir, ella lo reabre y tiene que dar un motivo (queda en la bitácora). El cierre de la lotería **no** frena las ventas de la tienda.
- **Fiado:** la lotería fiada va a la misma cuenta del cliente que el fiado de la tienda, y se paga con abonos.

## 7. Seguridad

- **PIN:** cada persona tiene uno de 4 a 6 números. Se guarda como huella **PBKDF2-SHA256 con 100 000 vueltas** y una sal propia, nunca el PIN en claro.
- **Dueña:** puede hacer todo.
- **Empleado:**
  - Puede vender, anotar lotería y cobrar fiado.
  - No ve costos, ganancias ni reportes.
  - Para anular, devolver, cerrar el día o mover inventario necesita que la dueña ponga su PIN.
- **Bloqueo:** la app se bloquea sola tras unos minutos sin usarla (se ajusta). Después de 5 intentos fallidos espera 30 segundos.
- **Bitácora:** guarda quién hizo cada cosa (anulaciones, cierres, ajustes, cambios de precio y costo, conteos).
- **Límite:** esto separa a la dueña del empleado. **No es cifrado:** quien tenga el iPad y sepa usar herramientas de programador podría leer los datos.

## 8. Tecnología

| Qué | Con qué |
|---|---|
| Interfaz | React 19 + TypeScript |
| Compilar | Vite 8 |
| Base de datos | Dexie 4 (IndexedDB) |
| App instalable | vite-plugin-pwa (Workbox) |
| Código de barras con la cámara | @zxing/browser (Safari no trae lector propio); se carga solo al abrir el escáner |
| Lector de códigos USB o Bluetooth | Funciona como un teclado: escribe el código y da Enter en el buscador de Vender |
| Pruebas | Vitest + fake-indexeddb |

**Comandos** (en `E:\Martina`):

```
npm run dev       # probar en la PC (http://localhost:5173/martina/)
npx vitest run    # las pruebas del dominio
npm run build     # la versión para publicar (carpeta dist)
```

**Organización del código:**

- `src/domain`: las reglas del negocio, sin pantallas. Ahí están las pruebas.
- `src/ui`: las pantallas.
- `src/db`: las tablas.

## 9. Pendiente para una segunda parte

- Compras con factura de varios productos, con estado pendiente, recibida o parcial, y devoluciones al proveedor desde la factura.
- Conteo físico de muchos productos de una vez.
- Variantes (tallas, sabores).
- Reportes en PDF.
- Lotería: si vende para **varias bancas con comisiones distintas**, hay que poner un % por lotería o banca. Hoy hay un solo % por día.
