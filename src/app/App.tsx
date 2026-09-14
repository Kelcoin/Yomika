import { RetainedPage } from './RetainedPage';
import { AppShell } from '../components/AppShell';
import { useEffect, useRef } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ReaderRoutes, WorkspaceRoutes } from './routes';
import { PreferencesProvider, usePreferences } from './preferences';
import { startTagTranslationUpdates, stopTagTranslationUpdates } from '../lib/tagTranslationService';
import { ToastProvider } from '../components/Toast';

/** Applies the 启动时打开 preference, once, and only while the app is still on
 * the route it launched at — a later visit to the home page is the user's own
 * navigation and must not be hijacked. */
function StartupRoute() {
  const { preferences, loading } = usePreferences();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const applied = useRef(false);
  useEffect(() => {
    if (loading || applied.current) return;
    applied.current = true;
    if (preferences.startupRoute === 'library' && pathname === '/') navigate('/library', { replace: true });
  }, [loading, navigate, pathname, preferences.startupRoute]);
  return null;
}

export function App() {
  const location = useLocation();
  const { pathname } = location;
  const reading = pathname.startsWith('/reader/');
  const workspaceLocation = useRef<typeof location | undefined>(reading ? undefined : location);
  if (!reading) workspaceLocation.current = location;
  const readers = useRef(new Map<string, typeof location>());
  const readerParams = new URLSearchParams(location.search);
  const readerKey = `${pathname}:${readerParams.get('server') ?? ''}:${readerParams.get('incognito') ?? ''}`;
  if (reading) readers.current.set(readerKey, location);
  useEffect(() => {
    const suppressNativeMenu = (event: Event) => event.preventDefault();
    document.addEventListener('contextmenu', suppressNativeMenu);
    const updateLifecycle = () => {
      if (document.visibilityState === 'hidden') stopTagTranslationUpdates();
      else startTagTranslationUpdates();
    };
    updateLifecycle();
    document.addEventListener('visibilitychange', updateLifecycle);
    return () => {
      document.removeEventListener('contextmenu', suppressNativeMenu);
      document.removeEventListener('visibilitychange', updateLifecycle);
      stopTagTranslationUpdates();
    };
  }, []);
  return (
    <PreferencesProvider>
      <StartupRoute />
      <ToastProvider>
        {workspaceLocation.current && <RetainedPage active={!reading}>
          <Routes location={workspaceLocation.current}><Route path="*" element={<AppShell><WorkspaceRoutes /></AppShell>} /></Routes>
        </RetainedPage>}
        {[...readers.current].map(([key, saved]) => <RetainedPage key={key} active={reading && readerKey === key}>
          <Routes location={saved}><Route path="*" element={<ReaderRoutes />} /></Routes>
        </RetainedPage>)}
      </ToastProvider>
    </PreferencesProvider>
  );
}
