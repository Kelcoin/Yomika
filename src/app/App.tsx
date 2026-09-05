import { AppShell } from '../components/AppShell';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
  const { pathname } = useLocation();
  useEffect(() => {
    const updateLifecycle = () => {
      if (document.visibilityState === 'hidden') stopTagTranslationUpdates();
      else startTagTranslationUpdates();
    };
    updateLifecycle();
    document.addEventListener('visibilitychange', updateLifecycle);
    return () => {
      document.removeEventListener('visibilitychange', updateLifecycle);
      stopTagTranslationUpdates();
    };
  }, []);
  return (
    <PreferencesProvider>
      <StartupRoute />
      <ToastProvider>
        {pathname.startsWith('/reader/') ? <ReaderRoutes /> : <AppShell><WorkspaceRoutes /></AppShell>}
      </ToastProvider>
    </PreferencesProvider>
  );
}
