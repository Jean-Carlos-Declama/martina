import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { isLinked, parseLinkCode, touchDevice, unlinkThisDevice } from './db/cloud';
import { db, getDeviceLocal, getSettings } from './db/database';
import type { User } from './db/types';
import { SessionProvider, UiProvider, useSession, useUi } from './ui/context';
import { Icon, type IconName } from './ui/icons';
import { LinkLanding, SyncBadge } from './ui/screens/Devices';
import { Home } from './ui/screens/Home';
import { Lock, Setup } from './ui/screens/Lock';
import { Lottery } from './ui/screens/Lottery';
import { Sell } from './ui/screens/Sell';

// Las pantallas que se usan menos se cargan cuando se abren (la app arranca más rápido en iPads viejos).
const Products = lazy(() => import('./ui/screens/Products'));
const Clients = lazy(() => import('./ui/screens/Clients'));
const SalesHistory = lazy(() => import('./ui/screens/SalesHistory'));
const Reports = lazy(() => import('./ui/screens/Reports'));
const SettingsScreen = lazy(() => import('./ui/screens/Settings'));

export type Screen = 'home' | 'lottery' | 'sell' | 'products' | 'clients' | 'sales' | 'reports' | 'settings';

/** `seesMoney`: solo la dueña y "solo mirar" (el empleado no ve ganancias); `edits`: no para "solo mirar". */
const NAV: { screen: Screen; label: string; icon: IconName; seesMoney?: boolean; edits?: boolean }[] = [
  { screen: 'home', label: 'Inicio', icon: 'home' },
  { screen: 'lottery', label: 'Lotería', icon: 'ticket' },
  { screen: 'sell', label: 'Vender', icon: 'cart', edits: true },
  { screen: 'products', label: 'Productos', icon: 'box' },
  { screen: 'clients', label: 'Clientes', icon: 'users' },
  { screen: 'sales', label: 'Ventas', icon: 'receipt' },
  { screen: 'reports', label: 'Reportes', icon: 'chart', seesMoney: true },
  { screen: 'settings', label: 'Ajustes', icon: 'gear' },
];

export default function App({ startError }: { startError?: unknown }) {
  const userCount = useLiveQuery(() => db.users.count(), []);
  const settings = useLiveQuery(() => getSettings(), []);
  const [user, setUser] = useState<User | null>(null);
  const [landingCode, setLandingCode] = useState(() => parseLinkCode(location.hash));
  const lock = useCallback(() => setUser(null), []);

  // Pedirle al iPad que no borre los datos de la app aunque le falte espacio.
  useEffect(() => {
    void navigator.storage?.persist?.();
  }, []);

  if (userCount === undefined || !settings) return <div className="splash">Martina</div>;
  const closeLanding = () => {
    history.replaceState(null, '', location.pathname);
    setLandingCode(null);
  };
  return (
    <UiProvider>
      {landingCode && !isLinked() ? (
        <LinkLanding code={landingCode} onDone={closeLanding} />
      ) : user ? (
        <SessionProvider user={user} settings={settings} lock={lock}>
          <Shell />
        </SessionProvider>
      ) : userCount === 0 && isLinked() ? (
        <Downloading error={startError} />
      ) : userCount === 0 ? (
        <Setup onDone={setUser} />
      ) : (
        <Lock onUnlock={setUser} />
      )}
      <UpdateBanner busy={!!user} />
    </UiProvider>
  );
}

/** Equipo recién vinculado que todavía no tiene lo del negocio (sin internet o bajando). */
function Downloading({ error }: { error?: unknown }) {
  return (
    <main className="lock-screen">
      <div className="card lock">
        <h1>Bajando lo del negocio…</h1>
        <SyncBadge />
        {error ? <p className="error-text">{error instanceof Error ? error.message : 'No se pudo conectar.'}</p> : null}
        <p className="muted">Hace falta internet la primera vez. Cuando termine, sale la pantalla para poner el PIN.</p>
        <button className="btn" onClick={() => location.reload()}>
          Intentar otra vez
        </button>
      </div>
    </main>
  );
}

function Shell() {
  const { user, seesMoney, canEdit, settings, lock } = useSession();
  const { toast } = useUi();
  const [screen, setScreen] = useState<Screen>('home');
  // Clientes se abre en "Deben" cuando se llega desde "Pendiente por cobrar" de Inicio; desde el menú, en "Todos".
  const [clientsFilter, setClientsFilter] = useState<'all' | 'debt'>('all');
  const lastActivity = useRef(Date.now());

  // Equipos vinculados: anotar que se usó, y si la dueña lo quitó, borrarse y salir.
  const blocked = useLiveQuery(async () => (isLinked() ? (await db.devices.get((await getDeviceLocal(db)).deviceId))?.blocked === true : false), []);
  useEffect(() => {
    void touchDevice().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!blocked) return;
    toast('La dueña quitó este equipo: se borran los datos de Martina aquí.', 'error');
    const timer = setTimeout(() => void unlinkThisDevice(), 3000);
    return () => clearTimeout(timer);
  }, [blocked, toast]);

  // Se bloquea sola si nadie la toca en un rato (así un cliente no ve ni toca nada).
  useEffect(() => {
    if (!settings.lockMinutes) return;
    const touch = () => (lastActivity.current = Date.now());
    const check = () => {
      if (Date.now() - lastActivity.current > settings.lockMinutes * 60_000) lock();
    };
    const onVisible = () => document.visibilityState === 'visible' && check();
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(check, 15_000);
    return () => {
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [settings.lockMinutes, lock]);

  const nav = NAV.filter(item => (!item.seesMoney || seesMoney) && (!item.edits || canEdit));
  return (
    <div className="shell">
      <nav className="nav" aria-label="Menú">
        <div className="nav-brand">
          {settings.businessName}
          <SyncBadge />
        </div>
        {nav.map(item => (
          <button
            key={item.screen}
            className={screen === item.screen ? 'on' : ''}
            aria-current={screen === item.screen ? 'page' : undefined}
            onClick={() => {
              setClientsFilter('all');
              setScreen(item.screen);
            }}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
        <button className="nav-lock" onClick={lock} title={`Bloquear (${user.name})`}>
          <Icon name="lock" />
          <span>Bloquear</span>
        </button>
      </nav>
      <main className="content">
        <Suspense fallback={<p className="muted center">Cargando…</p>}>
          {screen === 'home' && (
            <Home
              go={setScreen}
              goDebts={() => {
                setClientsFilter('debt');
                setScreen('clients');
              }}
            />
          )}
          {screen === 'lottery' && <Lottery />}
          {screen === 'sell' && canEdit && <Sell />}
          {screen === 'products' && <Products />}
          {screen === 'clients' && <Clients key={clientsFilter} initialFilter={clientsFilter} />}
          {screen === 'sales' && <SalesHistory />}
          {screen === 'reports' && seesMoney && <Reports />}
          {screen === 'settings' && <SettingsScreen />}
        </Suspense>
      </main>
    </div>
  );
}

/**
 * Versión nueva de la app: si no hay nadie adentro (pantalla del PIN o la bienvenida) se instala sola; si alguien
 * está trabajando, avisa arriba y se instala cuando toca el botón (así nunca se recarga a mitad de una venta).
 */
function UpdateBanner({ busy }: { busy: boolean }) {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // Buscar versión nueva al abrir, al volver a la app y cada hora.
      void registration.update();
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void registration.update());
      setInterval(() => void registration.update(), 60 * 60 * 1000);
    },
  });
  useEffect(() => {
    if (needRefresh && !busy) void updateServiceWorker(true);
  }, [needRefresh, busy, updateServiceWorker]);
  if (!needRefresh) return null;
  return (
    <div className="update-banner" role="status">
      <span>Hay una versión nueva de Martina.</span>
      <button className="btn primary small" onClick={() => void updateServiceWorker(true)}>
        Actualizar ahora
      </button>
    </div>
  );
}
