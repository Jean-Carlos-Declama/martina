import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App.tsx'
import { startCloud } from './db/cloud'
import { db } from './db/database'

// Solo en una compilación de prueba (VITE_PRUEBAS=1): la base a mano para que las pruebas limpien lo que dejan en la nube.
if (import.meta.env.VITE_PRUEBAS) (window as unknown as { martinaDb: typeof db }).martinaDb = db

// La nube se configura antes de que la app toque la base. Si falla (sin internet al vincular), la app abre igual
// y lo dice en Ajustes; lo anotado se sube cuando vuelva la conexión.
let startError: unknown
startCloud()
  .catch(error => {
    console.error(error)
    startError = error
  })
  .finally(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App startError={startError} />
      </StrictMode>,
    ),
  )
