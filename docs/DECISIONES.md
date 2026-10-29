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

- **En cada equipo, en IndexedDB** (con la librería Dexie). Si el equipo está vinculado, también en la nube (ver la sección 2b).
- Al arrancar se llama `navigator.storage.persist()`. Además, Safari no le aplica el borrado de 7 días a las apps agregadas a la pantalla de inicio.
- 🔴 **Sin vincular, si se borra el ícono de la app, se borran los datos.** Por eso existe el **respaldo**: un archivo JSON con todo, fotos incluidas, que se guarda en Archivos o iCloud o se manda por WhatsApp, y se recupera desde Ajustes. Mientras el equipo no esté vinculado, la pantalla de inicio avisa si pasó más de una semana sin respaldo.
- **Cambios de tablas:** se agrega una versión nueva en `src/db/database.ts` (hoy va la 2). Una versión ya publicada nunca se modifica, y con tablas sincronizadas **no se usa `upgrade()`**.
- **La base no tiene índices únicos.** Con varios equipos, dos podrían crear lo mismo sin internet, y la copia que llega del otro no entraría. Lo que no se puede repetir (código interno, código de barras) lo revisa el dominio al crear o editar.

## 2b. Sincronización entre equipos (Dexie Cloud + enlace con QR)

- **Para qué:** Martina en el iPad y en el teléfono, un empleado en otro equipo y el dueño mirando desde el suyo. Todos ven y anotan lo mismo. Funciona sin internet y sube los cambios cuando vuelve la conexión. Además, la nube sirve de copia.
- **Servicio:** [Dexie Cloud](https://dexie.org/cloud/), base `https://zkt9dfbzm.dexie.cloud`, plan gratis.
  - El plan gratis tiene 3 usuarios de producción y 100 MB.
  - **Todo el negocio cuenta como UN solo usuario** (`negocio-martina`): cada equipo vinculado entra como él.
  - Quién es la dueña, el empleado o «solo mirar» lo decide el **PIN** dentro de la app.
- **Usuario de evaluación:** Dexie Cloud trata al usuario nuevo como de evaluación durante 14 días. 🔴 Hay que pasarlo a producción en `manager.dexie.cloud`, en Users, y marcar `negocio-martina` como producción. Es gratis dentro de los 3 del plan.
- **Vincular con QR:**
  - El QR lleva la **llave del negocio**.
  - El equipo nuevo se la manda al **enlace**, un Cloudflare Worker en `enlace/` (`https://martina-enlace.martina-rd.workers.dev`).
  - El enlace la compara y, si coincide, le pide a Dexie Cloud un permiso (`client_credentials`, `sub = negocio-martina`).
  - La clave de Dexie Cloud y la llave del negocio viven **solo** como secretos de Cloudflare. El código es público.
  - El enlace tiene sus propias pruebas en `enlace/enlace.test.js`.
- **iPhone/iPad:** la app agregada a la pantalla de inicio guarda sus datos **aparte de Safari**. Por eso el QR se escanea **desde dentro de la app**. Si se escanea con la cámara normal, Safari abre una página que explica cómo hacerlo.
- **Equipo principal y equipos nuevos:**
  - El equipo principal se activa una sola vez con el QR de activación (`enlace/.activacion-qr.png`, solo en la PC del dueño) y **sube** lo que tenía.
  - Cualquier otro equipo que se vincule **borra** primero lo suyo, para no mezclar datos de prueba, y baja lo del negocio.
  - La primera vez, los datos de la base vieja «martina» (antes de sincronizar) se copian solos a la base nueva.
- **Para que dos equipos no se pisen:**
  - La existencia y lo que debe cada cliente se cambian con `add()` («súmale / réstale»), no con «ponle X».
  - Cada equipo numera sus recibos con su letra (#A-12, #B-3), guardada en la tabla `local`, que no se sincroniza.
  - Una transacción se aplica completa o no se aplica.
- **Quitar un equipo:** la dueña lo marca como quitado. Cuando ese equipo se conecta, borra todo y se desvincula.
- **Cambiar la llave:** `enlace\publicar.ps1 -NuevaLlave`. Los QR viejos dejan de servir; los equipos ya vinculados siguen funcionando.
- **Mientras `src/config.ts` esté vacío**, la app vuelve a guardar solo en el equipo, como al principio.
- **Probado:** con dos navegadores contra la nube real:
  1. El equipo principal subió lo que tenía.
  2. El segundo equipo se vinculó y entró con el mismo PIN.
  3. El segundo vio la jugada anotada en el primero y vendió (recibo #B-1).
  4. El primero vio bajar la existencia.
  5. Después se borró todo lo de la prueba de la nube.

## 3. Dinero y cantidades

- **Dinero:** siempre en **centavos enteros**, para que no haya errores de decimales. Se muestra como `RD$ 1,234.50`.
- **Cantidades:** pueden llevar hasta 3 decimales (libras, litros) y se redondean después de cada operación.
- **ITBIS:** los precios ya lo incluyen. El recibo muestra cuánto ITBIS va dentro, y solo si se activa en Ajustes.
- **Moneda:** en Ajustes se escoge RD$, US$ o €. Cambia **solo el símbolo** en toda la app y en los recibos; no convierte las cantidades ya anotadas. No se manejan dos monedas a la vez.

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
  - **Faltante:** si los premios y la comisión pasan la venta, la cuenta da negativo (vende 100, comisión 20, premio 120 → −40). Se muestra **en rojo como «Faltante»** en el cuadre, en Inicio, en Reportes y en el mensaje de WhatsApp.
  - La tabla de clientes junta los nombres aunque se escriban distinto («Pedro», «pedro »).
  - Abajo hay dos listas: **«Premios pagados»** (quién se sacó qué) y **«Jugadas»**. Cada una muestra cuántas son y el total.
- **Corregir:** una jugada o un premio se corrige (cliente, monto, lotería) con el lápiz, mientras su día esté abierto, y el cuadre se recalcula solo. Si la jugada era fiada, se ajusta la diferencia en la cuenta del cliente; su cliente no se cambia, se anula y se anota otra vez. Pide el PIN de la dueña y queda en la bitácora.
- **Días anteriores:** con las flechas o el calendario se va a un día anterior y se anotan jugadas o premios que faltaron, si ese día sigue abierto. Si está cerrado, la dueña lo reabre. Un empleado necesita el PIN de la dueña. No se puede anotar en días que no han llegado. Al cambiar de día, el formulario empieza limpio.
- **Cierre:** solo la dueña cierra el día. Se guardan los totales y ya no se puede anotar ni anular nada de ese día. Para corregir, ella lo reabre y tiene que dar un motivo (queda en la bitácora). El cierre de la lotería **no** frena las ventas de la tienda.
- **Fiado:** la lotería fiada va a la misma cuenta del cliente que el fiado de la tienda, y se paga con abonos.

## 6b. Clientes y lo que deben

- **«Pendiente por cobrar»:** es lo que deben todos los clientes juntos (fiado de la tienda y de la lotería, menos los abonos). Se ve en Inicio y arriba en Clientes. Al tocarlo se abre la lista de quién debe, de más a menos, con un botón **Abonar** en cada uno.
- **Abono:** se ve cuánto debe ahora y cuánto quedará después del abono. No se puede abonar más de lo que debe.
- **Fechas anteriores:** un abono o una **deuda anotada a mano** (por ejemplo, lo que debía en la libreta antes de la app) se puede anotar con la fecha de un día anterior. Nunca en un día que no ha llegado.
- **Corregir:** los abonos y las deudas a mano se **corrigen** (monto, fecha, nota) o se **anulan**, de cualquier fecha, con el PIN de la dueña. Lo que debe el cliente se ajusta con la diferencia (`add()`), y nunca queda debiendo menos de cero. Lo que viene de una venta o una jugada se corrige allá (Ventas o Lotería); la cuenta lo indica.
- **La cuenta:** se muestra en orden de fecha, y «Quedó debiendo» se calcula sumando por fecha: así una corrección o algo anotado con fecha anterior queda en su lugar. Se puede ver **todo**, **este mes** o **el mes pasado**.
- **Datos del cliente** (nombre, teléfono, nota, límite): se editan con el lápiz de la lista o con «Editar datos» en su ficha.
- **Lo que debe, a la vista:**
  - En la lista de clientes, cada fila muestra «Debe RD$ …» grande a la derecha. En pantallas angostas (teléfono), «Abonar» y el lápiz bajan a otra línea para no tapar el monto.
  - En la Lotería, debajo del nombre de cada cliente de «Clientes del día» sale en rojo lo que debe. Se busca por el cliente enlazado o, si se anotó sin escogerlo, por su nombre.
  - Al anotar una jugada o vender fiado, debajo del nombre se ve cuánto debe ese cliente y, en la venta, cuánto deberá con ella.
- **Fiar a un nombre nuevo:** antes había que registrar primero al cliente y la casilla «Fiado» salía desactivada sin explicar por qué. Ahora, al fiarle a un nombre que no está registrado, la app lo registra como cliente (sin duplicar nombres) y le anota el fiado a su cuenta.
- **Nombre a medias o mal escrito («Pedro», «rosa», «Pedro Gomes», «Pedor»):** debajo del campo salen los clientes parecidos con lo que debe cada uno; tocar uno pone su nombre. Cada palabra escrita tiene que ser el comienzo de una palabra del nombre, sin tildes ni mayúsculas, aceptando que se escriba como suena (z/s, ce/ci, v/b, ll/y, sin h, letras dobles) y, desde 4 letras, una letra mal o dos volteadas (dos desde 7 letras). Si el nombre escrito ya es un cliente pero hay otro casi igual, avisa «Ojo, también está…» (posible cuenta repetida).
- **Nunca se abre una cuenta sin preguntar:** al fiarle a un nombre que no es exactamente un cliente, la app pregunta **«¿A quién se le fía?»** (si hay parecidos: «Sí, es Pedro Gómez» con lo que debe, «No, es otra persona», Cancelar) o **«¿Cliente nuevo?»** («Sí, registrar y fiar» / «No, voy a corregir el nombre»). El cliente nuevo se registra **en la misma transacción** que la venta o la jugada (`newClientName` en `createSale` y `addLotterySale`): si la venta falla (por ejemplo, no hay existencia), no queda un cliente suelto. La comparación vive en `domain/clients.ts` (`exactClient`, `similarClients`) y tiene prueba.
- **Límite de fiado, antes de fiar:** la misma regla (`passesCreditLimit` en `domain/credit.ts`) avisa en pantalla y no deja guardar. En Cobrar y en Lotería, si se pasa, lo dice («se pasa de su límite de RD$ 120.00: solo se le pueden fiar RD$ 20.00 más») y el botón se apaga, en vez de un aviso de 5 segundos después de tocarlo.
- **Saldo a favor:** pasa de verdad (por ejemplo, se anula una jugada fiada que ya estaba abonada) y no se corta a cero, porque son pesos que el cliente pagó. Todas las pantallas lo dicen igual (`balanceLabel`): «debe RD$ X», «a favor RD$ X» (en verde) o «al día»; al fiar, «le quedan RD$ X a favor» o «quedará debiendo RD$ X»; el recibo dice «tiene a favor». Con saldo a favor se puede corregir la fecha o la nota de un abono, o un cambio que lo acerque a cero; solo se frena un cambio que lo deje más en negativo.
- **Desde la Lotería:** tocar el nombre de un cliente registrado en «Clientes del día» abre su cuenta encima (abonar, WhatsApp, editar), sin perder el día ni lo escrito en el formulario. Las listas de jugadas y premios también dicen lo que debe cada uno. Anular una jugada fiada avisa cómo queda su cuenta.
- **Clientes archivados que deben:** no se puede archivar a quien debe. Si un archivado vuelve a deber (se le fía o se anula un abono), se **reactiva solo**. Y si por sincronización queda archivado con deuda, igual sale en «Todos» y «Deben» con la etiqueta «archivado», y su deuda cuenta en «Pendiente por cobrar» igual que en Inicio y Reportes.
- **Buscar:** por nombre o por teléfono (se comparan solo los dígitos, con o sin guiones). Si no sale nadie con el filtro de ahora pero el cliente está en otro (por ejemplo, en «Deben» buscando a uno que está al día), lo dice y ofrece «Ver en …».
- **Fiado a la vista en todas partes:** en Ventas y en las listas de la Lotería lo fiado lleva la etiqueta roja «Fiado» y el monto en rojo; el recibo de una venta fiada (también por WhatsApp) dice cuánto debe el cliente en total; en Inicio la tarjeta «Pendiente por cobrar» va arriba con los 3 que más deben; en Reportes, «Quién debe más» lleva a la lista para abonar.
- **En el teléfono (≤ 700 px):** el menú de abajo deja Inicio, Lotería, Vender, Clientes y **«Más»** (Productos, Ventas, Reportes, Ajustes, Bloquear), para que nada quede escondido de lado. La cuenta del cliente y las tablas de Reportes se vuelven tarjetitas (sin deslizar de lado). «RD$» va pegado al número con un espacio duro (nunca se parte) y en los cuadros de números la letra se achica sola si la cifra no cabe (`container-type` + `cqi`; en un Safari viejo, sin eso, queda el tamaño de siempre).

## 7. Seguridad

- **PIN:** cada persona tiene uno de 4 a 6 números. Se guarda como huella **PBKDF2-SHA256 con 100 000 vueltas** y una sal propia, nunca el PIN en claro.
- **Dueña:** puede hacer todo.
- **Empleado:**
  - Puede vender, anotar lotería y cobrar fiado.
  - No ve costos, ganancias ni reportes.
  - Para anular, devolver, cerrar el día o mover inventario necesita que la dueña ponga su PIN.
- **Solo mirar:** ve todo, también costos, ganancias y reportes, pero no puede anotar ni cambiar nada. Es para el dueño que revisa desde su teléfono. Lo controla la pantalla, no la nube.
- **El PIN de la bienvenida** se crea con el teclado de números de la app, no con campos de contraseña: el iPhone/iPad los llenaba solo con una «contraseña segura».
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
