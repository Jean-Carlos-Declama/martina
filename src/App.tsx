import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { db, getSettings } from './db/database';
import type { User } from './db/types';
import { SessionProvider, UiProvider, useSession } from './ui/context';
import { Icon, type IconName } from './ui/icons';
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

const NAV: { screen: Screen; label: string; icon: IconName; ownerOnly?: boolean }[] = [
  { screen: 'home', label: 'Inicio', icon: 'home' },
  { screen: 'lottery', label: 'Lotería', icon: 'ticket' },
  { screen: 'sell', label: 'Vender', icon: 'cart' },
  { screen: 'products', label: 'Productos', icon: 'box' },
  { screen: 'clients', label: 'Clientes', icon: 'users' },
  { screen: 'sales', label: 'Ventas', icon: 'receipt' },
  { screen: 'reports', label: 'Reportes', icon: 'chart', ownerOnly: true },
  { screen: 'settings', label: 'Ajustes', icon: 'gear' },
];

export default function App() {
  const userCount = useLiveQuery(() => db.users.count(), []);
  const settings = useLiveQuery(() => getSettings(), []);
  const [user, setUser] = useState<User | null>(null);
  const lock = useCallback(() => setUser(null), []);

  // Pedirle al iPad que no borre los datos de la app aunque le falte espacio.
  useEffect(() => {
    void navigator.storage?.persist?.();
  }, []);

  if (userCount === undefined || !settings) return <div className="splash">Martina</div>;
  return (
    <UiProvider>
      {user ? (
        <SessionProvider user={user} settings={settings} lock={lock}>
          <Shell />
        </SessionProvider>
      ) : userCount === 0 ? (
        <Setup onDone={setUser} />
      ) : (
        <Lock onUnlock={setUser} />
      )}
      <UpdateBanner />
    </UiProvider>
  );
}

function Shell() {
  const { user, isOwner, settings, lock } = useSession();
  const [screen, setScreen] = useState<Screen>('home');
  const lastActivity = useRef(Date.now());

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

  const nav = NAV.filter(item => !item.ownerOnly || isOwner);
  return (
    <div className="shell">
      <nav className="nav" aria-label="Menú">
        <div className="nav-brand">{settings.businessName}</div>
        {nav.map(item => (
          <button key={item.screen} className={screen === item.screen ? 'on' : ''} aria-current={screen === item.screen ? 'page' : undefined} onClick={() => setScreen(item.screen)}>
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
          {screen === 'home' && <Home go={setScreen} />}
          {screen === 'lottery' && <Lottery />}
          {screen === 'sell' && <Sell />}
          {screen === 'products' && <Products />}
          {screen === 'clients' && <Clients />}
          {screen === 'sales' && <SalesHistory />}
          {screen === 'reports' && isOwner && <Reports />}
          {screen === 'settings' && <SettingsScreen />}
        </Suspense>
      </main>
    </div>
  );
}

/** Cuando hay una versión nueva de la app, avisa; se instala cuando ella toca el botón (no a mitad de una venta). */
function UpdateBanner() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Buscar versión nueva cada hora (además de cada vez que se abre la app).
      if (registration) setInterval(() => void registration.update(), 60 * 60 * 1000);
    },
  });
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
