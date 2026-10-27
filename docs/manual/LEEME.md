# Manual de Martina (PDF)

El manual para Martina se arma desde `manual.html` y las capturas `m*.png`, que son de datos de ejemplo.

Para rehacerlo después de cambiar la app:

1. Compila y sirve la app: `npm run build` y luego `npx vite preview --port 4173`.
2. Saca las capturas nuevas:
   ```
   node manual-shots.mjs <carpeta>
   ```
   Usa Chrome y `playwright-core`.
3. Copia las capturas aquí y revisa el texto de `manual.html`.
4. Genera el PDF:
   ```
   node pdf.mjs manual.html "<Escritorio>\Manual de Martina.pdf"
   ```

`m23-equipos.png` sale de la prueba de sincronización con dos equipos (`iPad de prueba` y `Teléfono de prueba`).

🔴 Nunca pongas en el manual una captura del QR de vincular: es la llave del negocio.
