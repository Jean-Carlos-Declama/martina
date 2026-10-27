// Dónde sincroniza la app. Mientras esté vacío, cada equipo guarda sus datos solo (como al principio).
// Estas direcciones no son secretas: lo secreto (la clave de Dexie Cloud y la llave del QR) vive en el "enlace"
// (Cloudflare), nunca aquí, porque este código es público.
export const CLOUD = {
  /** La base en Dexie Cloud (sale de `npx dexie-cloud create`, archivo dexie-cloud.json). */
  databaseUrl: '',
  /** El enlace en Cloudflare que da permiso a un equipo cuando escanea el QR (carpeta enlace/). */
  linkUrl: '',
};
